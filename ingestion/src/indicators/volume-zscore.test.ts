import { describe, it, expect } from "vitest";

import { volumeZscore } from "./volume-zscore.js";

function makeVolume(n = 200, seed = 88): number[] {
  const volumes: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    volumes.push(1000 + ((s >>> 0) % 9000));
  }
  return volumes;
}

describe("volumeZscore", () => {
  const volumes = makeVolume(200);
  const n = 20;
  const result = volumeZscore(volumes, n);

  it("returns aligned series same length as input", () => {
    expect(result).toHaveLength(volumes.length);
  });

  it("first 19 bars are null (20-bar warmup)", () => {
    for (let i = 0; i < 19; i++) {
      expect(result[i]).toBeNull();
    }
  });

  it("values from bar 19 onward are non-null", () => {
    for (let i = 19; i < volumes.length; i++) {
      expect(result[i]).not.toBeNull();
    }
  });

  it("flat volume produces z-score 0 (stdev=0 guard)", () => {
    const flat = Array.from({ length: 25 }, () => 1000);
    const r = volumeZscore(flat, 20);
    for (let i = 19; i < flat.length; i++) {
      expect(r[i]).toBe(0);
    }
  });

  it("volume at mean produces z-score near 0", () => {
    // Sequence: 19 bars of 1000, then 1 bar of 1000 (at mean).
    const vols = Array.from({ length: 25 }, (_, i) =>
      i < 20 ? 1000 : 1000,
    );
    const r = volumeZscore(vols, 20);
    expect(r[19]).toBeCloseTo(0, 5);
  });

  it("volume spike above mean yields positive z-score", () => {
    // 20 bars at 1000, bar 20 at very high volume.
    const vols = [...Array.from({ length: 20 }, () => 1000), 10000];
    const r = volumeZscore(vols, 20);
    expect(r[20]!).toBeGreaterThan(0);
  });

  it("formula: (vol - mean) / stdev (population)", () => {
    // Manual check at bar 19 (first non-null).
    const sub = volumes.slice(0, 20);
    const mean = sub.reduce((a, b) => a + b, 0) / 20;
    const variance = sub.reduce((a, b) => a + (b - mean) ** 2, 0) / 20;
    const stdev = Math.sqrt(variance);
    const expected = stdev === 0 ? 0 : (volumes[19] - mean) / stdev;
    expect(result[19]).toBeCloseTo(expected, 8);
  });
});
