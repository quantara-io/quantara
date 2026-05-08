import { describe, it, expect } from "vitest";

import { atr, atrUpdate } from "./atr.js";

function makeOHLC(n = 200, seed = 13): {
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
    const spread = 0.2 + ((s >>> 8) % 100) / 100;
    high.push(val + spread / 2);
    low.push(Math.max(0.01, val - spread / 2));
    close.push(val);
  }
  return { high, low, close };
}

describe("atr", () => {
  const { high, low, close } = makeOHLC(200);
  const result = atr(high, low, close);

  it("returns aligned series same length as input", () => {
    expect(result).toHaveLength(close.length);
  });

  it("first 13 bars are null (14-bar Wilder warmup)", () => {
    for (let i = 0; i < 13; i++) {
      expect(result[i]).toBeNull();
    }
  });

  it("values from bar 13 onward are non-null", () => {
    for (let i = 13; i < close.length; i++) {
      expect(result[i]).not.toBeNull();
    }
  });

  it("ATR is always positive", () => {
    for (let i = 13; i < close.length; i++) {
      expect(result[i]).toBeGreaterThan(0);
    }
  });

  it("bar 0 TR = high[0] - low[0] (no previous close)", () => {
    const h = [10, 11, 12];
    const l = [8, 9, 10];
    const c = [9, 10, 11];
    // TR[0] = 10 - 8 = 2 (simple range, no prev close)
    // We test indirectly: ATR with n=1 should equal TR at each bar.
    const r = atr(h, l, c, 1);
    // bar 0: TR=2, ATR=2
    expect(r[0]).toBeCloseTo(2, 10);
    // bar 1: TR = max(11-9, |11-9|, |9-9|) = max(2,2,0) = 2, Wilder(1)=2
    expect(r[1]).toBeCloseTo(2, 10);
  });

  it("wider candles produce larger ATR", () => {
    const n = 20;
    const narrowH = Array.from({ length: n }, () => 101);
    const narrowL = Array.from({ length: n }, () => 99);
    const narrowC = Array.from({ length: n }, () => 100);

    const wideH = Array.from({ length: n }, () => 110);
    const wideL = Array.from({ length: n }, () => 90);
    const wideC = Array.from({ length: n }, () => 100);

    const narrowAtr = atr(narrowH, narrowL, narrowC);
    const wideAtr = atr(wideH, wideL, wideC);
    const lastNarrow = narrowAtr[n - 1]!;
    const lastWide = wideAtr[n - 1]!;
    expect(lastWide).toBeGreaterThan(lastNarrow);
  });
});

describe("atr — empty-input guard", () => {
  it("returns [] (aligned-empty) when input arrays are empty", () => {
    const result = atr([], [], [], 14);
    expect(result).toEqual([]);
  });
});

describe("atr — single-bar-update parity", () => {
  const { high, low, close } = makeOHLC(200);

  it("incremental update matches full recompute at bar 80", () => {
    const fullSeries = atr(high, low, close);

    // Build incremental state: seed ATR at bar 13 from SMA of TR[0..13].
    const trArr: number[] = [];
    trArr.push(high[0] - low[0]);
    for (let i = 1; i <= 13; i++) {
      const hl = high[i] - low[i];
      const hc = Math.abs(high[i] - close[i - 1]);
      const lc = Math.abs(low[i] - close[i - 1]);
      trArr.push(Math.max(hl, hc, lc));
    }
    let atrVal = trArr.reduce((a, b) => a + b, 0) / 14;

    // Advance incrementally bar 14..80.
    for (let i = 14; i <= 80; i++) {
      const upd = atrUpdate(atrVal, high[i], low[i], close[i - 1]);
      atrVal = upd.atr;
    }

    expect(atrVal).toBeCloseTo(fullSeries[80]!, 4);
  });
});
