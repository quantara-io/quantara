/**
 * Tests for the Fargate runner loop — Phase 4 finding 1.
 *
 * Covers:
 *   - The runner-shape SQS message flows through handleJob() and produces
 *     status updates + the full set of pipeline events.
 *   - Errors thrown by the engine produce status=failed + backtest-failed.
 *   - The poll loop deletes messages whether the job succeeded or failed.
 *
 * Uses vi.mock at the module boundary for every external dependency so the
 * test never touches real AWS or the engine internals.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ddbSendMock = vi.fn();
const sqsSendMock = vi.fn();
const s3SendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: ddbSendMock })),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({ send: ddbSendMock })),
  },
  PutCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: "Put", input })),
  UpdateCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: "Update", input })),
}));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sqsSendMock })),
  ReceiveMessageCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: "Receive",
    input,
  })),
  DeleteMessageCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: "Delete",
    input,
  })),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3SendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ __type: "S3Put", input })),
}));

// Engine + heavy deps — stub them so handleJob completes synchronously.
const engineRunMock = vi.fn();
vi.mock("../engine.js", () => ({
  BacktestEngine: vi.fn().mockImplementation(() => ({ run: engineRunMock })),
}));
vi.mock("../store/ddb-candle-store.js", () => ({
  DdbCandleStore: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../ratification/ratifier.js", () => ({
  BedrockInvokerImpl: vi.fn(),
  DdbRatificationsLookup: vi.fn(),
}));
vi.mock("../strategies-registry.js", () => ({
  getStrategy: vi.fn((name: string) => {
    if (name === "production-default") {
      return {
        name: "production-default",
        description: "stub",
        exitPolicy: { kind: "n-bars", nBars: 4 },
        sizing: { kind: "fixed-pct", pct: 0.01 },
      };
    }
    return undefined;
  }),
}));

vi.mock("../equity/simulator.js", () => ({
  simulateEquityCurve: vi.fn().mockReturnValue({
    points: [{ ts: "2025-01-01", equity: 1.0, drawdownPct: 0, signalsToDate: 0, winsToDate: 0 }],
    finalEquity: 1.05,
    maxDrawdownPct: 0.02,
    sharpeAnnualized: 1.5,
  }),
  extractDrawdownPeriods: vi.fn().mockReturnValue([]),
}));
vi.mock("../attribution/compute.js", () => ({
  computeRuleAttribution: vi.fn().mockReturnValue([]),
}));
vi.mock("../calibration/bins.js", () => ({
  computeCalibrationBins: vi.fn().mockReturnValue([]),
}));
vi.mock("../output/csv.js", () => ({
  equityCurveToCsv: vi.fn().mockReturnValue("ts,equity\n"),
  ruleAttributionToCsv: vi.fn().mockReturnValue("rule,fireCount\n"),
  calibrationBinsToCsv: vi.fn().mockReturnValue("bin_min,bin_max\n"),
}));
vi.mock("../report/markdown.js", () => ({
  generateMarkdownReport: vi.fn().mockReturnValue("# report"),
}));

beforeEach(() => {
  vi.resetModules();
  ddbSendMock.mockReset();
  sqsSendMock.mockReset();
  s3SendMock.mockReset();
  engineRunMock.mockReset();
  ddbSendMock.mockResolvedValue({});
  s3SendMock.mockResolvedValue({});
  sqsSendMock.mockResolvedValue({});
});

const jobMessage = {
  runId: "20260101-test-runid",
  strategy: "production-default",
  pair: "BTC/USDT",
  timeframe: "1d",
  from: "2025-01-01T00:00:00Z",
  to: "2025-07-01T00:00:00Z",
  ratificationMode: "none" as const,
  s3ResultPrefix: "20260101-test-runid/",
};

const engineResult = {
  signals: [],
  metrics: {
    totalSignals: 0,
    byType: {},
    byOutcome: { correct: 0, incorrect: 0, neutral: 0, unresolved: 0 },
    brierScore: null,
    winRate: null,
    meanReturnPct: null,
  },
  meta: {
    startedAt: "2025-01-01T00:00:00Z",
    durationMs: 100,
    candleCount: 0,
    pair: "BTC/USDT",
    timeframe: "1d" as const,
    from: "2025-01-01T00:00:00Z",
    to: "2025-07-01T00:00:00Z",
    skippedNoConsensus: 0,
    actualCostUsd: 0.0,
  },
};

// ---------------------------------------------------------------------------
// handleJob
// ---------------------------------------------------------------------------

describe("handleJob", () => {
  it("transitions queued → running → done with all S3 artifacts and pipeline events", async () => {
    engineRunMock.mockResolvedValueOnce(engineResult);
    const { handleJob } = await import("./main.js");
    await handleJob(jobMessage);

    // DDB Update calls: 1 running + 1 done = 2 status mutations
    const updateCommands = ddbSendMock.mock.calls
      .map((c) => c[0] as { __type?: string; input?: { UpdateExpression?: string } })
      .filter((c) => c.__type === "Update");
    expect(updateCommands.length).toBeGreaterThanOrEqual(2);
    expect(updateCommands[0]!.input!.UpdateExpression).toContain("startedAt");
    expect(updateCommands[updateCommands.length - 1]!.input!.UpdateExpression).toContain(
      "completedAt",
    );

    // DDB Put calls = pipeline events. We expect at least:
    //  - backtest-started
    //  - backtest-progress (0%)
    //  - backtest-progress (100%)
    //  - backtest-completed
    const putEvents = ddbSendMock.mock.calls
      .map((c) => c[0] as { __type?: string; input?: { Item?: { type?: string } } })
      .filter((c) => c.__type === "Put")
      .map((c) => c.input!.Item!.type);
    expect(putEvents).toContain("backtest-started");
    expect(putEvents).toContain("backtest-completed");
    expect(putEvents.filter((t) => t === "backtest-progress").length).toBeGreaterThanOrEqual(2);

    // S3 uploads: 6 artifacts (summary.md, metrics.json, 4 CSVs)
    const s3Puts = s3SendMock.mock.calls.map((c) => c[0] as { __type?: string });
    expect(s3Puts.filter((p) => p.__type === "S3Put").length).toBe(6);
  });

  it("emits backtest-failed + marks DDB row failed when engine throws", async () => {
    engineRunMock.mockRejectedValueOnce(new Error("kaboom"));
    const { handleJob } = await import("./main.js");
    await expect(handleJob(jobMessage)).rejects.toThrow("kaboom");

    const events = ddbSendMock.mock.calls
      .map((c) => c[0] as { __type?: string; input?: { Item?: { type?: string } } })
      .filter((c) => c.__type === "Put")
      .map((c) => c.input!.Item!.type);
    expect(events).toContain("backtest-failed");

    const updates = ddbSendMock.mock.calls
      .map(
        (c) =>
          c[0] as {
            __type?: string;
            input?: { ExpressionAttributeValues?: Record<string, unknown> };
          },
      )
      .filter((c) => c.__type === "Update");
    const failedUpdate = updates.find(
      (u) => u.input!.ExpressionAttributeValues![":s"] === "failed",
    );
    expect(failedUpdate).toBeDefined();
  });

  it("throws on unknown strategy without writing any S3 artifacts", async () => {
    const { handleJob } = await import("./main.js");
    await expect(handleJob({ ...jobMessage, strategy: "does-not-exist" })).rejects.toThrow(
      /unknown strategy/,
    );
    expect(s3SendMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pollAndProcessOnce
// ---------------------------------------------------------------------------

describe("pollAndProcessOnce", () => {
  it("deletes the SQS message after handleJob completes", async () => {
    engineRunMock.mockResolvedValueOnce(engineResult);
    sqsSendMock.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === "Receive") {
        return {
          Messages: [{ Body: JSON.stringify(jobMessage), ReceiptHandle: "rh-1" }],
        };
      }
      return {};
    });

    const { pollAndProcessOnce } = await import("./main.js");
    const had = await pollAndProcessOnce({} as never);
    expect(had).toBe(true);

    const deleted = sqsSendMock.mock.calls
      .map((c) => c[0] as { __type?: string; input?: { ReceiptHandle?: string } })
      .filter((c) => c.__type === "Delete");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.input!.ReceiptHandle).toBe("rh-1");
  });

  it("still deletes the message when handleJob throws (no infinite retry)", async () => {
    engineRunMock.mockRejectedValueOnce(new Error("boom"));
    sqsSendMock.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === "Receive") {
        return {
          Messages: [{ Body: JSON.stringify(jobMessage), ReceiptHandle: "rh-fail" }],
        };
      }
      return {};
    });

    const { pollAndProcessOnce } = await import("./main.js");
    await pollAndProcessOnce({} as never);

    const deleted = sqsSendMock.mock.calls
      .map((c) => c[0] as { __type?: string })
      .filter((c) => c.__type === "Delete");
    expect(deleted).toHaveLength(1);
  });

  it("deletes unparseable SQS bodies without invoking the engine", async () => {
    sqsSendMock.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === "Receive") {
        return {
          Messages: [{ Body: "not-json{", ReceiptHandle: "rh-garbage" }],
        };
      }
      return {};
    });

    const { pollAndProcessOnce } = await import("./main.js");
    await pollAndProcessOnce({} as never);
    expect(engineRunMock).not.toHaveBeenCalled();
    const deleted = sqsSendMock.mock.calls
      .map((c) => c[0] as { __type?: string })
      .filter((c) => c.__type === "Delete");
    expect(deleted).toHaveLength(1);
  });

  it("returns false on empty queue receive", async () => {
    sqsSendMock.mockResolvedValueOnce({ Messages: [] });
    const { pollAndProcessOnce } = await import("./main.js");
    const had = await pollAndProcessOnce({} as never);
    expect(had).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tradesToCsv — confirms the CSV header matches the spec
// ---------------------------------------------------------------------------

describe("tradesToCsv", () => {
  it("emits the documented header even when there are zero signals", async () => {
    const { tradesToCsv } = await import("./main.js");
    const csv = tradesToCsv({ ...engineResult, signals: [] });
    const firstLine = csv.split("\n")[0]!;
    expect(firstLine).toContain("emittedAt");
    expect(firstLine).toContain("pair");
    expect(firstLine).toContain("ratificationStatus");
  });
});
