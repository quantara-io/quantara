/**
 * DdbCandleStore unit tests — mocked DDB client.
 *
 * Follows the quantara-tests skill convention:
 *   - vi.mock at the module boundary for @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb
 *   - vi.resetModules + dynamic import in beforeEach
 *   - No real AWS calls
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the AWS SDK at module boundary.
// ---------------------------------------------------------------------------

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({ send: sendMock })),
  },
  QueryCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TF_MS = 3_600_000; // 1h

function makeRawItem(i: number, closeOffset = 0) {
  const openTime = BASE_TIME + i * TF_MS;
  const sk = `binance#1h#${new Date(openTime).toISOString()}`;
  return {
    pair: "BTC/USDT",
    sk,
    exchange: "binance",
    symbol: "BTC/USDT",
    timeframe: "1h",
    openTime,
    closeTime: openTime + TF_MS - 1 + closeOffset,
    open: 30_000,
    high: 30_100,
    low: 29_900,
    close: 30_000,
    volume: 100,
    isClosed: true,
    source: "backfill",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DdbCandleStore", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
  });

  it("calls QueryCommand with correct key condition for date range", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    const { DdbCandleStore } = await import("./ddb-candle-store.js");
    const store = new DdbCandleStore({ tableName: "test-candles" });

    const from = new Date(BASE_TIME);
    const to = new Date(BASE_TIME + 10 * TF_MS);

    await store.getCandles("BTC/USDT", "binance", "1h", from, to);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const callArg = sendMock.mock.calls[0][0] as {
      TableName: string;
      KeyConditionExpression: string;
      ExpressionAttributeValues: Record<string, string>;
    };
    expect(callArg.TableName).toBe("test-candles");
    expect(callArg.KeyConditionExpression).toContain("BETWEEN");
    expect(callArg.ExpressionAttributeValues[":pair"]).toBe("BTC/USDT");
    expect(callArg.ExpressionAttributeValues[":skFrom"]).toContain("binance#1h#");
    expect(callArg.ExpressionAttributeValues[":skTo"]).toContain("binance#1h#");
  });

  it("returns mapped candles from DDB items", async () => {
    const items = [makeRawItem(0), makeRawItem(1), makeRawItem(2)];
    sendMock.mockResolvedValueOnce({ Items: items });

    const { DdbCandleStore } = await import("./ddb-candle-store.js");
    const store = new DdbCandleStore({ tableName: "test-candles" });

    const candles = await store.getCandles(
      "BTC/USDT",
      "binance",
      "1h",
      new Date(BASE_TIME),
      new Date(BASE_TIME + 5 * TF_MS),
    );

    expect(candles).toHaveLength(3);
    expect(candles[0].pair).toBe("BTC/USDT");
    expect(candles[0].exchange).toBe("binance");
    expect(candles[0].timeframe).toBe("1h");
  });

  it("paginates via LastEvaluatedKey until exhausted", async () => {
    const page1 = [makeRawItem(0), makeRawItem(1)];
    const page2 = [makeRawItem(2)];

    // First call returns LastEvaluatedKey; second call returns none.
    sendMock
      .mockResolvedValueOnce({ Items: page1, LastEvaluatedKey: { pair: "BTC/USDT", sk: "x" } })
      .mockResolvedValueOnce({ Items: page2 });

    const { DdbCandleStore } = await import("./ddb-candle-store.js");
    const store = new DdbCandleStore({ tableName: "test-candles" });

    const candles = await store.getCandles(
      "BTC/USDT",
      "binance",
      "1h",
      new Date(BASE_TIME),
      new Date(BASE_TIME + 10 * TF_MS),
    );

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(candles).toHaveLength(3);
  });

  it("returns empty array when DDB returns no items", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });

    const { DdbCandleStore } = await import("./ddb-candle-store.js");
    const store = new DdbCandleStore({ tableName: "test-candles" });

    const candles = await store.getCandles(
      "BTC/USDT",
      "binance",
      "1h",
      new Date(BASE_TIME),
      new Date(BASE_TIME + TF_MS),
    );

    expect(candles).toHaveLength(0);
  });

  it("uses TABLE_CANDLES env var when no tableName option is given", async () => {
    process.env.TABLE_CANDLES = "env-candles-table";
    sendMock.mockResolvedValueOnce({ Items: [] });

    const { DdbCandleStore } = await import("./ddb-candle-store.js");
    const store = new DdbCandleStore();

    await store.getCandles(
      "BTC/USDT",
      "binance",
      "1h",
      new Date(BASE_TIME),
      new Date(BASE_TIME + TF_MS),
    );

    const callArg = sendMock.mock.calls[0][0] as { TableName: string };
    expect(callArg.TableName).toBe("env-candles-table");

    delete process.env.TABLE_CANDLES;
  });

  it("falls back to TABLE_PREFIX-based name when env vars absent", async () => {
    delete process.env.TABLE_CANDLES;
    delete process.env.TABLE_PREFIX;
    sendMock.mockResolvedValueOnce({ Items: [] });

    const { DdbCandleStore } = await import("./ddb-candle-store.js");
    const store = new DdbCandleStore();

    await store.getCandles(
      "BTC/USDT",
      "binance",
      "1h",
      new Date(BASE_TIME),
      new Date(BASE_TIME + TF_MS),
    );

    const callArg = sendMock.mock.calls[0][0] as { TableName: string };
    expect(callArg.TableName).toBe("quantara-dev-candles");
  });
});
