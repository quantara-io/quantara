/**
 * Tests for ratification-store.ts — RatificationRecord persistence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlendedSignal } from "@quantara/shared";
import type { RatificationRecord } from "./ratification-store.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: sendMock }) },
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  process.env.TABLE_RATIFICATIONS = "test-ratifications";
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBlendedSignal(): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "buy",
    confidence: 0.75,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: [],
    perTimeframe: {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
    },
    weightsUsed: {
      "1m": 0,
      "5m": 0,
      "15m": 0.15,
      "1h": 0.2,
      "4h": 0.3,
      "1d": 0.35,
    },
    asOf: 1700000000000,
    emittingTimeframe: "4h",
    risk: null,
  };
}

function makeRecord(overrides: Partial<RatificationRecord> = {}): RatificationRecord {
  const signal = makeBlendedSignal();
  return {
    pair: "BTC/USDT",
    timeframe: "4h",
    algoCandidate: signal,
    llmRequest: {
      model: "claude-sonnet-4-6",
      systemHash: "abc123",
      userJsonHash: "def456",
    },
    llmRawResponse: {
      type: "hold",
      confidence: 0.6,
      reasoning: "test",
      downgraded: true,
      downgradeReason: null,
    },
    cacheHit: false,
    validation: { ok: true },
    ratified: { ...signal, type: "hold", confidence: 0.6 },
    fellBackToAlgo: false,
    latencyMs: 350,
    costUsd: 0.001,
    invokedReason: "news",
    invokedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// putRatificationRecord
// ---------------------------------------------------------------------------

describe("putRatificationRecord", () => {
  it("writes to DDB with correct table name", async () => {
    const { putRatificationRecord } = await import("./ratification-store.js");
    sendMock.mockResolvedValueOnce({});
    await putRatificationRecord(makeRecord());
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0] as { input: { TableName: string } };
    expect(call.input.TableName).toBe("test-ratifications");
  });

  it("returns a UUID-shaped recordId", async () => {
    const { putRatificationRecord } = await import("./ratification-store.js");
    sendMock.mockResolvedValueOnce({});
    const id = await putRatificationRecord(makeRecord());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("includes invokedAtRecordId sort key in the item", async () => {
    const { putRatificationRecord } = await import("./ratification-store.js");
    sendMock.mockResolvedValueOnce({});
    const record = makeRecord();
    await putRatificationRecord(record);
    const call = sendMock.mock.calls[0][0] as { input: { Item: Record<string, unknown> } };
    const sk = call.input.Item.invokedAtRecordId as string;
    expect(typeof sk).toBe("string");
    expect(sk).toContain(record.invokedAt);
  });

  it("includes a ttl 30 days from invokedAt", async () => {
    const { putRatificationRecord } = await import("./ratification-store.js");
    sendMock.mockResolvedValueOnce({});
    const invokedAt = new Date().toISOString();
    await putRatificationRecord(makeRecord({ invokedAt }));
    const call = sendMock.mock.calls[0][0] as { input: { Item: { ttl: number } } };
    const expectedTtl = Math.floor(Date.parse(invokedAt) / 1000) + 86400 * 30;
    expect(call.input.Item.ttl).toBeCloseTo(expectedTtl, -1);
  });

  it("persists cache-hit record with costUsd=0", async () => {
    const { putRatificationRecord } = await import("./ratification-store.js");
    sendMock.mockResolvedValueOnce({});
    await putRatificationRecord(makeRecord({ cacheHit: true, costUsd: 0 }));
    const call = sendMock.mock.calls[0][0] as {
      input: { Item: { cacheHit: boolean; costUsd: number } };
    };
    expect(call.input.Item.cacheHit).toBe(true);
    expect(call.input.Item.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRecentRatifications
// ---------------------------------------------------------------------------

describe("getRecentRatifications", () => {
  it("returns empty array when table is empty", async () => {
    const { getRecentRatifications } = await import("./ratification-store.js");
    sendMock.mockResolvedValueOnce({ Items: [] });
    const results = await getRecentRatifications("BTC/USDT");
    expect(results).toEqual([]);
  });

  it("passes pair as the partition key", async () => {
    const { getRecentRatifications } = await import("./ratification-store.js");
    sendMock.mockResolvedValueOnce({ Items: [] });
    await getRecentRatifications("ETH/USDT", 5);
    const call = sendMock.mock.calls[0][0] as {
      input: { ExpressionAttributeValues: Record<string, unknown>; Limit: number };
    };
    expect(call.input.ExpressionAttributeValues[":pair"]).toBe("ETH/USDT");
    expect(call.input.Limit).toBe(5);
  });

  it("returns items as RatificationRecord array", async () => {
    const { getRecentRatifications } = await import("./ratification-store.js");
    const record = makeRecord();
    sendMock.mockResolvedValueOnce({ Items: [record] });
    const results = await getRecentRatifications("BTC/USDT");
    expect(results).toHaveLength(1);
    expect(results[0].pair).toBe("BTC/USDT");
  });
});

// ---------------------------------------------------------------------------
// getRecentShockRatifications — used by the sentiment-shock cost gate.
// Critical because DDB applies Limit BEFORE FilterExpression, so a single
// page can return zero rows even when shocks exist in the time range.
// ---------------------------------------------------------------------------

describe("getRecentShockRatifications", () => {
  function makeShockRecord(invokedAt: string): RatificationRecord {
    return { ...makeRecord(), invokedAt, triggerReason: "sentiment_shock" };
  }

  it("issues a Query with the correct KeyCondition, FilterExpression, and ScanIndexForward=false", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    const { getRecentShockRatifications } = await import("./ratification-store.js");
    await getRecentShockRatifications("BTC/USDT", "2026-05-09T00:00:00.000Z");

    const cmd = sendMock.mock.calls[0][0] as { __cmd: string; input: Record<string, unknown> };
    expect(cmd.__cmd).toBe("Query");
    expect(cmd.input.TableName).toBe("test-ratifications");
    expect(cmd.input.KeyConditionExpression).toBe("#pair = :pair AND invokedAtRecordId >= :since");
    expect(cmd.input.FilterExpression).toBe("triggerReason = :shock");
    expect(cmd.input.ScanIndexForward).toBe(false);
    const values = cmd.input.ExpressionAttributeValues as Record<string, string>;
    expect(values[":pair"]).toBe("BTC/USDT");
    expect(values[":since"]).toBe("2026-05-09T00:00:00.000Z");
    expect(values[":shock"]).toBe("sentiment_shock");
  });

  it("returns shock records (post-filter) as RatificationRecord array", async () => {
    const r1 = makeShockRecord("2026-05-09T10:00:00.000Z");
    const r2 = makeShockRecord("2026-05-09T10:30:00.000Z");
    sendMock.mockResolvedValueOnce({ Items: [r2, r1] });
    const { getRecentShockRatifications } = await import("./ratification-store.js");
    const out = await getRecentShockRatifications("BTC/USDT", "2026-05-09T00:00:00.000Z", 5);
    expect(out).toHaveLength(2);
    expect(out[0].triggerReason).toBe("sentiment_shock");
  });

  it("paginates when the first DDB page is filtered to zero shock rows but more pages exist", async () => {
    // First page: nothing matches the filter, but LastEvaluatedKey is set
    // (DDB applies Limit before FilterExpression — this is the exact
    // scenario the cost gate would otherwise fail open under).
    sendMock.mockResolvedValueOnce({
      Items: [],
      LastEvaluatedKey: { pair: "BTC/USDT", invokedAtRecordId: "cursor-1" },
    });
    // Second page returns the shock row.
    const r1 = makeShockRecord("2026-05-09T09:30:00.000Z");
    sendMock.mockResolvedValueOnce({ Items: [r1] });

    const { getRecentShockRatifications } = await import("./ratification-store.js");
    const out = await getRecentShockRatifications("BTC/USDT", "2026-05-09T00:00:00.000Z", 5);
    expect(out).toHaveLength(1);
    expect(out[0].invokedAt).toBe("2026-05-09T09:30:00.000Z");

    // Second call must include the ExclusiveStartKey from page 1.
    const secondCmd = sendMock.mock.calls[1][0] as { input: Record<string, unknown> };
    expect(secondCmd.input.ExclusiveStartKey).toEqual({
      pair: "BTC/USDT",
      invokedAtRecordId: "cursor-1",
    });
  });

  it("stops paginating once targetCount shock rows have been collected", async () => {
    const r1 = makeShockRecord("2026-05-09T10:00:00.000Z");
    const r2 = makeShockRecord("2026-05-09T10:30:00.000Z");
    sendMock.mockResolvedValueOnce({
      Items: [r2, r1],
      LastEvaluatedKey: { pair: "BTC/USDT", invokedAtRecordId: "cursor-1" },
    });

    const { getRecentShockRatifications } = await import("./ratification-store.js");
    const out = await getRecentShockRatifications("BTC/USDT", "2026-05-09T00:00:00.000Z", 2);
    expect(out).toHaveLength(2);
    // Second page should NOT be queried — target reached.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("stops paginating when DDB returns no LastEvaluatedKey", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] }); // no LastEvaluatedKey
    const { getRecentShockRatifications } = await import("./ratification-store.js");
    const out = await getRecentShockRatifications("BTC/USDT", "2026-05-09T00:00:00.000Z", 10);
    expect(out).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// putRatificationRecord — recordId is now part of the persisted item.
// ---------------------------------------------------------------------------

describe("putRatificationRecord — recordId persistence", () => {
  it("stores a server-generated recordId on the DDB item", async () => {
    sendMock.mockResolvedValueOnce({});
    const { putRatificationRecord } = await import("./ratification-store.js");
    const record = makeRecord();
    const recordId = await putRatificationRecord(record);

    expect(recordId).toMatch(/^[0-9a-f-]{36}$/i); // UUID
    const cmd = sendMock.mock.calls[0][0] as { __cmd: string; input: Record<string, unknown> };
    expect(cmd.__cmd).toBe("Put");
    const item = cmd.input.Item as Record<string, unknown>;
    expect(item.recordId).toBe(recordId);
    expect(item.invokedAtRecordId).toContain(recordId);
  });
});
