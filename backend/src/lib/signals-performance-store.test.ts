/**
 * Tests for signals-performance-store.ts — DDB-shape assertions.
 *
 * These tests mock the DocumentClient directly (not the store) and assert
 * the exact KeyConditionExpression / FilterExpression / Limit / Key each
 * store function builds. This is the contract that would have caught the
 * begins_with-on-hash-key regression in PR #330 (Bug 1) — DDB rejects
 * begins_with on a hash key at runtime, and only a shape-level test pins
 * that we use GetItem instead.
 *
 * One test per public store function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the DocumentClient before importing the store
// ---------------------------------------------------------------------------

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({ send: sendMock }),
  },
  GetCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "GetCommand" })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "QueryCommand" })),
  ScanCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "ScanCommand" })),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  process.env.TABLE_PREFIX = "test-";
  delete process.env.TABLE_SIGNAL_OUTCOMES;
  delete process.env.TABLE_ACCURACY_AGGREGATES;
  delete process.env.TABLE_RULE_ATTRIBUTION;
});

async function loadStore() {
  return await import("./signals-performance-store.js");
}

// ---------------------------------------------------------------------------
// getSignalHistory
// ---------------------------------------------------------------------------

describe("getSignalHistory", () => {
  it("issues a Query with the right key + filter + 4x Limit safety factor", async () => {
    sendMock.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
    const { getSignalHistory } = await loadStore();

    await getSignalHistory("BTC/USDT", "30d", 50, undefined);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]![0];
    expect(command._type).toBe("QueryCommand");
    expect(command.TableName).toBe("test-signal-outcomes");
    expect(command.KeyConditionExpression).toBe("pair = :pair");
    // attribute_exists(resolvedAt) is critical: drops rule-fan-out rows
    // which share the same `pair` partition but have no `resolvedAt`.
    expect(command.FilterExpression).toBe("attribute_exists(resolvedAt) AND resolvedAt >= :cutoff");
    expect(command.ExpressionAttributeValues[":pair"]).toBe("BTC/USDT");
    expect(typeof command.ExpressionAttributeValues[":cutoff"]).toBe("string");
    // 4x safety factor: filter applies after Limit, so over-scan internally.
    expect(command.Limit).toBe(50 * 4);
    expect(command.ExclusiveStartKey).toBeUndefined();
  });

  it("decodes a base64url cursor into ExclusiveStartKey", async () => {
    sendMock.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
    const { getSignalHistory } = await loadStore();

    const startKey = { pair: "BTC/USDT", signalId: "sig-99" };
    const cursor = Buffer.from(JSON.stringify(startKey)).toString("base64url");

    await getSignalHistory("BTC/USDT", "7d", 20, cursor);

    const command = sendMock.mock.calls[0]![0];
    expect(command.ExclusiveStartKey).toEqual(startKey);
  });

  it("trims results to the requested limit even when DDB returns the full over-scan", async () => {
    const fakeRow = (i: number) => ({
      pair: "BTC/USDT",
      signalId: `sig-${i}`,
      resolvedAt: "2024-06-01T00:00:00.000Z",
    });
    // DDB returns the full 4x window (filtered down by attribute_exists).
    sendMock.mockResolvedValue({
      Items: Array.from({ length: 200 }, (_, i) => fakeRow(i)),
      LastEvaluatedKey: undefined,
    });
    const { getSignalHistory } = await loadStore();

    const page = await getSignalHistory("BTC/USDT", "30d", 50, undefined);
    expect(page.outcomes).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// getAccuracyAggregate
// ---------------------------------------------------------------------------

describe("getAccuracyAggregate", () => {
  it("issues a GetItem on the composite key (pk = pair#timeframe, window)", async () => {
    sendMock.mockResolvedValue({ Item: undefined });
    const { getAccuracyAggregate } = await loadStore();

    const result = await getAccuracyAggregate("BTC/USDT", "1h", "30d");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]![0];
    // Critical: NOT a QueryCommand. accuracy_aggregates has hash key `pk` —
    // DDB rejects begins_with on a hash key, so GetItem is the only valid
    // read path for a specific (pair, timeframe, window) row.
    expect(command._type).toBe("GetCommand");
    expect(command.TableName).toBe("test-accuracy-aggregates");
    expect(command.Key).toEqual({
      pk: "BTC/USDT#1h",
      window: "30d",
    });
    expect(result).toBeNull();
  });

  it("maps the stored row into the AccuracyBadge shape", async () => {
    sendMock.mockResolvedValue({
      Item: {
        pk: "BTC/USDT#1h",
        window: "30d",
        totalResolved: 100,
        correct: 60,
        incorrect: 30,
        neutral: 10,
        invalidatedExcluded: 2,
        brier: 0.18,
        ece: 0.04,
        computedAt: "2024-01-10T00:00:00.000Z",
      },
    });
    const { getAccuracyAggregate } = await loadStore();

    const result = await getAccuracyAggregate("BTC/USDT", "1h", "30d");

    expect(result).toEqual({
      pair: "BTC/USDT",
      timeframe: "1h",
      window: "30d",
      totalResolved: 100,
      correctCount: 60,
      incorrectCount: 30,
      neutralCount: 10,
      invalidatedCount: 2,
      accuracyPct: 60 / 90,
      brier: 0.18,
      ece: 0.04,
      computedAt: "2024-01-10T00:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// getCalibrationData
// ---------------------------------------------------------------------------

describe("getCalibrationData", () => {
  it("issues a Query with attribute_exists(resolvedAt) and 4x target sample as Limit", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getCalibrationData } = await loadStore();

    await getCalibrationData("BTC/USDT", "1h", "90d");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]![0];
    expect(command._type).toBe("QueryCommand");
    expect(command.TableName).toBe("test-signal-outcomes");
    expect(command.KeyConditionExpression).toBe("pair = :pair");
    expect(command.FilterExpression).toBe(
      "attribute_exists(resolvedAt) AND resolvedAt >= :cutoff AND emittingTimeframe = :tf",
    );
    expect(command.ExpressionAttributeValues[":pair"]).toBe("BTC/USDT");
    expect(command.ExpressionAttributeValues[":tf"]).toBe("1h");
    // Target sample 1000 × 4x safety factor = 4000.
    expect(command.Limit).toBe(4000);
  });

  it("builds 10 bins from raw outcomes (K=10)", async () => {
    sendMock.mockResolvedValue({
      Items: [
        { confidence: 0.75, outcome: "correct", invalidatedExcluded: false },
        { confidence: 0.72, outcome: "incorrect", invalidatedExcluded: false },
      ],
    });
    const { getCalibrationData } = await loadStore();

    const result = await getCalibrationData("BTC/USDT", "1h", "90d");
    expect(result.bins).toHaveLength(10);
    expect(result.totalUsed).toBe(2);
    // Both samples fall in bin [0.7, 0.8) — index 7.
    expect(result.bins[7]!.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getRuleAttributionData
// ---------------------------------------------------------------------------

describe("getRuleAttributionData", () => {
  it("issues a Scan with contains(pk, :suffix) AND #w = :window", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getRuleAttributionData } = await loadStore();

    await getRuleAttributionData("BTC/USDT", "1h", "30d");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]![0];
    expect(command._type).toBe("ScanCommand");
    expect(command.TableName).toBe("test-rule-attribution");
    expect(command.FilterExpression).toBe("contains(pk, :suffix) AND #w = :window");
    expect(command.ExpressionAttributeNames).toEqual({ "#w": "window" });
    expect(command.ExpressionAttributeValues).toEqual({
      ":suffix": "#BTC/USDT#1h",
      ":window": "30d",
    });
  });

  it("maps stored rows into RuleAttributionEntry shape", async () => {
    sendMock.mockResolvedValue({
      Items: [
        {
          pk: "rsi_oversold#BTC/USDT#1h",
          rule: "rsi_oversold",
          fireCount: 40,
          correctCount: 28,
          incorrectCount: 10,
          neutralCount: 2,
          contribution: 0.7368421052631579,
          computedAt: "2024-01-10T00:00:00.000Z",
        },
      ],
    });
    const { getRuleAttributionData } = await loadStore();

    const rules = await getRuleAttributionData("BTC/USDT", "1h", "30d");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.rule).toBe("rsi_oversold");
    expect(rules[0]!.fireCount).toBe(40);
    expect(rules[0]!.contribution).toBeCloseTo(0.7368, 3);
  });
});
