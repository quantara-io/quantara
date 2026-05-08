import { describe, it, expect } from "vitest";

import { vwap } from "./vwap.js";

// Build a simple OHLCV series spanning 2 UTC days.
// Day 1: bars 0..4 starting at 2024-01-01T00:00:00Z
// Day 2: bars 5..9 starting at 2024-01-02T00:00:00Z
const DAY1_START = new Date("2024-01-01T00:00:00Z").getTime();
const DAY2_START = new Date("2024-01-02T00:00:00Z").getTime();
const HOUR_MS = 3600000;

function makeOneDayBars(startMs: number, n: number, base: number) {
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  const openTime: number[] = [];
  for (let i = 0; i < n; i++) {
    high.push(base + 1);
    low.push(base - 1);
    close.push(base);
    volume.push(1000);
    openTime.push(startMs + i * HOUR_MS);
  }
  return { high, low, close, volume, openTime };
}

describe("vwap", () => {
  it("returns null for non-15m/1h timeframes", () => {
    const { high, low, close, volume, openTime } = makeOneDayBars(
      DAY1_START,
      5,
      100,
    );
    for (const tf of ["1m", "5m", "4h", "1d"] as const) {
      const r = vwap(high, low, close, volume, openTime, tf);
      r.forEach((v) => expect(v).toBeNull());
    }
  });

  it("returns non-null values for 1h timeframe", () => {
    const { high, low, close, volume, openTime } = makeOneDayBars(
      DAY1_START,
      5,
      100,
    );
    const r = vwap(high, low, close, volume, openTime, "1h");
    r.forEach((v) => expect(v).not.toBeNull());
  });

  it("returns non-null values for 15m timeframe", () => {
    const { high, low, close, volume, openTime } = makeOneDayBars(
      DAY1_START,
      5,
      100,
    );
    const r = vwap(high, low, close, volume, openTime, "15m");
    r.forEach((v) => expect(v).not.toBeNull());
  });

  it("VWAP equals typical price when all bars identical", () => {
    // TP = (101 + 99 + 100) / 3 = 100
    const { high, low, close, volume, openTime } = makeOneDayBars(
      DAY1_START,
      5,
      100,
    );
    const r = vwap(high, low, close, volume, openTime, "1h");
    r.forEach((v) => expect(v).toBeCloseTo(100, 8));
  });

  it("resets at UTC midnight", () => {
    // Day 1: bars 0..4 with TP=100, volume=1000
    // Day 2: bars 5..9 with TP=200, volume=1000
    const day1 = makeOneDayBars(DAY1_START, 5, 100);
    const day2 = makeOneDayBars(DAY2_START, 5, 200);

    const high = [...day1.high, ...day2.high];
    const low = [...day1.low, ...day2.low];
    const close = [...day1.close, ...day2.close];
    const volume = [...day1.volume, ...day2.volume];
    const openTime = [...day1.openTime, ...day2.openTime];

    const r = vwap(high, low, close, volume, openTime, "1h");

    // Day 1: all bars have VWAP = 100 (TP=100).
    for (let i = 0; i < 5; i++) {
      expect(r[i]).toBeCloseTo(100, 8);
    }
    // Day 2: all bars have VWAP = 200 (TP=200, reset at midnight).
    for (let i = 5; i < 10; i++) {
      expect(r[i]).toBeCloseTo(200, 8);
    }
  });

  it("VWAP is volume-weighted (higher volume bars pull VWAP toward their TP)", () => {
    // 2-bar session: bar0 TP=90 vol=100, bar1 TP=110 vol=900
    // VWAP = (90*100 + 110*900) / 1000 = (9000+99000)/1000 = 108
    const h = [91, 111];
    const l = [89, 109];
    const c = [90, 110];
    const v = [100, 900];
    const ot = [DAY1_START, DAY1_START + HOUR_MS];
    const r = vwap(h, l, c, v, ot, "1h");
    expect(r[0]).toBeCloseTo(90, 8);
    expect(r[1]).toBeCloseTo(108, 8);
  });
});
