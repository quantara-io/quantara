/**
 * Tests for backtest routes in admin.ts.
 *
 * Tests GET /backtest/strategies, POST /backtest, GET /backtest, GET /backtest/:runId.
 * Uses vi.mock to stub the store helpers and avoid real DynamoDB/SQS calls.
 *
 * Issue #371.
 */
import { Hono } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock store + strategies before any import of the route file
// ---------------------------------------------------------------------------

const putRunMock = vi.fn();
const getRawRunMock = vi.fn();
const listRunsMock = vi.fn();
const getRunDetailMock = vi.fn();

vi.mock("./backtest-runs-store.js", () => ({
  putRun: putRunMock,
  getRun: getRawRunMock,
  listRuns: listRunsMock,
  getRunDetail: getRunDetailMock,
}));

vi.mock("./backtest-strategies.js", () => ({
  BACKTEST_STRATEGIES: [
    { name: "production-default", description: "Prod default strategy" },
    { name: "aggressive-1d-weighted", description: "Aggressive strategy" },
  ],
}));

// Stub the shared cost estimator and pipeline-events writers so the tests
// don't hit DDB. The submission path is what we want to exercise — the
// estimator math itself is covered by backtest/src/cost/estimator.test.ts.
const estimateBacktestCostMock = vi.fn();
vi.mock("./backtest-cost-estimator.js", () => ({
  estimateBacktestCost: estimateBacktestCostMock,
}));

const emitPipelineEventSafeMock = vi.fn();
vi.mock("./pipeline-events.js", () => ({
  emitPipelineEventSafe: emitPipelineEventSafeMock,
  emitPipelineEvent: vi.fn(),
}));

const streamBacktestArtifactMock = vi.fn();
const isAllowedArtifactNameMock = vi.fn((name: string) =>
  [
    "summary.md",
    "metrics.json",
    "trades.csv",
    "equity-curve.csv",
    "per-rule-attribution.csv",
    "calibration-by-bin.csv",
  ].includes(name),
);
vi.mock("./backtest-artifact-stream.js", () => ({
  streamBacktestArtifact: streamBacktestArtifactMock,
  isAllowedArtifactName: isAllowedArtifactNameMock,
}));

// Stub out all other admin service dependencies.
vi.mock("../services/admin.service.js", () => ({
  getStatus: vi.fn(),
  getMarket: vi.fn(),
  getNews: vi.fn(),
  getNewsUsage: vi.fn(),
  getWhitelist: vi.fn(),
  setWhitelist: vi.fn(),
  getSignals: vi.fn(),
  getGenieMetrics: vi.fn(),
  getRatifications: vi.fn(),
  getPipelineHealth: vi.fn(),
  getActivity: vi.fn(),
  getShadowSignals: vi.fn(),
}));
vi.mock("../services/pipeline-state.service.js", () => ({ getPipelineState: vi.fn() }));
vi.mock("../services/pnl-simulation.service.js", () => ({ getPnlSimulation: vi.fn() }));
vi.mock("../services/genie-deepdive.service.js", () => ({ getGenieDeepDive: vi.fn() }));
vi.mock("../services/admin-debug.service.js", () => ({
  forceRatification: vi.fn(),
  previewNewsEnrichment: vi.fn(),
  reenrichNews: vi.fn(),
  injectSentimentShock: vi.fn(),
  forceIndicators: vi.fn(),
  FORCE_INDICATORS_TIMEFRAMES: ["15m", "1h", "4h", "1d"],
  FORCE_INDICATORS_EXCHANGES: ["binanceus", "coinbase", "kraken"],
}));
vi.mock("../services/rule-status.service.js", () => ({
  listRuleStatuses: vi.fn(),
  setManualOverride: vi.fn(),
}));

let currentAuth: Record<string, unknown> = {
  userId: "user_admin",
  email: "admin@example.com",
  emailVerified: true,
  authMethod: "password",
  sessionId: "sess_admin",
  role: "admin",
};

vi.mock("../middleware/require-auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("auth", currentAuth);
    await next();
  },
}));

beforeEach(() => {
  vi.resetModules();
  putRunMock.mockReset();
  getRawRunMock.mockReset();
  listRunsMock.mockReset();
  getRunDetailMock.mockReset();
  estimateBacktestCostMock.mockReset();
  emitPipelineEventSafeMock.mockReset();
  streamBacktestArtifactMock.mockReset();
  // Default cost estimate: $0 (skip / none ratification modes).
  estimateBacktestCostMock.mockResolvedValue({
    closes: 0,
    gatedRate: 0.004,
    estimatedCalls: 0,
    estimatedTokens: { input: 0, output: 0 },
    estimatedCostUsd: 0,
    estimatedLatencyMs: 0,
    model: "haiku",
    pricingSource: "test",
  });
  currentAuth = {
    userId: "user_admin",
    email: "admin@example.com",
    emailVerified: true,
    authMethod: "password",
    sessionId: "sess_admin",
    role: "admin",
  };
});

async function loadApp(): Promise<Hono> {
  const { admin } = await import("../routes/admin.js");
  return admin;
}

// ---------------------------------------------------------------------------
// GET /backtest/strategies
// ---------------------------------------------------------------------------

describe("GET /backtest/strategies", () => {
  it("returns the in-repo strategy list", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest/strategies");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { strategies: Array<{ name: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.strategies).toHaveLength(2);
    expect(body.data.strategies[0].name).toBe("production-default");
  });
});

// ---------------------------------------------------------------------------
// POST /backtest
// ---------------------------------------------------------------------------

describe("POST /backtest", () => {
  const validBody = {
    strategy: "production-default",
    pair: "BTC/USDT",
    timeframe: "1d",
    from: "2025-01-01T00:00:00Z",
    to: "2025-07-01T00:00:00Z",
    ratificationMode: "none",
  };

  it("returns 400 for unknown strategy", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, strategy: "not-a-strategy" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for unknown pair", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, pair: "FAKE/USD" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when from >= to", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        from: "2025-07-01T00:00:00Z",
        to: "2025-01-01T00:00:00Z",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for unknown ratificationMode", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, ratificationMode: "live-foo" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns COST_CAP_EXCEEDED when replay-bedrock cost > $1 without confirmation", async () => {
    // Force the shared estimator to return a known over-cap value so the test
    // exercises the cap branch deterministically (independent of the
    // underlying math).
    estimateBacktestCostMock.mockResolvedValue({
      closes: 100_000,
      gatedRate: 0.05,
      estimatedCalls: 5_000,
      estimatedTokens: { input: 3_500_000, output: 750_000 },
      estimatedCostUsd: 2.5, // > $1
      estimatedLatencyMs: 15_000_000,
      model: "sonnet",
      pricingSource: "test",
    });
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        ratificationMode: "replay-bedrock",
        from: "2020-01-01T00:00:00Z",
        to: "2025-01-01T00:00:00Z",
        model: "sonnet",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string };
      data?: { totalEstimateUsd: number };
    };
    expect(body.error.code).toBe("COST_CAP_EXCEEDED");
    expect(body.data?.totalEstimateUsd).toBeGreaterThan(1);
  });

  it("accepts replay-bedrock cost > $1 with matching confirmCostUsd bypass (finding 6)", async () => {
    estimateBacktestCostMock.mockResolvedValue({
      closes: 100_000,
      gatedRate: 0.05,
      estimatedCalls: 5_000,
      estimatedTokens: { input: 3_500_000, output: 750_000 },
      estimatedCostUsd: 2.5,
      estimatedLatencyMs: 15_000_000,
      model: "sonnet",
      pricingSource: "test",
    });
    putRunMock.mockResolvedValue({ runId: "rid-bypass", estimateUsd: 2.5 });
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        ratificationMode: "replay-bedrock",
        model: "sonnet",
        confirmCostUsd: 2.5,
      }),
    });
    expect(res.status).toBe(200);
    expect(putRunMock).toHaveBeenCalledOnce();
  });

  it("enqueues and returns runId + estimateUsd on valid submission", async () => {
    putRunMock.mockResolvedValue({ runId: "20250101000000-abc-uuid", estimateUsd: 0 });
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { runId: string; estimateUsd: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.runId).toBe("20250101000000-abc-uuid");
    expect(body.data.estimateUsd).toBe(0);
    expect(putRunMock).toHaveBeenCalledOnce();
    const callArgs = putRunMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.strategy).toBe("production-default");
    expect(callArgs.userId).toBe("user_admin");
  });

  it("accepts baseline as optional field", async () => {
    putRunMock.mockResolvedValue({ runId: "runid-2", estimateUsd: 0 });
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, baseline: "aggressive-1d-weighted" }),
    });
    expect(res.status).toBe(200);
    const callArgs = putRunMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.baseline).toBe("aggressive-1d-weighted");
  });

  it("emits backtest-queued pipeline event after successful enqueue (finding 3)", async () => {
    putRunMock.mockResolvedValue({ runId: "evt-rid", estimateUsd: 0 });
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect(emitPipelineEventSafeMock).toHaveBeenCalledOnce();
    const event = emitPipelineEventSafeMock.mock.calls[0][0] as { type: string; runId: string };
    expect(event.type).toBe("backtest-queued");
    expect(event.runId).toBe("evt-rid");
  });

  it("expands pairs × timeframes cross-product to one run per leaf (finding 5)", async () => {
    putRunMock
      .mockResolvedValueOnce({ runId: "rid-1", estimateUsd: 0 })
      .mockResolvedValueOnce({ runId: "rid-2", estimateUsd: 0 })
      .mockResolvedValueOnce({ runId: "rid-3", estimateUsd: 0 })
      .mockResolvedValueOnce({ runId: "rid-4", estimateUsd: 0 });
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        pair: undefined,
        timeframe: undefined,
        pairs: ["BTC/USDT", "ETH/USDT"],
        timeframes: ["15m", "1h"],
      }),
    });
    expect(res.status).toBe(200);
    expect(putRunMock).toHaveBeenCalledTimes(4);
    expect(emitPipelineEventSafeMock).toHaveBeenCalledTimes(4);
    const body = (await res.json()) as {
      success: boolean;
      data: { runs: Array<{ runId: string; pair: string; timeframe: string }> };
    };
    expect(body.data.runs).toHaveLength(4);
    const combos = body.data.runs.map((r) => `${r.pair}|${r.timeframe}`);
    expect(combos).toEqual(
      expect.arrayContaining(["BTC/USDT|15m", "BTC/USDT|1h", "ETH/USDT|15m", "ETH/USDT|1h"]),
    );
  });

  it("rejects pairs arrays containing unknown pairs", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        pair: undefined,
        pairs: ["BTC/USDT", "FAKE/USD"],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// POST /backtest/estimate — Phase 4 finding 2.
// ---------------------------------------------------------------------------

describe("POST /backtest/estimate", () => {
  it("returns the shared estimator result", async () => {
    estimateBacktestCostMock.mockResolvedValue({
      closes: 1234,
      gatedRate: 0.01,
      estimatedCalls: 12,
      estimatedTokens: { input: 8400, output: 1800 },
      estimatedCostUsd: 0.07,
      estimatedLatencyMs: 36000,
      model: "haiku",
      pricingSource: "test",
    });
    const app = await loadApp();
    const res = await app.request("/backtest/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pair: "BTC/USDT",
        timeframe: "1d",
        from: "2025-01-01T00:00:00Z",
        to: "2025-07-01T00:00:00Z",
        ratificationMode: "replay-bedrock",
        model: "haiku",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { estimatedCostUsd: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.estimatedCostUsd).toBeCloseTo(0.07, 5);
    expect(estimateBacktestCostMock).toHaveBeenCalledOnce();
  });

  it("rejects unknown pair", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pair: "FAKE/USD",
        timeframe: "1d",
        from: "2025-01-01T00:00:00Z",
        to: "2025-07-01T00:00:00Z",
        ratificationMode: "none",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /backtest/:runId/artifact/:name — Phase 4 finding 4.
// ---------------------------------------------------------------------------

describe("GET /backtest/:runId/artifact/:name", () => {
  it("rejects artifact names not in the allow-list", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest/some-run/artifact/../../etc/passwd");
    // hono will resolve the param literally; the route checks isAllowedArtifactName.
    expect([400, 404]).toContain(res.status);
  });

  it("returns 404 when the run does not exist", async () => {
    getRunDetailMock.mockResolvedValue(null);
    const app = await loadApp();
    const res = await app.request("/backtest/missing-run/artifact/metrics.json");
    expect(res.status).toBe(404);
  });

  it("streams the artifact when it exists", async () => {
    getRunDetailMock.mockResolvedValue({
      runId: "rid-art",
      status: "done",
      s3ResultPrefix: "rid-art/",
    });
    streamBacktestArtifactMock.mockResolvedValue({
      body: '{"sharpe":1.23}',
      contentType: "application/json; charset=utf-8",
      contentLength: 15,
    });
    const app = await loadApp();
    const res = await app.request("/backtest/rid-art/artifact/metrics.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const text = await res.text();
    expect(text).toContain("sharpe");
  });
});

// ---------------------------------------------------------------------------
// GET /backtest
// ---------------------------------------------------------------------------

describe("GET /backtest", () => {
  it("returns paginated list from store", async () => {
    const mockItems = [
      {
        runId: "runid-1",
        status: "done",
        strategy: "production-default",
        pair: "BTC/USDT",
        timeframe: "1d",
        from: "2025-01-01T00:00:00Z",
        to: "2025-07-01T00:00:00Z",
        submittedAt: "2026-01-01T00:00:00Z",
        estimatedCostUsd: 0,
      },
    ];
    listRunsMock.mockResolvedValue({ items: mockItems, nextCursor: null });
    const app = await loadApp();
    const res = await app.request("/backtest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { items: unknown[]; nextCursor: null };
    };
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.nextCursor).toBeNull();
  });

  it("passes limit + cursor to the store", async () => {
    listRunsMock.mockResolvedValue({ items: [], nextCursor: null });
    const app = await loadApp();
    const res = await app.request("/backtest?limit=5&cursor=abc123");
    expect(res.status).toBe(200);
    expect(listRunsMock).toHaveBeenCalledWith({ limit: 5, cursor: "abc123" });
  });

  it("returns 400 for invalid limit", async () => {
    const app = await loadApp();
    const res = await app.request("/backtest?limit=999");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /backtest/:runId
// ---------------------------------------------------------------------------

describe("GET /backtest/:runId", () => {
  it("returns 404 when run not found", async () => {
    getRunDetailMock.mockResolvedValue(null);
    const app = await loadApp();
    const res = await app.request("/backtest/nonexistent-run");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns run detail on success", async () => {
    const mockDetail = {
      runId: "runid-1",
      status: "done",
      strategy: "production-default",
      pair: "BTC/USDT",
      timeframe: "1d",
      from: "2025-01-01T00:00:00Z",
      to: "2025-07-01T00:00:00Z",
      submittedAt: "2026-01-01T00:00:00Z",
      estimatedCostUsd: 0,
      listPartition: "ALL",
      userId: "user_admin",
      ratificationMode: "none",
      ttl: 1234567890,
      artifactKeys: {
        summaryMd: "runid-1/summary.md",
        metricsJson: "runid-1/metrics.json",
        tradesCsv: "runid-1/trades.csv",
        equityCurveCsv: "runid-1/equity-curve.csv",
        perRuleAttributionCsv: "runid-1/per-rule-attribution.csv",
        calibrationByBinCsv: "runid-1/calibration-by-bin.csv",
      },
    };
    getRunDetailMock.mockResolvedValue(mockDetail);
    const app = await loadApp();
    const res = await app.request("/backtest/runid-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { runId: string } };
    expect(body.success).toBe(true);
    expect(body.data.runId).toBe("runid-1");
  });
});
