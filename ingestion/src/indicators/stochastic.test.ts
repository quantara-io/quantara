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

describe("stochastic", () => {
  const { high, low, close } = makeOHLC(200);
  const { k, d } = stochastic(high, low, close);

  it("returns aligned series same length as input", () => {
    expect(k).toHaveLength(close.length);
    expect(d).toHaveLength(close.length);
  });

  it("k is null for first 13 bars (14-bar warmup)", () => {
    for (let i = 0; i < 13; i++) {
      expect(k[i]).toBeNull();
    }
  });

  it("k is non-null from bar 13", () => {
    for (let i = 13; i < close.length; i++) {
      expect(k[i]).not.toBeNull();
    }
  });

  it("k values are in [0, 100]", () => {
    for (let i = 13; i < close.length; i++) {
      expect(k[i]).toBeGreaterThanOrEqual(0);
      expect(k[i]).toBeLessThanOrEqual(100);
    }
  });

  it("d is null for first 15 bars (k warmup 13 + d SMA warmup 2)", () => {
    for (let i = 0; i < 15; i++) {
      expect(d[i]).toBeNull();
    }
  });

  it("d is non-null from bar 15", () => {
    for (let i = 15; i < close.length; i++) {
      expect(d[i]).not.toBeNull();
    }
  });

  it("div-by-zero guard: sets k=50 when high==low", () => {
    const flatHigh = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    const flatLow = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    const flatClose = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    const { k: fk } = stochastic(flatHigh, flatLow, flatClose, 14);
    // Bar 13 is the first non-null bar.
    expect(fk[13]).toBe(50);
  });

  it("close at top of range gives k near 100", () => {
    // All closes at high.
    const h = Array.from({ length: 20 }, () => 10);
    const l = Array.from({ length: 20 }, () => 1);
    const c = Array.from({ length: 20 }, () => 10); // close = high
    const { k: tk } = stochastic(h, l, c, 14);
    expect(tk[13]).toBeCloseTo(100, 5);
  });

  it("close at bottom of range gives k near 0", () => {
    const h = Array.from({ length: 20 }, () => 10);
    const l = Array.from({ length: 20 }, () => 1);
    const c = Array.from({ length: 20 }, () => 1); // close = low
    const { k: tk } = stochastic(h, l, c, 14);
    expect(tk[13]).toBeCloseTo(0, 5);
  });
});
