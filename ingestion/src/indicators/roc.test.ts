import { describe, it, expect } from "vitest";
import { roc } from "./roc.js";

function makeCloses(n = 200, seed = 55): number[] {
  let val = 100;
  const closes: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const move = ((s >>> 0) % 201 - 100) / 200;
    val = Math.max(1, val + move);
    closes.push(val);
  }
  return closes;
}

describe("roc", () => {
  const closes = makeCloses(200);
  const n = 10;
  const result = roc(closes, n);

  it("returns aligned series same length as input", () => {
    expect(result).toHaveLength(closes.length);
  });

  it("bars 0..N-1 are null", () => {
    for (let i = 0; i < n; i++) {
      expect(result[i]).toBeNull();
    }
  });

  it("bars N onward are non-null", () => {
    for (let i = n; i < closes.length; i++) {
      expect(result[i]).not.toBeNull();
    }
  });

  it("formula: (close[t] - close[t-N]) / close[t-N]", () => {
    for (let i = n; i < closes.length; i++) {
      const expected = (closes[i] - closes[i - n]) / closes[i - n];
      expect(result[i]).toBeCloseTo(expected, 10);
    }
  });

  it("ROC returns proportion, not percentage (e.g. 0.05 not 5)", () => {
    const flat = [100, 105];
    const r = roc(flat, 1);
    expect(r[1]).toBeCloseTo(0.05, 10);
  });

  it("5% gain → ROC = 0.05", () => {
    const c = [100, 100, 100, 100, 105]; // 5 bars, N=4
    const r = roc(c, 4);
    expect(r[4]).toBeCloseTo(0.05, 10);
  });

  it("returns null when close[t-N] is 0", () => {
    const c = [0, 0, 0, 0, 5];
    const r = roc(c, 4);
    expect(r[4]).toBeNull();
  });
});
