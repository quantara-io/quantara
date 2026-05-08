import { describe, it, expect } from "vitest";
import type { Candle } from "@quantara/shared";

import { buildIndicatorState } from "./index.js";

// Build 250 deterministic candles (more than enough for all warm-ups).
function makeCandles(n = 250, seed = 42): Candle[] {
  let val = 100;
  const candles: Candle[] = [];
  let s = seed;
  const DAY_START = new Date("2024-01-01T00:00:00Z").getTime();
  const HOUR_MS = 3600000;

  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const move = (((s >>> 0) % 201) - 100) / 200;
    val = Math.max(1, val + move);
    const spread = 0.5;
    const openTime = DAY_START + i * HOUR_MS;
    candles.push({
      exchange: "binance",
      symbol: "BTC/USDT",
      pair: "BTC-USDT",
      timeframe: "1h",
      openTime,
      closeTime: openTime + HOUR_MS - 1,
      open: val,
      high: val + spread,
      low: Math.max(0.01, val - spread),
      close: val,
      volume: 1000 + ((s >>> 4) % 5000),
      isClosed: true,
    });
  }
  return candles;
}

describe("buildIndicatorState — golden fixture", () => {
  const candles = makeCandles(250);
  const ctx = {
    pair: "BTC-USDT",
    exchange: "binance",
    timeframe: "1h" as const,
    fearGreed: 55,
    dispersion: 0.01,
  };
  const state = buildIndicatorState(candles, ctx);

  it("returns correct pair, exchange, timeframe", () => {
    expect(state.pair).toBe("BTC-USDT");
    expect(state.exchange).toBe("binance");
    expect(state.timeframe).toBe("1h");
  });

  it("barsSinceStart equals candle count", () => {
    expect(state.barsSinceStart).toBe(250);
  });

  it("asOf equals closeTime of last candle", () => {
    expect(state.asOf).toBe(candles[249].closeTime);
  });

  it("fearGreed and dispersion are passed through", () => {
    expect(state.fearGreed).toBe(55);
    expect(state.dispersion).toBeCloseTo(0.01, 10);
  });

  it("rsi14 is non-null with 250 bars", () => {
    expect(state.rsi14).not.toBeNull();
    expect(state.rsi14!).toBeGreaterThanOrEqual(0);
    expect(state.rsi14!).toBeLessThanOrEqual(100);
  });

  it("ema20, ema50, ema200 are all non-null with 250 bars", () => {
    expect(state.ema20).not.toBeNull();
    expect(state.ema50).not.toBeNull();
    expect(state.ema200).not.toBeNull();
  });

  it("macdLine, macdSignal, macdHist are non-null", () => {
    expect(state.macdLine).not.toBeNull();
    expect(state.macdSignal).not.toBeNull();
    expect(state.macdHist).not.toBeNull();
    // hist = line - signal
    expect(state.macdHist).toBeCloseTo(state.macdLine! - state.macdSignal!, 8);
  });

  it("atr14 is positive", () => {
    expect(state.atr14).not.toBeNull();
    expect(state.atr14!).toBeGreaterThan(0);
  });

  it("bbUpper > bbMid > bbLower", () => {
    expect(state.bbUpper).not.toBeNull();
    expect(state.bbMid).not.toBeNull();
    expect(state.bbLower).not.toBeNull();
    expect(state.bbUpper!).toBeGreaterThan(state.bbMid!);
    expect(state.bbMid!).toBeGreaterThan(state.bbLower!);
  });

  it("bbWidth is positive", () => {
    expect(state.bbWidth).not.toBeNull();
    expect(state.bbWidth!).toBeGreaterThan(0);
  });

  it("obv is a number (not null)", () => {
    expect(state.obv).not.toBeNull();
    expect(typeof state.obv).toBe("number");
  });

  it("obvSlope is non-null with 250 bars", () => {
    expect(state.obvSlope).not.toBeNull();
  });

  it("vwap is non-null for 1h timeframe", () => {
    expect(state.vwap).not.toBeNull();
    expect(state.vwap!).toBeGreaterThan(0);
  });

  it("vwap is null for 4h timeframe", () => {
    const state4h = buildIndicatorState(
      candles.map((c) => ({ ...c, timeframe: "4h" as const })),
      { ...ctx, timeframe: "4h" },
    );
    expect(state4h.vwap).toBeNull();
  });

  it("volZ is a number", () => {
    expect(state.volZ).not.toBeNull();
    expect(typeof state.volZ).toBe("number");
  });

  it("realizedVolAnnualized is positive", () => {
    expect(state.realizedVolAnnualized).not.toBeNull();
    expect(state.realizedVolAnnualized!).toBeGreaterThan(0);
  });

  it("history.rsi14 has 5 entries, most recent first", () => {
    expect(state.history.rsi14).toHaveLength(5);
    // Most recent (index 0) should equal state.rsi14.
    expect(state.history.rsi14[0]).toBeCloseTo(state.rsi14!, 8);
  });

  it("history.macdHist has 5 entries, most recent first", () => {
    expect(state.history.macdHist).toHaveLength(5);
    expect(state.history.macdHist[0]).toBeCloseTo(state.macdHist!, 8);
  });

  it("history.ema20 has 5 entries", () => {
    expect(state.history.ema20).toHaveLength(5);
    expect(state.history.ema20[0]).toBeCloseTo(state.ema20!, 8);
  });

  it("history.ema50 has 5 entries", () => {
    expect(state.history.ema50).toHaveLength(5);
    expect(state.history.ema50[0]).toBeCloseTo(state.ema50!, 8);
  });

  it("history.close has 5 entries, most recent is last candle's close", () => {
    expect(state.history.close).toHaveLength(5);
    expect(state.history.close[0]).toBeCloseTo(candles[249].close, 8);
  });

  it("history.volume has 5 entries, most recent is last candle's volume", () => {
    expect(state.history.volume).toHaveLength(5);
    expect(state.history.volume[0]).toBe(candles[249].volume);
  });
});

describe("buildIndicatorState — empty-input guard", () => {
  it("throws a clear error when candles array is empty", () => {
    const ctx = {
      pair: "BTC-USDT",
      exchange: "binance",
      timeframe: "1h" as const,
      fearGreed: null,
      dispersion: null,
    };
    expect(() => buildIndicatorState([], ctx)).toThrow(
      "buildIndicatorState: candles array is empty",
    );
  });
});

describe("buildIndicatorState — short series (warm-up period)", () => {
  it("returns null for indicators with insufficient bars (10 candles)", () => {
    const candles = makeCandles(10);
    const ctx = {
      pair: "ETH-USDT",
      exchange: "coinbase",
      timeframe: "1h" as const,
      fearGreed: null,
      dispersion: null,
    };
    const state = buildIndicatorState(candles, ctx);

    expect(state.rsi14).toBeNull();
    expect(state.ema20).toBeNull();
    expect(state.macdLine).toBeNull();
    expect(state.atr14).toBeNull();
    expect(state.bbMid).toBeNull();
    // OBV is always populated.
    expect(typeof state.obv).toBe("number");
  });

  it("history.close and history.volume pad with null when candle count < HISTORY_SIZE", () => {
    // Only 1 candle: history positions [1..4] should be null, [0] is the real close/volume.
    const candles = makeCandles(1);
    const ctx = {
      pair: "ETH-USDT",
      exchange: "coinbase",
      timeframe: "1h" as const,
      fearGreed: null,
      dispersion: null,
    };
    const state = buildIndicatorState(candles, ctx);

    expect(state.history.close).toHaveLength(5);
    expect(state.history.volume).toHaveLength(5);
    // Index 0: real value from the single candle (not null, not 0-pad).
    expect(state.history.close[0]).toBe(candles[0].close);
    expect(state.history.volume[0]).toBe(candles[0].volume);
    // Indices 1–4: padding should be null, not 0.
    for (let i = 1; i < 5; i++) {
      expect(state.history.close[i]).toBeNull();
      expect(state.history.volume[i]).toBeNull();
    }
  });
});
