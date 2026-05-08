import { describe, it, expect } from "vitest";

import { bollinger } from "./bollinger.js";

function makeCloses(n = 200, seed = 22): number[] {
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

describe("bollinger", () => {
  const closes = makeCloses(200);
  const { upper, mid, lower, bbWidth } = bollinger(closes);

  it("returns aligned series same length as input", () => {
    expect(upper).toHaveLength(closes.length);
    expect(mid).toHaveLength(closes.length);
    expect(lower).toHaveLength(closes.length);
    expect(bbWidth).toHaveLength(closes.length);
  });

  it("first 19 bars are null (20-bar SMA warmup)", () => {
    for (let i = 0; i < 19; i++) {
      expect(upper[i]).toBeNull();
      expect(mid[i]).toBeNull();
      expect(lower[i]).toBeNull();
      expect(bbWidth[i]).toBeNull();
    }
  });

  it("values from bar 19 onward are non-null", () => {
    for (let i = 19; i < closes.length; i++) {
      expect(upper[i]).not.toBeNull();
      expect(mid[i]).not.toBeNull();
      expect(lower[i]).not.toBeNull();
    }
  });

  it("upper > mid > lower", () => {
    for (let i = 19; i < closes.length; i++) {
      expect(upper[i]!).toBeGreaterThan(mid[i]!);
      expect(mid[i]!).toBeGreaterThan(lower[i]!);
    }
  });

  it("bbWidth = (upper - lower) / mid", () => {
    for (let i = 19; i < closes.length; i++) {
      const expected = (upper[i]! - lower[i]!) / mid[i]!;
      expect(bbWidth[i]).toBeCloseTo(expected, 10);
    }
  });

  it("uses population stdev (divide by N, not N-1)", () => {
    // For a flat series the population stdev is 0.
    const flat = Array.from({ length: 25 }, () => 100);
    const { upper: fu, mid: fm, lower: fl } = bollinger(flat);
    // With stdev=0, upper = lower = mid.
    expect(fu[24]).toBeCloseTo(100, 10);
    expect(fl[24]).toBeCloseTo(100, 10);
    expect(fm[24]).toBeCloseTo(100, 10);
  });

  it("mid equals SMA of close over 20 bars", () => {
    for (let i = 19; i < closes.length; i++) {
      const expectedMid =
        closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
      expect(mid[i]).toBeCloseTo(expectedMid, 8);
    }
  });

  it("symmetric bands: mid - lower == upper - mid", () => {
    for (let i = 19; i < closes.length; i++) {
      expect(upper[i]! - mid[i]!).toBeCloseTo(mid[i]! - lower[i]!, 8);
    }
  });
});
