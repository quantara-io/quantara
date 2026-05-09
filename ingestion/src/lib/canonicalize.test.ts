import { describe, it, expect } from "vitest";
import type { Candle } from "@quantara/shared";

import { canonicalizeCandle } from "./canonicalize.js";

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    exchange: "binanceus",
    symbol: "BTC/USDT",
    pair: "BTC/USDT",
    timeframe: "15m",
    openTime: 1700000000000,
    closeTime: 1700000900000,
    open: 30000,
    high: 30500,
    low: 29800,
    close: 30200,
    volume: 100,
    isClosed: true,
    source: "live",
    ...overrides,
  };
}

describe("canonicalizeCandle", () => {
  it("returns null when all exchanges are stale", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus" }),
      coinbase: makeCandle({ exchange: "coinbase" }),
      kraken: makeCandle({ exchange: "kraken" }),
    };
    const staleness = { binanceus: true, coinbase: true, kraken: true };
    expect(canonicalizeCandle(candles, staleness)).toBeNull();
  });

  it("returns null when ≥2/3 exchanges are stale", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus" }),
      coinbase: makeCandle({ exchange: "coinbase" }),
      kraken: makeCandle({ exchange: "kraken" }),
    };
    const staleness = { binanceus: true, coinbase: true, kraken: false };
    expect(canonicalizeCandle(candles, staleness)).toBeNull();
  });

  it("returns null when fewer than 2 candles are non-null and non-stale", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus" }),
      coinbase: null,
      kraken: null,
    };
    const staleness = { binanceus: false, coinbase: false, kraken: false };
    expect(canonicalizeCandle(candles, staleness)).toBeNull();
  });

  it("returns null when only 1 non-stale exchange has a candle", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus" }),
      coinbase: null,
      kraken: makeCandle({ exchange: "kraken" }),
    };
    const staleness = { binanceus: false, coinbase: false, kraken: true };
    // only binanceus is non-stale and non-null → < 2 eligible
    expect(canonicalizeCandle(candles, staleness)).toBeNull();
  });

  it("computes median close from 3 non-stale candles", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus", close: 30000 }),
      coinbase: makeCandle({ exchange: "coinbase", close: 30200 }),
      kraken: makeCandle({ exchange: "kraken", close: 30100 }),
    };
    const staleness = { binanceus: false, coinbase: false, kraken: false };
    const result = canonicalizeCandle(candles, staleness);
    expect(result).not.toBeNull();
    // Sorted closes: [30000, 30100, 30200] → median = 30100
    expect(result!.consensus.close).toBe(30100);
  });

  it("computes median of 2 non-stale candles as average of the two", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus", close: 30000 }),
      coinbase: makeCandle({ exchange: "coinbase", close: 30200 }),
      kraken: makeCandle({ exchange: "kraken", close: 30100 }),
    };
    const staleness = { binanceus: false, coinbase: false, kraken: true };
    const result = canonicalizeCandle(candles, staleness);
    expect(result).not.toBeNull();
    // Only binanceus + coinbase are eligible: [30000, 30200] → median = 30100
    expect(result!.consensus.close).toBe(30100);
  });

  it("computes dispersion = (max − min) / median", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus", close: 30000 }),
      coinbase: makeCandle({ exchange: "coinbase", close: 30200 }),
      kraken: makeCandle({ exchange: "kraken", close: 30100 }),
    };
    const staleness = { binanceus: false, coinbase: false, kraken: false };
    const result = canonicalizeCandle(candles, staleness);
    expect(result).not.toBeNull();
    // max=30200, min=30000, median=30100
    // dispersion = 200 / 30100 ≈ 0.006645...
    const expected = (30200 - 30000) / 30100;
    expect(result!.dispersion).toBeCloseTo(expected, 10);
  });

  it("returns dispersion = 0 when all closes are identical", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus", close: 30000 }),
      coinbase: makeCandle({ exchange: "coinbase", close: 30000 }),
      kraken: makeCandle({ exchange: "kraken", close: 30000 }),
    };
    const staleness = { binanceus: false, coinbase: false, kraken: false };
    const result = canonicalizeCandle(candles, staleness);
    expect(result).not.toBeNull();
    expect(result!.dispersion).toBe(0);
  });

  it("sets exchange to 'consensus' on the returned candle", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus" }),
      coinbase: makeCandle({ exchange: "coinbase" }),
      kraken: makeCandle({ exchange: "kraken" }),
    };
    const staleness = { binanceus: false, coinbase: false, kraken: false };
    const result = canonicalizeCandle(candles, staleness);
    expect(result).not.toBeNull();
    expect(result!.consensus.exchange).toBe("consensus");
  });

  it("uses median for open, high, low, volume fields as well", () => {
    const candles = {
      binanceus: makeCandle({
        exchange: "binanceus",
        open: 29900,
        high: 30600,
        low: 29700,
        volume: 90,
      }),
      coinbase: makeCandle({
        exchange: "coinbase",
        open: 30000,
        high: 30500,
        low: 29800,
        volume: 100,
      }),
      kraken: makeCandle({ exchange: "kraken", open: 30100, high: 30400, low: 29900, volume: 110 }),
    };
    const staleness = { binanceus: false, coinbase: false, kraken: false };
    const result = canonicalizeCandle(candles, staleness);
    expect(result).not.toBeNull();
    const c = result!.consensus;
    expect(c.open).toBe(30000); // median of [29900, 30000, 30100]
    expect(c.high).toBe(30500); // median of [30400, 30500, 30600]
    expect(c.low).toBe(29800); // median of [29700, 29800, 29900]
    expect(c.volume).toBe(100); // median of [90, 100, 110]
  });

  it("handles a mix of null candles and stale exchanges leaving exactly 2 eligible", () => {
    const candles = {
      binanceus: makeCandle({ exchange: "binanceus", close: 30100 }),
      coinbase: null,
      kraken: makeCandle({ exchange: "kraken", close: 30300 }),
    };
    const staleness = { binanceus: false, coinbase: false, kraken: false };
    const result = canonicalizeCandle(candles, staleness);
    expect(result).not.toBeNull();
    // 2 eligible: [30100, 30300] → median = 30200
    expect(result!.consensus.close).toBe(30200);
  });
});
