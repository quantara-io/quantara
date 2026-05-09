import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlendedSignal } from "@quantara/shared";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  UpdateCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Update", input })),
}));

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_SIGNALS_V2 = "test-signals-v2";
});

function makeSignal(overrides: Partial<BlendedSignal> = {}): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "buy",
    confidence: 0.72,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: ["ema_cross_bullish", "rsi_oversold"],
    perTimeframe: {
      "15m": {
        type: "buy",
        confidence: 0.7,
        rulesFired: ["ema_cross_bullish"],
        bullishScore: 3,
        bearishScore: 0,
        volatilityFlag: false,
        gateReason: null,
        asOf: 1700000000000,
      },
      "1h": null,
      "4h": null,
      "1d": null,
      "1m": null,
      "5m": null,
    },
    weightsUsed: {
      "15m": 0.25,
      "1h": 0.3,
      "4h": 0.25,
      "1d": 0.2,
      "1m": 0,
      "5m": 0,
    },
    asOf: 1700000000000,
    emittingTimeframe: "15m",
    risk: null,
    ...overrides,
  };
}

describe("putSignal", () => {
  it("writes a PutCommand with pair as PK and v6 deterministic sk = `tf#closeTime`", async () => {
    send.mockResolvedValue({});
    const signal = makeSignal();
    const { putSignal } = await import("./signal-store.js");
    const { signalId, emittedAt, sk } = await putSignal(signal);

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Put");
    expect(cmd.input.TableName).toBe("test-signals-v2");

    const item = cmd.input.Item;
    expect(item.pair).toBe("BTC/USDT");
    expect(item.type).toBe("buy");
    expect(item.signalId).toBe(signalId);
    expect(item.emittedAt).toBe(emittedAt);
    // v6 deterministic SK = tf#closeTime, where closeTime = signal.asOf
    expect(item.sk).toBe(`15m#${signal.asOf}`);
    expect(sk).toBe(`15m#${signal.asOf}`);
    expect(item.confidence).toBe(0.72);
    expect(item.volatilityFlag).toBe(false);
    expect(item.gateReason).toBeNull();
    expect(item.rulesFired).toEqual(["ema_cross_bullish", "rsi_oversold"]);
    expect(item.asOf).toBe(1700000000000);
    expect(item.emittingTimeframe).toBe("15m");
  });

  it("sets a 90-day TTL", async () => {
    send.mockResolvedValue({});
    const { putSignal } = await import("./signal-store.js");
    await putSignal(makeSignal());
    const item = send.mock.calls[0][0].input.Item;
    const nowSec = Math.floor(Date.now() / 1000);
    expect(item.ttl).toBeGreaterThanOrEqual(nowSec + 86400 * 90 - 5);
    expect(item.ttl).toBeLessThanOrEqual(nowSec + 86400 * 90 + 5);
  });

  it("derives emittedAt ISO8601 from signal.asOf", async () => {
    send.mockResolvedValue({});
    const signal = makeSignal({ asOf: 1700000000000 });
    const { putSignal } = await import("./signal-store.js");
    const { emittedAt } = await putSignal(signal);
    expect(emittedAt).toBe(new Date(1700000000000).toISOString());
  });

  it("returns signalId and emittedAt without mutating the input", async () => {
    send.mockResolvedValue({});
    const signal = makeSignal();
    const originalPair = signal.pair;
    const originalAsOf = signal.asOf;
    const { putSignal } = await import("./signal-store.js");
    const result = await putSignal(signal);
    expect(result.signalId).toMatch(/^[0-9a-f]+-/);
    expect(result.emittedAt).toBeTruthy();
    // Input must be unchanged
    expect(signal.pair).toBe(originalPair);
    expect(signal.asOf).toBe(originalAsOf);
  });

  it("stores perTimeframe and weightsUsed maps", async () => {
    send.mockResolvedValue({});
    const signal = makeSignal();
    const { putSignal } = await import("./signal-store.js");
    await putSignal(signal);
    const item = send.mock.calls[0][0].input.Item;
    expect(item.perTimeframe).toEqual(signal.perTimeframe);
    expect(item.weightsUsed).toEqual(signal.weightsUsed);
  });

  it("persists risk: null when no risk recommendation", async () => {
    send.mockResolvedValue({});
    const signal = makeSignal({ risk: null });
    const { putSignal } = await import("./signal-store.js");
    await putSignal(signal);
    const item = send.mock.calls[0][0].input.Item;
    expect(item.risk).toBeNull();
  });

  it("persists a RiskRecommendation when present", async () => {
    send.mockResolvedValue({});
    const riskRec = {
      pair: "BTC/USDT",
      profile: "moderate" as const,
      positionSizePct: 0.5,
      positionSizeModel: "vol-targeted" as const,
      stopLoss: 45000,
      stopDistance: 1000,
      takeProfit: [
        { price: 46000, closePct: 0.5, rMultiple: 1 },
        { price: 47000, closePct: 0.25, rMultiple: 2 },
        { price: 50000, closePct: 0.25, rMultiple: 5 },
      ],
      invalidationCondition: "Setup invalid if BTC/USDT crosses below $45000.00",
      trailingStopAfterTP2: { multiplier: 2, reference: "ATR" as const },
    };
    const signal = makeSignal({ risk: riskRec });
    const { putSignal } = await import("./signal-store.js");
    await putSignal(signal);
    const item = send.mock.calls[0][0].input.Item;
    expect(item.risk).toEqual(riskRec);
  });
});

describe("getLatestSignal", () => {
  it("queries pair PK descending with Limit 1 and returns reconstructed BlendedSignal", async () => {
    const signal = makeSignal();
    const emittedAt = new Date(signal.asOf).toISOString();
    const signalId = "00000000abcd-some-uuid";
    const storedItem = {
      pair: signal.pair,
      sk: `15m#1700000000000`,
      signalId,
      emittedAt,
      type: signal.type,
      confidence: signal.confidence,
      volatilityFlag: signal.volatilityFlag,
      gateReason: signal.gateReason,
      rulesFired: signal.rulesFired,
      perTimeframe: signal.perTimeframe,
      weightsUsed: signal.weightsUsed,
      asOf: signal.asOf,
      emittingTimeframe: signal.emittingTimeframe,
      risk: signal.risk,
      ttl: Math.floor(Date.now() / 1000) + 86400 * 90,
    };
    send.mockResolvedValue({ Items: [storedItem] });

    const { getLatestSignal } = await import("./signal-store.js");
    const result = await getLatestSignal("BTC/USDT");

    // v6: getLatestSignal → getRecentSignals(1) issues 4 per-TF queries.
    expect(send).toHaveBeenCalledTimes(4);
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Query");
    expect(cmd.input.ScanIndexForward).toBe(false);
    expect(cmd.input.Limit).toBe(1);
    expect(cmd.input.ExpressionAttributeValues[":pair"]).toBe("BTC/USDT");
    // Each call targets a distinct blended TF prefix.
    const tfPrefixes = send.mock.calls.map(
      (c: any) => c[0].input.ExpressionAttributeValues[":tfPrefix"],
    );
    expect(new Set(tfPrefixes)).toEqual(new Set(["15m#", "1h#", "4h#", "1d#"]));
    expect(cmd.input.TableName).toBe("test-signals-v2");

    // Round-trip
    expect(result).not.toBeNull();
    expect(result!.pair).toBe(signal.pair);
    expect(result!.type).toBe(signal.type);
    expect(result!.confidence).toBe(signal.confidence);
    expect(result!.rulesFired).toEqual(signal.rulesFired);
    expect(result!.perTimeframe).toEqual(signal.perTimeframe);
    expect(result!.asOf).toBe(signal.asOf);
    expect(result!.signalId).toBe(signalId);
    expect(result!.emittedAt).toBe(emittedAt);
    expect(result!.risk).toBeNull();
  });

  it("returns null when no signals exist", async () => {
    send.mockResolvedValue({ Items: [] });
    const { getLatestSignal } = await import("./signal-store.js");
    expect(await getLatestSignal("BTC/USDT")).toBeNull();
  });

  it("returns null when DynamoDB returns undefined Items", async () => {
    send.mockResolvedValue({});
    const { getLatestSignal } = await import("./signal-store.js");
    expect(await getLatestSignal("BTC/USDT")).toBeNull();
  });
});

describe("getRecentSignals", () => {
  it("passes the limit parameter to DynamoDB", async () => {
    send.mockResolvedValue({ Items: [] });
    const { getRecentSignals } = await import("./signal-store.js");
    await getRecentSignals("BTC/USDT", 5);
    expect(send.mock.calls[0][0].input.Limit).toBe(5);
  });

  it("defaults to limit=10", async () => {
    send.mockResolvedValue({ Items: [] });
    const { getRecentSignals } = await import("./signal-store.js");
    await getRecentSignals("BTC/USDT");
    expect(send.mock.calls[0][0].input.Limit).toBe(10);
  });

  it("returns multiple results merged across TFs in descending asOf order", async () => {
    const signal1 = makeSignal({ asOf: 1700000060000, type: "buy", emittingTimeframe: "15m" });
    const signal2 = makeSignal({ asOf: 1700000000000, type: "sell", emittingTimeframe: "1h" });
    const emittedAt1 = new Date(signal1.asOf).toISOString();
    const emittedAt2 = new Date(signal2.asOf).toISOString();
    send.mockImplementation((cmd: any) => {
      const tfPrefix = cmd.input.ExpressionAttributeValues?.[":tfPrefix"];
      if (tfPrefix === "15m#") {
        return Promise.resolve({
          Items: [
            {
              pair: signal1.pair,
              sk: `15m#${signal1.asOf}`,
              signalId: "id-1",
              emittedAt: emittedAt1,
              type: signal1.type,
              confidence: signal1.confidence,
              volatilityFlag: signal1.volatilityFlag,
              gateReason: signal1.gateReason,
              rulesFired: signal1.rulesFired,
              perTimeframe: signal1.perTimeframe,
              weightsUsed: signal1.weightsUsed,
              asOf: signal1.asOf,
              emittingTimeframe: signal1.emittingTimeframe,
            },
          ],
        });
      }
      if (tfPrefix === "1h#") {
        return Promise.resolve({
          Items: [
            {
              pair: signal2.pair,
              sk: `1h#${signal2.asOf}`,
              signalId: "id-2",
              emittedAt: emittedAt2,
              type: signal2.type,
              confidence: signal2.confidence,
              volatilityFlag: signal2.volatilityFlag,
              gateReason: signal2.gateReason,
              rulesFired: signal2.rulesFired,
              perTimeframe: signal2.perTimeframe,
              weightsUsed: signal2.weightsUsed,
              asOf: signal2.asOf,
              emittingTimeframe: signal2.emittingTimeframe,
            },
          ],
        });
      }
      return Promise.resolve({ Items: [] });
    });
    const { getRecentSignals } = await import("./signal-store.js");
    const results = await getRecentSignals("BTC/USDT", 2);
    expect(results).toHaveLength(2);
    // signal1.asOf (1700000060000) > signal2.asOf (1700000000000), so buy (15m) comes first.
    expect(results[0].type).toBe("buy");
    expect(results[1].type).toBe("sell");
  });

  it("returns empty array when no signals exist", async () => {
    send.mockResolvedValue({ Items: [] });
    const { getRecentSignals } = await import("./signal-store.js");
    expect(await getRecentSignals("BTC/USDT")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 6b helpers
// ---------------------------------------------------------------------------

describe("findActiveSignalsForPair", () => {
  it("returns only signals whose TTL is in the future and not yet invalidated", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // findActiveSignalsForPair queries each blended TF (15m/1h/4h/1d) separately;
    // return the test fixtures only on the 1h branch and empty on others.
    send.mockImplementation((cmd: any) => {
      const tfPrefix = cmd.input.ExpressionAttributeValues?.[":tfPrefix"];
      if (tfPrefix !== "1h#") return Promise.resolve({ Items: [] });
      return Promise.resolve({
        Items: [
          // active, not invalidated
          {
            pair: "ETH",
            sk: "1h#17040672000001",
            signalId: "sig-1",
            emittedAt: "2024-01-01T00:00:00.000Z",
            ttl: nowSec + 86400,
            invalidatedAt: null,
          },
          // expired TTL — should be filtered out
          {
            pair: "ETH",
            sk: "1h#17040672000002",
            signalId: "sig-2",
            emittedAt: "2024-01-01T00:00:00.000Z",
            ttl: nowSec - 1,
            invalidatedAt: null,
          },
          // already invalidated — should be filtered out
          {
            pair: "ETH",
            sk: "1h#17040672000003",
            signalId: "sig-3",
            emittedAt: "2024-01-01T00:00:00.000Z",
            ttl: nowSec + 86400,
            invalidatedAt: "2024-01-02T00:00:00.000Z",
          },
        ],
      });
    });

    const { findActiveSignalsForPair } = await import("./signal-store.js");
    const results = await findActiveSignalsForPair("ETH");

    expect(results).toHaveLength(1);
    expect(results[0].signalId).toBe("sig-1");
  });

  it("returns empty array when no signals match", async () => {
    send.mockResolvedValue({ Items: [] });
    const { findActiveSignalsForPair } = await import("./signal-store.js");
    expect(await findActiveSignalsForPair("BTC")).toEqual([]);
  });

  it("passes pair as KeyConditionExpression value and limits to 100", async () => {
    send.mockResolvedValue({ Items: [] });
    const { findActiveSignalsForPair } = await import("./signal-store.js");
    await findActiveSignalsForPair("SOL");
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Query");
    expect(cmd.input.ExpressionAttributeValues[":pair"]).toBe("SOL");
    expect(cmd.input.Limit).toBe(100);
    expect(cmd.input.ScanIndexForward).toBe(false);
  });
});

describe("markSignalInvalidated", () => {
  it("sends an UpdateCommand with condition expression to the correct key", async () => {
    send.mockResolvedValue({});
    const { markSignalInvalidated } = await import("./signal-store.js");
    await markSignalInvalidated("ETH", "1h#1704067200000", "Breaking news: test headline");

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Update");
    expect(cmd.input.TableName).toBe("test-signals-v2");
    expect(cmd.input.Key).toEqual({
      pair: "ETH",
      sk: "1h#1704067200000",
    });
    expect(cmd.input.UpdateExpression).toContain("invalidatedAt");
    expect(cmd.input.UpdateExpression).toContain("invalidationReason");
    expect(cmd.input.ConditionExpression).toContain("attribute_not_exists(invalidatedAt)");
    expect(cmd.input.ExpressionAttributeValues[":reason"]).toBe("Breaking news: test headline");
  });

  it("uses the injected nowIso timestamp", async () => {
    send.mockResolvedValue({});
    const { markSignalInvalidated } = await import("./signal-store.js");
    const fixedIso = "2024-06-01T12:00:00.000Z";
    await markSignalInvalidated("ETH", "1h#1704067200000", "reason", fixedIso);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.ExpressionAttributeValues[":ts"]).toBe(fixedIso);
  });

  it("is idempotent: swallows ConditionalCheckFailedException", async () => {
    const conditionalError = Object.assign(new Error("conditional check failed"), {
      name: "ConditionalCheckFailedException",
    });
    send.mockRejectedValueOnce(conditionalError);
    const { markSignalInvalidated } = await import("./signal-store.js");
    // Must not throw
    await expect(
      markSignalInvalidated("ETH", "1h#1704067200000", "Breaking news: test"),
    ).resolves.toBeUndefined();
  });

  it("re-throws unexpected DDB errors", async () => {
    const networkError = new Error("network failure");
    send.mockRejectedValueOnce(networkError);
    const { markSignalInvalidated } = await import("./signal-store.js");
    await expect(
      markSignalInvalidated("ETH", "1h#1704067200000", "Breaking news: test"),
    ).rejects.toThrow("network failure");
  });
});
