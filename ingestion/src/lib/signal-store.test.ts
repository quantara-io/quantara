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
      "1h": 0.30,
      "4h": 0.25,
      "1d": 0.20,
      "1m": 0,
      "5m": 0,
    },
    asOf: 1700000000000,
    emittingTimeframe: "15m",
    ...overrides,
  };
}

describe("putSignal", () => {
  it("writes a PutCommand with pair as PK and emittedAtSignalId as SK", async () => {
    send.mockResolvedValue({});
    const signal = makeSignal();
    const { putSignal } = await import("./signal-store.js");
    const { signalId, emittedAt } = await putSignal(signal);

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Put");
    expect(cmd.input.TableName).toBe("test-signals-v2");

    const item = cmd.input.Item;
    expect(item.pair).toBe("BTC/USDT");
    expect(item.type).toBe("buy");
    expect(item.signalId).toBe(signalId);
    expect(item.emittedAt).toBe(emittedAt);
    expect(item.emittedAtSignalId).toBe(`${emittedAt}#${signalId}`);
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
});

describe("getLatestSignal", () => {
  it("queries pair PK descending with Limit 1 and returns reconstructed BlendedSignal", async () => {
    const signal = makeSignal();
    const emittedAt = new Date(signal.asOf).toISOString();
    const signalId = "00000000abcd-some-uuid";
    const storedItem = {
      pair: signal.pair,
      emittedAtSignalId: `${emittedAt}#${signalId}`,
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
      ttl: Math.floor(Date.now() / 1000) + 86400 * 90,
    };
    send.mockResolvedValue({ Items: [storedItem] });

    const { getLatestSignal } = await import("./signal-store.js");
    const result = await getLatestSignal("BTC/USDT");

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Query");
    expect(cmd.input.ScanIndexForward).toBe(false);
    expect(cmd.input.Limit).toBe(1);
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ":pair": "BTC/USDT" });
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

  it("returns multiple results in order", async () => {
    const signal1 = makeSignal({ asOf: 1700000060000, type: "buy" });
    const signal2 = makeSignal({ asOf: 1700000000000, type: "sell" });
    const emittedAt1 = new Date(signal1.asOf).toISOString();
    const emittedAt2 = new Date(signal2.asOf).toISOString();
    send.mockResolvedValue({
      Items: [
        {
          pair: signal1.pair,
          emittedAtSignalId: `${emittedAt1}#id-1`,
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
        {
          pair: signal2.pair,
          emittedAtSignalId: `${emittedAt2}#id-2`,
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
    const { getRecentSignals } = await import("./signal-store.js");
    const results = await getRecentSignals("BTC/USDT", 2);
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("buy");
    expect(results[1].type).toBe("sell");
  });

  it("returns empty array when no signals exist", async () => {
    send.mockResolvedValue({ Items: [] });
    const { getRecentSignals } = await import("./signal-store.js");
    expect(await getRecentSignals("BTC/USDT")).toEqual([]);
  });
});
