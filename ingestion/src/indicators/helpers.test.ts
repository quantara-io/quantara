import { describe, it, expect } from "vitest";

import {
  sma,
  ema,
  wilderSmooth,
  linearRegressionSlope,
} from "./helpers.js";

/**
 * 50-bar fixture: [1, 2, 3, ..., 50].
 * With N=10 this gives clean hand-computable reference values.
 */
const FIXTURE = Array.from({ length: 50 }, (_, i) => i + 1);
const N = 10;

// Hand-computed seeds.
// SMA seed (index 9) = (1+2+...+10)/10 = 55/10 = 5.5
const SMA_SEED = 5.5;
// SMA at last bar (index 49) = (41+...+50)/10 = 455/10 = 45.5
const SMA_LAST = 45.5;

describe("sma", () => {
  it("returns an array of the same length as input", () => {
    const result = sma(FIXTURE, N);
    expect(result).toHaveLength(FIXTURE.length);
  });

  it("warm-up bars (0..N-2) are null", () => {
    const result = sma(FIXTURE, N);
    for (let i = 0; i < N - 1; i++) {
      expect(result[i], `index ${i} should be null`).toBeNull();
    }
  });

  it("first warm-up-complete bar equals hand-computed SMA seed", () => {
    const result = sma(FIXTURE, N);
    expect(result[N - 1]).toBeCloseTo(SMA_SEED, 10);
  });

  it("last bar equals hand-computed SMA", () => {
    const result = sma(FIXTURE, N);
    expect(result[49]).toBeCloseTo(SMA_LAST, 10);
  });

  it("does not mutate the input array", () => {
    const input = [...FIXTURE];
    sma(input, N);
    expect(input).toEqual(FIXTURE);
  });

  it("returns all-null for input shorter than n", () => {
    const result = sma([1, 2, 3], 10);
    expect(result.every((v) => v === null)).toBe(true);
  });
});

describe("ema", () => {
  it("returns an array of the same length as input", () => {
    const result = ema(FIXTURE, N);
    expect(result).toHaveLength(FIXTURE.length);
  });

  it("warm-up bars (0..N-2) are null", () => {
    const result = ema(FIXTURE, N);
    for (let i = 0; i < N - 1; i++) {
      expect(result[i], `index ${i} should be null`).toBeNull();
    }
  });

  it("seed at index N-1 equals SMA of first N bars", () => {
    const result = ema(FIXTURE, N);
    expect(result[N - 1]).toBeCloseTo(SMA_SEED, 10);
  });

  it("first recursive bar (index N) equals hand-computed EMA", () => {
    // alpha = 2 / (10 + 1) = 2/11
    // EMA[10] = alpha * 11 + (1 - alpha) * 5.5
    //         = (2/11) * 11 + (9/11) * 5.5
    //         = 2 + 4.5 = 6.5
    const alpha = 2 / (N + 1);
    const expected = alpha * 11 + (1 - alpha) * SMA_SEED;
    const result = ema(FIXTURE, N);
    expect(result[N]).toBeCloseTo(expected, 10);
    expect(result[N]).toBeCloseTo(6.5, 10);
  });

  it("EMA is monotonically increasing for a rising series", () => {
    // For a monotonically rising series, each EMA value should exceed the previous one.
    const result = ema(FIXTURE, N);
    for (let i = N; i < FIXTURE.length; i++) {
      expect(
        (result[i] as number) > (result[i - 1] as number),
        `EMA[${i}] should be > EMA[${i - 1}]`,
      ).toBe(true);
    }
  });

  it("does not mutate the input array", () => {
    const input = [...FIXTURE];
    ema(input, N);
    expect(input).toEqual(FIXTURE);
  });

  it("returns all-null for input shorter than n", () => {
    const result = ema([1, 2, 3], 10);
    expect(result.every((v) => v === null)).toBe(true);
  });
});

describe("wilderSmooth", () => {
  it("returns an array of the same length as input", () => {
    const result = wilderSmooth(FIXTURE, N);
    expect(result).toHaveLength(FIXTURE.length);
  });

  it("warm-up bars (0..N-2) are null", () => {
    const result = wilderSmooth(FIXTURE, N);
    for (let i = 0; i < N - 1; i++) {
      expect(result[i], `index ${i} should be null`).toBeNull();
    }
  });

  it("seed at index N-1 equals SMA of first N bars", () => {
    const result = wilderSmooth(FIXTURE, N);
    expect(result[N - 1]).toBeCloseTo(SMA_SEED, 10);
  });

  it("first recursive bar (index N) matches Wilder formula", () => {
    // avg[N] = (avg[N-1] * (N-1) + values[N]) / N
    //        = (5.5 * 9 + 11) / 10 = (49.5 + 11) / 10 = 60.5 / 10 = 6.05
    const expected = (SMA_SEED * (N - 1) + FIXTURE[N]) / N;
    const result = wilderSmooth(FIXTURE, N);
    expect(result[N]).toBeCloseTo(expected, 10);
    expect(result[N]).toBeCloseTo(6.05, 10);
  });

  it("successive bars satisfy the recurrence relation exactly", () => {
    const result = wilderSmooth(FIXTURE, N);
    for (let i = N; i < FIXTURE.length; i++) {
      const prev = result[i - 1] as number;
      const expected = (prev * (N - 1) + FIXTURE[i]) / N;
      expect(result[i]).toBeCloseTo(expected, 10);
    }
  });

  it("does not mutate the input array", () => {
    const input = [...FIXTURE];
    wilderSmooth(input, N);
    expect(input).toEqual(FIXTURE);
  });

  it("returns all-null for input shorter than n", () => {
    const result = wilderSmooth([1, 2, 3], 10);
    expect(result.every((v) => v === null)).toBe(true);
  });
});

describe("linearRegressionSlope", () => {
  it("returns an array of the same length as input", () => {
    const result = linearRegressionSlope(FIXTURE, N);
    expect(result).toHaveLength(FIXTURE.length);
  });

  it("warm-up bars (0..N-2) are null", () => {
    const result = linearRegressionSlope(FIXTURE, N);
    for (let i = 0; i < N - 1; i++) {
      expect(result[i], `index ${i} should be null`).toBeNull();
    }
  });

  it("slope is 1.0 for every trailing window of an arithmetic-sequence fixture", () => {
    // For [k, k+1, ..., k+N-1], OLS slope on x=[0..N-1] is exactly 1.
    const result = linearRegressionSlope(FIXTURE, N);
    for (let i = N - 1; i < FIXTURE.length; i++) {
      expect(result[i]).toBeCloseTo(1.0, 10);
    }
  });

  it("slope is 0.0 for a constant series", () => {
    const constant = new Array(20).fill(42);
    const result = linearRegressionSlope(constant, N);
    for (let i = N - 1; i < constant.length; i++) {
      expect(result[i]).toBeCloseTo(0.0, 10);
    }
  });

  it("slope is negative for a strictly descending series", () => {
    const descending = Array.from({ length: 30 }, (_, i) => 30 - i);
    const result = linearRegressionSlope(descending, N);
    for (let i = N - 1; i < descending.length; i++) {
      expect((result[i] as number) < 0).toBe(true);
      expect(result[i]).toBeCloseTo(-1.0, 10);
    }
  });

  it("does not mutate the input array", () => {
    const input = [...FIXTURE];
    linearRegressionSlope(input, N);
    expect(input).toEqual(FIXTURE);
  });

  it("returns all-null for input shorter than n", () => {
    const result = linearRegressionSlope([1, 2, 3], 10);
    expect(result.every((v) => v === null)).toBe(true);
  });
});
