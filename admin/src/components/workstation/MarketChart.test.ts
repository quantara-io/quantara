import { describe, it, expect } from "vitest";

import type { UTCTimestamp, Logical } from "lightweight-charts";

import { fillGaps, computeBackfillExpansion } from "./MarketChart";

// Cast helpers so test fixtures satisfy the Logical branded type
function lr(from: number, to: number) {
  return { from: from as Logical, to: to as Logical };
}

// Helpers to build minimal typed rows ----------------------------------------

function candle(timeSec: number) {
  return {
    time: timeSec as UTCTimestamp,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
  };
}

function vol(timeSec: number) {
  return {
    time: timeSec as UTCTimestamp,
    value: 1,
    color: "green",
  };
}

// True whitespace row has only a `time` field --------------------------------

function isWhitespace(row: { time: unknown }): boolean {
  return Object.keys(row).length === 1 && "time" in row;
}

// ---------------------------------------------------------------------------
// fillGaps: 1h candles with a 5-hour gap → 4 whitespace rows inserted
// ---------------------------------------------------------------------------

describe("fillGaps", () => {
  it("inserts 4 whitespace rows for a 5h gap in 1h candles", () => {
    // Two candles 5 hours apart (5 × 3600 = 18000 s apart).
    // The expected next after t=0 is t=3600; the actual next is t=18000.
    // Missing slots: floor((18000 - 3600) / 3600) = floor(4.0) = 4
    const rows = [candle(0), candle(18000)];
    const result = fillGaps(rows, "1h");

    expect(result).toHaveLength(6); // 2 candles + 4 whitespace
    expect(isWhitespace(result[0])).toBe(false);
    expect(isWhitespace(result[1])).toBe(true);
    expect(isWhitespace(result[2])).toBe(true);
    expect(isWhitespace(result[3])).toBe(true);
    expect(isWhitespace(result[4])).toBe(true);
    expect(isWhitespace(result[5])).toBe(false);
  });

  it("whitespace rows have sequential timestamps matching the step", () => {
    const rows = [candle(0), candle(18000)];
    const result = fillGaps(rows, "1h");

    // Whitespace slots are at t=3600, 7200, 10800, 14400
    expect((result[1] as { time: number }).time).toBe(3600);
    expect((result[2] as { time: number }).time).toBe(7200);
    expect((result[3] as { time: number }).time).toBe(10800);
    expect((result[4] as { time: number }).time).toBe(14400);
  });

  it("passes through rows unchanged when there are no gaps", () => {
    const rows = [candle(0), candle(3600), candle(7200)];
    const result = fillGaps(rows, "1h");
    expect(result).toHaveLength(3);
    result.forEach((r) => expect(isWhitespace(r)).toBe(false));
  });

  it("returns input unchanged for a single-element array", () => {
    const rows = [candle(0)];
    const result = fillGaps(rows, "1h");
    expect(result).toHaveLength(1);
  });

  it("returns input unchanged for an unknown timeframe", () => {
    const rows = [candle(0), candle(99999)];
    const result = fillGaps(rows, "3x"); // not in TIMEFRAME_SEC
    expect(result).toHaveLength(2);
  });

  it("caps whitespace insertion at 5000 rows per gap", () => {
    // A gap of 10 000 steps — should be capped at 5000
    const stepSec = 3600;
    const rows = [candle(0), candle(10001 * stepSec)];
    const result = fillGaps(rows, "1h");
    // 2 original rows + 5000 whitespace = 5002
    expect(result).toHaveLength(5002);
  });

  it("works for 4h candles with a single missing slot (exactly 2x step gap)", () => {
    // step = 14400; next candle is at 2× step → 1 whitespace row
    const rows = [candle(0), candle(28800)];
    const result = fillGaps(rows, "4h");
    expect(result).toHaveLength(3);
    expect(isWhitespace(result[1])).toBe(true);
  });

  it("works with non-candle rows (histogram/volume shape)", () => {
    const rows = [vol(0), vol(18000)];
    const result = fillGaps(rows, "1h");
    expect(result).toHaveLength(6);
    expect(isWhitespace(result[1])).toBe(true);
    expect(isWhitespace(result[4])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeBackfillExpansion
// ---------------------------------------------------------------------------

describe("computeBackfillExpansion", () => {
  const nearEdge = lr(5, 205); // from < 10 → user was near left edge
  const farFromEdge = lr(50, 250); // from >= 10 → user was not at left edge

  it("returns null on initial load (prevCount === 0)", () => {
    expect(computeBackfillExpansion(nearEdge, 0, 200)).toBeNull();
  });

  it("returns null when no new bars were prepended (newCount === prevCount)", () => {
    // live-poll update — bar count stays the same
    expect(computeBackfillExpansion(nearEdge, 200, 200)).toBeNull();
  });

  it("returns null when newCount < prevCount (dedup reduced rows)", () => {
    expect(computeBackfillExpansion(nearEdge, 200, 195)).toBeNull();
  });

  it("returns null when before is null (range not yet available)", () => {
    expect(computeBackfillExpansion(null, 200, 300)).toBeNull();
  });

  it("returns null when user was NOT near left edge (before.from >= 10)", () => {
    expect(computeBackfillExpansion(farFromEdge, 200, 300)).toBeNull();
  });

  it("returns the correct expansion when all conditions are met", () => {
    // 200 → 300: 100 new bars prepended; user was near left edge (from=5)
    const result = computeBackfillExpansion(nearEdge, 200, 300);
    expect(result).not.toBeNull();
    expect(result!.from).toBe(0);
    // to = before.to + newBars = 205 + 100 = 305
    expect(result!.to).toBe(305);
  });

  it("anchors from at 0 regardless of before.from value", () => {
    // even if before.from is 3 (not zero), expansion always starts at 0
    const result = computeBackfillExpansion(lr(3, 100), 50, 100);
    expect(result).not.toBeNull();
    expect(result!.from).toBe(0);
  });

  it("uses exactly the number of new bars for to-anchor shift", () => {
    const result = computeBackfillExpansion(lr(0, 400), 500, 750);
    expect(result).not.toBeNull();
    // newBars = 250; to = 400 + 250 = 650
    expect(result!.to).toBe(650);
  });

  it("boundary: from === 9 (just inside the threshold) triggers expansion", () => {
    const result = computeBackfillExpansion(lr(9, 209), 100, 150);
    expect(result).not.toBeNull();
  });

  it("boundary: from === 10 (exactly at threshold) does NOT trigger expansion", () => {
    const result = computeBackfillExpansion(lr(10, 210), 100, 150);
    expect(result).toBeNull();
  });
});
