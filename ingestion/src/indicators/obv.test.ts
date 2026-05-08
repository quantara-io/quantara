import { describe, it, expect } from "vitest";

import { obv, obvUpdate } from "./obv.js";

function makeClosesVolume(
  n = 200,
  seed = 77,
): {
  close: number[];
  volume: number[];
} {
  let val = 100;
  const close: number[] = [];
  const volume: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const move = (((s >>> 0) % 201) - 100) / 300;
    val = Math.max(1, val + move);
    close.push(val);
    volume.push(1000 + ((s >>> 4) % 5000));
  }
  return { close, volume };
}

describe("obv", () => {
  const { close, volume } = makeClosesVolume(200);
  const { obv: obvArr, obvSlope } = obv(close, volume);

  it("obv series has same length as input", () => {
    expect(obvArr).toHaveLength(close.length);
  });

  it("obvSlope series has same length as input", () => {
    expect(obvSlope).toHaveLength(close.length);
  });

  it("OBV[0] = 0", () => {
    expect(obvArr[0]).toBe(0);
  });

  it("OBV is fully populated (no null)", () => {
    for (const v of obvArr) {
      expect(v).not.toBeNull();
    }
  });

  it("formula: up day adds volume", () => {
    const c = [10, 11, 12]; // all up
    const v = [100, 200, 300];
    const { obv: o } = obv(c, v);
    expect(o[0]).toBe(0);
    expect(o[1]).toBe(200); // +200
    expect(o[2]).toBe(500); // +300
  });

  it("formula: down day subtracts volume", () => {
    const c = [12, 11, 10]; // all down
    const v = [100, 200, 300];
    const { obv: o } = obv(c, v);
    expect(o[0]).toBe(0);
    expect(o[1]).toBe(-200);
    expect(o[2]).toBe(-500);
  });

  it("flat day (no change in close) contributes 0", () => {
    const c = [10, 10, 10];
    const v = [100, 200, 300];
    const { obv: o } = obv(c, v);
    expect(o[0]).toBe(0);
    expect(o[1]).toBe(0);
    expect(o[2]).toBe(0);
  });

  it("obvSlope is null for first 9 bars (10-bar warmup)", () => {
    for (let i = 0; i < 9; i++) {
      expect(obvSlope[i]).toBeNull();
    }
  });

  it("obvSlope is non-null from bar 9", () => {
    for (let i = 9; i < close.length; i++) {
      expect(obvSlope[i]).not.toBeNull();
    }
  });
});

describe("obv — single-bar-update parity", () => {
  const { close, volume } = makeClosesVolume(200);

  it("incremental update matches full recompute at bar 100", () => {
    const { obv: fullObv } = obv(close, volume);

    let incrObv = 0;
    for (let i = 1; i <= 100; i++) {
      incrObv = obvUpdate(incrObv, close[i], close[i - 1], volume[i]);
    }

    expect(incrObv).toBe(fullObv[100]);
  });
});
