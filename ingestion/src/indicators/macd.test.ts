import { describe, it, expect } from "vitest";
import { macd, macdUpdate } from "./macd.js";

function makeCloses(n = 200, seed = 99): number[] {
  let val = 100;
  const closes: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const move = ((s >>> 0) % 201 - 100) / 100;
    val = Math.max(1, val + move);
    closes.push(val);
  }
  return closes;
}

describe("macd", () => {
  const closes = makeCloses(200);
  const { line, signal, hist } = macd(closes);

  it("returns series aligned to close length", () => {
    expect(line).toHaveLength(closes.length);
    expect(signal).toHaveLength(closes.length);
    expect(hist).toHaveLength(closes.length);
  });

  it("macdLine is null for first 25 bars (26-bar EMA warmup)", () => {
    for (let i = 0; i < 25; i++) {
      expect(line[i]).toBeNull();
    }
  });

  it("macdLine is non-null from bar 25", () => {
    for (let i = 25; i < closes.length; i++) {
      expect(line[i]).not.toBeNull();
    }
  });

  it("signal is null for first 33 bars (25 + 8 additional)", () => {
    for (let i = 0; i < 33; i++) {
      expect(signal[i]).toBeNull();
    }
  });

  it("signal is non-null from bar 33", () => {
    for (let i = 33; i < closes.length; i++) {
      expect(signal[i]).not.toBeNull();
    }
  });

  it("hist = line - signal where both non-null", () => {
    for (let i = 33; i < closes.length; i++) {
      expect(hist[i]).toBeCloseTo(line[i]! - signal[i]!, 10);
    }
  });

  it("hist is null where signal is null", () => {
    for (let i = 0; i < 33; i++) {
      expect(hist[i]).toBeNull();
    }
  });
});

describe("macd — single-bar-update parity", () => {
  const closes = makeCloses(200);

  it("incremental update matches full recompute at bar 100", () => {
    const { line, signal, hist } = macd(closes);

    // Build EMA state incrementally.
    // EMA(12) and EMA(26) seed at bar 11 and 25 respectively.
    // We'll replicate from bar 25 onward.
    const alpha12 = 2 / 13;
    const alpha26 = 2 / 27;

    // Seed EMA12 at bar 11 with SMA(12).
    let emaFast = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    for (let i = 12; i <= 25; i++) {
      emaFast = alpha12 * closes[i] + (1 - alpha12) * emaFast;
    }

    // Seed EMA26 at bar 25 with SMA(26).
    let emaSlow = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;

    // MACD line starts at bar 25.
    let macdLine0 = emaFast - emaSlow;

    // We need 9 MACD values to seed signal EMA at bar 33.
    // Collect macdLine values for bars 25..33.
    const macdSeedVals: number[] = [macdLine0];
    for (let i = 26; i <= 33; i++) {
      emaFast = alpha12 * closes[i] + (1 - alpha12) * emaFast;
      emaSlow = alpha26 * closes[i] + (1 - alpha26) * emaSlow;
      macdSeedVals.push(emaFast - emaSlow);
    }

    // Seed signal EMA with SMA of first 9 MACD values.
    let signalEma =
      macdSeedVals.slice(0, 9).reduce((a, b) => a + b, 0) / 9;

    // Update emaFast/emaSlow to match bar 33 state after seeding.
    // (they're already at bar 33 from the loop above)

    // Advance incrementally bar 34..100.
    for (let i = 34; i <= 100; i++) {
      const upd = macdUpdate(emaFast, emaSlow, signalEma, closes[i]);
      emaFast = upd.emaFast;
      emaSlow = upd.emaSlow;
      signalEma = upd.signalEma!;
    }

    const incrMacdLine = emaFast - emaSlow;
    const incrSignal = signalEma;
    const incrHist = incrMacdLine - incrSignal;

    expect(incrMacdLine).toBeCloseTo(line[100]!, 4);
    expect(incrSignal).toBeCloseTo(signal[100]!, 4);
    expect(incrHist).toBeCloseTo(hist[100]!, 4);
  });
});
