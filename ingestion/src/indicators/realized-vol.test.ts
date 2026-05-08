import { describe, it, expect } from "vitest";

import { realizedVol, BARS_PER_YEAR } from "./realized-vol.js";

function makeCloses(n = 200, seed = 33): number[] {
  let val = 100;
  const closes: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const move = (((s >>> 0) % 201) - 100) / 500;
    val = Math.max(0.01, val + move);
    closes.push(val);
  }
  return closes;
}

describe("realizedVol", () => {
  const closes = makeCloses(200);
  const n = 20;
  const result = realizedVol(closes, "1d", n);

  it("returns aligned series same length as input", () => {
    expect(result).toHaveLength(closes.length);
  });

  it("first N bars are null (need N+1 closes for N returns)", () => {
    for (let i = 0; i <= n; i++) {
      // bars 0..N require N log returns, first available at bar N (needs closes 0..N)
      // Actually first non-null is at bar N (index n).
      expect(result[i < n ? i : i]).toBeDefined();
    }
    // Bars 0..n-1 should be null.
    for (let i = 0; i < n; i++) {
      expect(result[i]).toBeNull();
    }
  });

  it("values from bar N onward are non-null", () => {
    for (let i = n; i < closes.length; i++) {
      expect(result[i]).not.toBeNull();
    }
  });

  it("realized vol is positive", () => {
    for (let i = n; i < closes.length; i++) {
      expect(result[i]!).toBeGreaterThan(0);
    }
  });

  it("annualizes by sqrt(barsPerYear)", () => {
    // With a known constant log return, annualized vol should match formula.
    // Create closes with constant 1% returns.
    const constClose: number[] = [100];
    for (let i = 1; i <= 25; i++) {
      constClose.push(constClose[i - 1] * 1.01);
    }
    const r = realizedVol(constClose, "1d", 20);
    // All log returns are ln(1.01) ≈ 0.00995.
    // Population stdev of 20 identical values is 0.
    // So realized vol should be 0.
    expect(r[20]).toBeCloseTo(0, 8);
  });

  it("higher volatility series → higher realized vol", () => {
    // Low vol: tiny returns
    const lowVol: number[] = [100];
    for (let i = 1; i <= 25; i++) {
      lowVol.push(lowVol[i - 1] * (i % 2 === 0 ? 1.001 : 0.999));
    }

    // High vol: large returns
    const highVol: number[] = [100];
    for (let i = 1; i <= 25; i++) {
      highVol.push(highVol[i - 1] * (i % 2 === 0 ? 1.1 : 0.9));
    }

    const rLow = realizedVol(lowVol, "1d", 20);
    const rHigh = realizedVol(highVol, "1d", 20);
    expect(rHigh[20]!).toBeGreaterThan(rLow[20]!);
  });

  it("BARS_PER_YEAR has correct values", () => {
    expect(BARS_PER_YEAR["1m"]).toBe(525600);
    expect(BARS_PER_YEAR["5m"]).toBe(105120);
    expect(BARS_PER_YEAR["15m"]).toBe(35040);
    expect(BARS_PER_YEAR["1h"]).toBe(8760);
    expect(BARS_PER_YEAR["4h"]).toBe(2190);
    expect(BARS_PER_YEAR["1d"]).toBe(365);
  });
});
