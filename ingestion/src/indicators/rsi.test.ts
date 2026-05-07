import { describe, it, expect } from "vitest";
import { rsi, rsiUpdate } from "./rsi.js";

// Deterministic 200-bar close series: seeded random walk starting at 100.
function makeCloses(n = 200, seed = 42): number[] {
  let val = 100;
  const closes: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    // LCG pseudo-random: gives deterministic +/- moves
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const move = ((s >>> 0) % 201 - 100) / 100; // [-1, +1]
    val = Math.max(1, val + move);
    closes.push(val);
  }
  return closes;
}

describe("rsi", () => {
  const closes = makeCloses(200);
  const result = rsi(closes);

  it("returns aligned series same length as input", () => {
    expect(result).toHaveLength(closes.length);
  });

  it("first 14 bars are null (need n+1 values for first RS)", () => {
    for (let i = 0; i < 14; i++) {
      expect(result[i]).toBeNull();
    }
  });

  it("values from bar 14 onward are non-null", () => {
    for (let i = 14; i < closes.length; i++) {
      expect(result[i]).not.toBeNull();
    }
  });

  it("RSI values are in [0, 100]", () => {
    for (let i = 14; i < closes.length; i++) {
      const v = result[i]!;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("all-up market produces RSI near 100", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const r = rsi(up);
    const lastNonNull = r.filter((v) => v !== null).pop();
    expect(lastNonNull).toBeGreaterThan(95);
  });

  it("all-down market produces RSI near 0", () => {
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    const r = rsi(down);
    const lastNonNull = r.filter((v) => v !== null).pop();
    expect(lastNonNull).toBeLessThan(5);
  });

  it("short series (< 15 bars) returns all null", () => {
    const short = makeCloses(14);
    const r = rsi(short);
    r.forEach((v) => expect(v).toBeNull());
  });
});

describe("rsi — single-bar-update parity", () => {
  const closes = makeCloses(200);

  it("incremental update matches recomputed RSI at arbitrary bar i", () => {
    // Recompute full series.
    const fullSeries = rsi(closes);

    // Build incremental state up to bar 30 (first non-null + some bars).
    // We need the avgGain and avgLoss at bar 14 (first non-null bar).
    // We'll extract them by manually replaying Wilder's RMA for the first 15 bars.

    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      gains.push(d > 0 ? d : 0);
      losses.push(d < 0 ? -d : 0);
    }
    // Seed: SMA of first 14 gains/losses.
    let avgGain = gains.reduce((a, b) => a + b, 0) / 14;
    let avgLoss = losses.reduce((a, b) => a + b, 0) / 14;

    // Incrementally advance to bar 80.
    for (let i = 15; i <= 80; i++) {
      const updated = rsiUpdate(avgGain, avgLoss, closes[i], closes[i - 1]);
      avgGain = updated.avgGain;
      avgLoss = updated.avgLoss;
    }

    // The incremental RSI at bar 80.
    const incrRsi =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    expect(incrRsi).toBeCloseTo(fullSeries[80]!, 4);
  });
});
