import { describe, it, expect } from "vitest";
import { stochastic } from "./stochastic.js";

function makeOHLC(n = 200, seed = 7): {
  high: number[];
  low: number[];
  close: number[];
} {
  let val = 100;
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const move = ((s >>> 0) % 201 - 100) / 200;
    val = Math.max(1, val + move);
    const spread = 0.5 + ((s >>> 8) % 100) / 100;
    high.push(val + spread / 2);
    low.push(Math.max(0.01, val - spread / 2));
    close.push(val);
  }
  return { high, low, close };
}

describe("stochastic — TradingView (14, 3, 3) convention", () => {
  const { high, low, close } = makeOHLC(200);
  // Default call: kN=14, smoothK=3, smoothD=3
  const { k, d } = stochastic(high, low, close);

  it("returns aligned series same length as input", () => {
    expect(k).toHaveLength(close.length);
    expect(d).toHaveLength(close.length);
  });

  it("slow-K (k) is null for first 15 bars (14-bar raw-K warmup + 2 for SMA-3)", () => {
    // raw-K first non-null at bar 13; SMA(raw-K, 3) first non-null at bar 13+2 = 15
    for (let i = 0; i < 15; i++) {
      expect(k[i]).toBeNull();
    }
  });

  it("slow-K (k) is non-null from bar 15 onward", () => {
    for (let i = 15; i < close.length; i++) {
      expect(k[i]).not.toBeNull();
    }
  });

  it("slow-K values are in [0, 100]", () => {
    for (let i = 15; i < close.length; i++) {
      expect(k[i]).toBeGreaterThanOrEqual(0);
      expect(k[i]).toBeLessThanOrEqual(100);
    }
  });

  it("d is null for first 17 bars (slow-K warmup 15 + 2 for SMA-3)", () => {
    // slow-K first non-null at bar 15; SMA(slow-K, 3) first non-null at bar 15+2 = 17
    for (let i = 0; i < 17; i++) {
      expect(d[i]).toBeNull();
    }
  });

  it("d is non-null from bar 17 onward", () => {
    for (let i = 17; i < close.length; i++) {
      expect(d[i]).not.toBeNull();
    }
  });

  // Reference values computed from the same makeOHLC(200, 7) fixture — TV (14,3,3) convention.
  it("slow-K at bar 15 matches reference within 1e-4", () => {
    expect(k[15]).toBeCloseTo(14.5009, 4);
  });

  it("%D at bar 17 matches reference within 1e-4 (first valid %D)", () => {
    expect(d[17]).toBeCloseTo(22.4125, 4);
  });

  it("slow-K at bar 100 matches reference within 1e-4", () => {
    expect(k[100]).toBeCloseTo(59.0935, 4);
  });

  it("%D at bar 100 matches reference within 1e-4", () => {
    expect(d[100]).toBeCloseTo(49.5697, 4);
  });

  it("div-by-zero guard: raw-K = 50 when high == low; slow-K = 50 once SMA window fills", () => {
    // 20 flat bars so slow-K SMA window fills (needs kN + smoothK - 1 = 16 bars)
    const flat = 20;
    const flatHigh = Array.from({ length: flat }, () => 10);
    const flatLow = Array.from({ length: flat }, () => 10);
    const flatClose = Array.from({ length: flat }, () => 10);
    const { k: fk } = stochastic(flatHigh, flatLow, flatClose, 14, 3, 3);
    // Bar 15 is first non-null slow-K: SMA(50, 50, 50) = 50
    expect(fk[15]).toBeCloseTo(50, 5);
  });

  it("close at top of range gives slow-K near 100 once window fills", () => {
    // 20 bars: all closes at high, so raw-K = 100 always, SMA(100,..)=100
    const h = Array.from({ length: 20 }, () => 10);
    const l = Array.from({ length: 20 }, () => 1);
    const c = Array.from({ length: 20 }, () => 10);
    const { k: tk } = stochastic(h, l, c, 14, 3, 3);
    expect(tk[15]).toBeCloseTo(100, 5);
  });

  it("close at bottom of range gives slow-K near 0 once window fills", () => {
    const h = Array.from({ length: 20 }, () => 10);
    const l = Array.from({ length: 20 }, () => 1);
    const c = Array.from({ length: 20 }, () => 1);
    const { k: tk } = stochastic(h, l, c, 14, 3, 3);
    expect(tk[15]).toBeCloseTo(0, 5);
  });
});
