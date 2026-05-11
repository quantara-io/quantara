/**
 * higher-tf-poller-handler.test.ts
 *
 * Tests for the coinbase 4h aggregation path introduced in #321.
 * All DynamoDB access is mocked at the candle-store module boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Candle } from "@quantara/shared";

// ---- Mock candle-store so no real DDB calls are made ----
const getCandlesMock = vi.fn();
const storeCandlesMock = vi.fn();

vi.mock("./lib/candle-store.js", () => ({
  getCandles: getCandlesMock,
  storeCandles: storeCandlesMock,
}));

// ---- Mock ccxt so buildExchangeClients doesn't call the real constructor ----
vi.mock("ccxt", () => {
  const makeFakeExchange = () => ({
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    enableRateLimit: true,
  });
  return {
    default: {
      binanceus: vi.fn().mockImplementation(makeFakeExchange),
      coinbase: vi.fn().mockImplementation(makeFakeExchange),
      kraken: vi.fn().mockImplementation(makeFakeExchange),
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  getCandlesMock.mockReset();
  storeCandlesMock.mockReset();
  storeCandlesMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Candle fixture for a coinbase 1h bar. */
function make1hCandle(openTime: number, overrides: Partial<Candle> = {}): Candle {
  return {
    exchange: "coinbase",
    symbol: "BTC/USD",
    pair: "BTC/USDT",
    timeframe: "1h",
    openTime,
    closeTime: openTime + 3_600_000,
    open: 50_000,
    high: 51_000,
    low: 49_000,
    close: 50_500,
    volume: 100,
    isClosed: true,
    source: "live",
    ...overrides,
  };
}

// A 4h boundary: 2024-01-01T00:00:00.000Z = 1704067200000
const BASE_4H_OPEN = 1_704_067_200_000;
const ONE_HOUR = 3_600_000;

// The 4 hourly candles that compose the 4h bar starting at BASE_4H_OPEN
const HOUR_0 = make1hCandle(BASE_4H_OPEN, {
  open: 50_000,
  high: 51_000,
  low: 49_500,
  close: 50_500,
  volume: 100,
});
const HOUR_1 = make1hCandle(BASE_4H_OPEN + ONE_HOUR, {
  open: 50_500,
  high: 52_000,
  low: 50_000,
  close: 51_800,
  volume: 120,
});
const HOUR_2 = make1hCandle(BASE_4H_OPEN + 2 * ONE_HOUR, {
  open: 51_800,
  high: 53_000,
  low: 51_000,
  close: 52_500,
  volume: 90,
});
const HOUR_3 = make1hCandle(BASE_4H_OPEN + 3 * ONE_HOUR, {
  open: 52_500,
  high: 52_800,
  low: 51_500,
  close: 52_000,
  volume: 110,
});

// ---------------------------------------------------------------------------
// aggregateCoinbase4hFromHourly — unit tests
// ---------------------------------------------------------------------------

describe("aggregateCoinbase4hFromHourly", () => {
  it("returns a correctly aggregated 4h candle when all 4 hourly candles are present", async () => {
    // DDB returns in descending order (most-recent first), but getCandles is
    // called with limit=6 and we match by openTime, so order doesn't matter here.
    getCandlesMock.mockResolvedValue([HOUR_3, HOUR_2, HOUR_1, HOUR_0]);

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", BASE_4H_OPEN);

    expect(result).not.toBeNull();
    expect(result!.exchange).toBe("coinbase");
    expect(result!.timeframe).toBe("4h");
    expect(result!.openTime).toBe(BASE_4H_OPEN);
    expect(result!.closeTime).toBe(BASE_4H_OPEN + 4 * ONE_HOUR);
    // open = first hourly open, close = last hourly close
    expect(result!.open).toBe(50_000);
    expect(result!.close).toBe(52_000);
    // high = max of all highs
    expect(result!.high).toBe(53_000);
    // low = min of all lows
    expect(result!.low).toBe(49_500);
    // volume = sum of all volumes
    expect(result!.volume).toBe(420);
    expect(result!.isClosed).toBe(true);
    expect(result!.source).toBe("live");
  });

  it("queries candle-store for coinbase 1h with the correct pair", async () => {
    getCandlesMock.mockResolvedValue([HOUR_3, HOUR_2, HOUR_1, HOUR_0]);

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    await aggregateCoinbase4hFromHourly("BTC/USDT", BASE_4H_OPEN);

    expect(getCandlesMock).toHaveBeenCalledWith("BTC/USDT", "coinbase", "1h", 6);
  });

  it("returns null and logs a warning when only 3 of 4 hourly candles are available", async () => {
    // Missing HOUR_2
    getCandlesMock.mockResolvedValue([HOUR_3, HOUR_1, HOUR_0]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", BASE_4H_OPEN);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("only 3/4 hourly candles available"),
    );
    warnSpy.mockRestore();
  });

  it("returns null and logs a warning when zero hourly candles are available", async () => {
    getCandlesMock.mockResolvedValue([]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", BASE_4H_OPEN);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("only 0/4 hourly candles available"),
    );
    warnSpy.mockRestore();
  });

  it("returns null when only 1 of 4 hourly candles is available (partial window)", async () => {
    getCandlesMock.mockResolvedValue([HOUR_0]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", BASE_4H_OPEN);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("only 1/4 hourly candles available"),
    );
    warnSpy.mockRestore();
  });

  it("uses the coinbase symbol override (BTC/USD not BTC/USDT) on the aggregated candle", async () => {
    getCandlesMock.mockResolvedValue([HOUR_3, HOUR_2, HOUR_1, HOUR_0]);

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", BASE_4H_OPEN);

    expect(result!.symbol).toBe("BTC/USD");
    expect(result!.pair).toBe("BTC/USDT");
  });
});

// ---------------------------------------------------------------------------
// handler — coinbase 4h path integration
// ---------------------------------------------------------------------------

describe("handler — coinbase 4h aggregation path", () => {
  it("calls storeCandles with the aggregated candle when 4h boundary fires and all 1h bars are present", async () => {
    getCandlesMock.mockResolvedValue([HOUR_3, HOUR_2, HOUR_1, HOUR_0]);

    // Fire at exactly one minute after the 4h boundary so isCloseBoundary is true.
    // The 4h boundary is at BASE_4H_OPEN + 4h (closeTime of the target candle).
    // The handler computes: lastBoundary = floor(now / 4h) * 4h
    //                       targetOpenTime = lastBoundary - 4h
    // We want targetOpenTime = BASE_4H_OPEN, so lastBoundary = BASE_4H_OPEN + 4h.
    // now must be within [lastBoundary, lastBoundary + 60s).
    const FOUR_HOURS = 4 * ONE_HOUR;
    const now = BASE_4H_OPEN + FOUR_HOURS + 30_000; // 30s after the 4h close

    const { handler } = await import("./higher-tf-poller-handler.js");
    await handler({ time: new Date(now).toISOString() });

    // storeCandles must have been called at least once with a coinbase 4h candle
    const storedCandles: Candle[] = storeCandlesMock.mock.calls.flat(1).flat(1) as Candle[];
    const coinbase4h = storedCandles.find((c) => c.exchange === "coinbase" && c.timeframe === "4h");
    expect(coinbase4h).toBeDefined();
    expect(coinbase4h!.openTime).toBe(BASE_4H_OPEN);
    expect(coinbase4h!.source).toBe("live");
  });

  it("does not call storeCandles for coinbase 4h when fewer than 4 hourly candles are available", async () => {
    // Only 2 of 4 hourly candles available
    getCandlesMock.mockResolvedValue([HOUR_1, HOUR_0]);

    const FOUR_HOURS = 4 * ONE_HOUR;
    const now = BASE_4H_OPEN + FOUR_HOURS + 30_000;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { handler } = await import("./higher-tf-poller-handler.js");
    await handler({ time: new Date(now).toISOString() });

    const storedCandles: Candle[] = storeCandlesMock.mock.calls.flat(1).flat(1) as Candle[];
    const coinbase4h = storedCandles.find((c) => c.exchange === "coinbase" && c.timeframe === "4h");
    expect(coinbase4h).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("only 2/4 hourly candles available"),
    );

    warnSpy.mockRestore();
  });
});
