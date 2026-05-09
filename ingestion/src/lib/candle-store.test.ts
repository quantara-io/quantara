import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Candle } from "@quantara/shared";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  BatchWriteCommand: vi.fn().mockImplementation((input) => ({ __cmd: "BatchWrite", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
}));

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_CANDLES = "test-candles";
});

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    exchange: "binanceus",
    symbol: "BTC/USDT",
    pair: "BTC/USDT",
    timeframe: "1m",
    openTime: 1700000000000,
    closeTime: 1700000060000,
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 12.3,
    isClosed: true,
    source: "live",
    ...overrides,
  };
}

describe("storeCandles", () => {
  it("writes candles in BatchWrite calls of up to 25", async () => {
    send.mockResolvedValue({});
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle({ openTime: 1700000000000 + i * 60_000 }),
    );
    const { storeCandles } = await import("./candle-store.js");
    await storeCandles(candles);
    const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
    expect(writes).toHaveLength(2);
    expect(writes[0][0].input.RequestItems["test-candles"]).toHaveLength(25);
    expect(writes[1][0].input.RequestItems["test-candles"]).toHaveLength(5);
  });

  it("builds the sort key as exchange#timeframe#isoTimestamp and sets a 7d TTL for 1m", async () => {
    send.mockResolvedValue({});
    const candle = makeCandle({ openTime: Date.UTC(2026, 3, 25, 10, 0, 0) });
    const { storeCandles } = await import("./candle-store.js");
    await storeCandles([candle]);
    const item = send.mock.calls[0][0].input.RequestItems["test-candles"][0].PutRequest.Item;
    expect(item.pair).toBe("BTC/USDT");
    expect(item.sk).toBe("binanceus#1m#2026-04-25T10:00:00.000Z");
    const nowSec = Math.floor(Date.now() / 1000);
    expect(item.ttl).toBeGreaterThanOrEqual(nowSec + 86400 * 7 - 5);
    expect(item.ttl).toBeLessThanOrEqual(nowSec + 86400 * 7 + 5);
  });

  it("uses a 365d TTL for 1d candles", async () => {
    send.mockResolvedValue({});
    const candle = makeCandle({ timeframe: "1d" });
    const { storeCandles } = await import("./candle-store.js");
    await storeCandles([candle]);
    const item = send.mock.calls[0][0].input.RequestItems["test-candles"][0].PutRequest.Item;
    const nowSec = Math.floor(Date.now() / 1000);
    expect(item.ttl).toBeGreaterThanOrEqual(nowSec + 86400 * 365 - 5);
  });

  it("does not call DynamoDB when given an empty list", async () => {
    const { storeCandles } = await import("./candle-store.js");
    await storeCandles([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("persists the source field in DDB item", async () => {
    send.mockResolvedValue({});
    const candle = makeCandle({ source: "backfill" });
    const { storeCandles } = await import("./candle-store.js");
    await storeCandles([candle]);
    const item = send.mock.calls[0][0].input.RequestItems["test-candles"][0].PutRequest.Item;
    expect(item.source).toBe("backfill");
  });

  it("throws when source is missing (v6 mandatory field enforcement)", async () => {
    const { storeCandles } = await import("./candle-store.js");
    // Cast to bypass TypeScript so we can test runtime guard
    const candleWithoutSource = {
      ...makeCandle(),
      source: undefined,
    } as unknown as import("@quantara/shared").Candle;
    await expect(storeCandles([candleWithoutSource])).rejects.toThrow(/candle\.source is required/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("getCandles", () => {
  it("queries by pair PK and exchange#timeframe# sort-key prefix, descending", async () => {
    send.mockResolvedValue({ Items: [{ pair: "BTC/USDT", sk: "binanceus#1m#x" }] });
    const { getCandles } = await import("./candle-store.js");
    const result = await getCandles("BTC/USDT", "binanceus", "1m", 5);
    expect(result).toHaveLength(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Query");
    expect(cmd.input.ExpressionAttributeValues).toEqual({
      ":pair": "BTC/USDT",
      ":prefix": "binanceus#1m#",
    });
    expect(cmd.input.ScanIndexForward).toBe(false);
    expect(cmd.input.Limit).toBe(5);
  });

  it("returns [] when DynamoDB returns no items", async () => {
    send.mockResolvedValue({});
    const { getCandles } = await import("./candle-store.js");
    expect(await getCandles("BTC/USDT", "binanceus", "1m")).toEqual([]);
  });
});
