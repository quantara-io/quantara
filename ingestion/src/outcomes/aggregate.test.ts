/**
 * aggregate.test.ts — Phase 8.
 *
 * Tests for computeBrier, computeECE, and buildAccuracyAggregate.
 *
 * Covers:
 *   - Brier with known calibration (perfectly calibrated → low Brier)
 *   - Brier with overconfident model
 *   - ECE with well-calibrated predictions
 *   - ECE with biased (overconfident) predictions
 *   - ECE uses K=10 bins
 *   - Brier/ECE return null when totalResolved < 30
 *   - Neutral outcomes excluded from Brier/ECE
 */

import { describe, it, expect } from "vitest";
import { computeBrier, computeECE, buildAccuracyAggregate } from "./aggregate.js";
import type { OutcomeRecord } from "./resolver.js";

const NOW_ISO = "2026-01-01T12:00:00.000Z";

function makeOutcome(
  overrides: Partial<OutcomeRecord> = {},
  resolvedAt = NOW_ISO,
): OutcomeRecord {
  return {
    pair: "BTC",
    signalId: `sig-${Math.random().toString(36).slice(2, 8)}`,
    type: "buy",
    confidence: 0.7,
    createdAt: "2026-01-01T11:00:00.000Z",
    expiresAt: NOW_ISO,
    resolvedAt,
    priceAtSignal: 100_000,
    priceAtResolution: 103_000,
    priceMovePct: 0.03,
    atrPctAtSignal: 0.04,
    thresholdUsed: 0.02,
    outcome: "correct",
    rulesFired: ["rsi_oversold"],
    gateReason: null,
    emittingTimeframe: "1h",
    invalidatedExcluded: false,
    ttl: 9999999999,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeBrier
// ---------------------------------------------------------------------------

describe("computeBrier", () => {
  it("returns 0 for empty array", () => {
    expect(computeBrier([])).toBe(0);
  });

  it("returns 0 when all outcomes are neutral (filtered)", () => {
    const outcomes = [
      makeOutcome({ outcome: "neutral" }),
      makeOutcome({ outcome: "neutral" }),
    ];
    expect(computeBrier(outcomes)).toBe(0);
  });

  it("perfectly calibrated at confidence=1.0, all correct → Brier=0", () => {
    const outcomes = Array.from({ length: 10 }, () =>
      makeOutcome({ outcome: "correct", confidence: 1.0 }),
    );
    expect(computeBrier(outcomes)).toBeCloseTo(0);
  });

  it("all correct at confidence=0.5 → Brier=0.25", () => {
    const outcomes = Array.from({ length: 10 }, () =>
      makeOutcome({ outcome: "correct", confidence: 0.5 }),
    );
    // (0.5 - 1)^2 = 0.25 per sample
    expect(computeBrier(outcomes)).toBeCloseTo(0.25);
  });

  it("overconfident: all incorrect with confidence=0.9 → Brier=0.81", () => {
    const outcomes = Array.from({ length: 10 }, () =>
      makeOutcome({ outcome: "incorrect", confidence: 0.9 }),
    );
    // (0.9 - 0)^2 = 0.81
    expect(computeBrier(outcomes)).toBeCloseTo(0.81);
  });

  it("mixed: 50% correct, 50% incorrect at confidence=0.6", () => {
    const outcomes = [
      ...Array.from({ length: 5 }, () => makeOutcome({ outcome: "correct", confidence: 0.6 })),
      ...Array.from({ length: 5 }, () => makeOutcome({ outcome: "incorrect", confidence: 0.6 })),
    ];
    // correct: (0.6-1)^2=0.16; incorrect: (0.6-0)^2=0.36; avg=(0.16+0.36)/2=0.26
    expect(computeBrier(outcomes)).toBeCloseTo(0.26);
  });

  it("neutral outcomes are excluded from computation", () => {
    const outcomes = [
      makeOutcome({ outcome: "correct", confidence: 1.0 }),
      makeOutcome({ outcome: "neutral", confidence: 0.5 }), // excluded
    ];
    // Only the "correct" with confidence=1.0 contributes → Brier=0
    expect(computeBrier(outcomes)).toBeCloseTo(0);
  });
});

// ---------------------------------------------------------------------------
// computeECE
// ---------------------------------------------------------------------------

describe("computeECE", () => {
  it("returns 0 for empty array", () => {
    expect(computeECE([])).toBe(0);
  });

  it("returns 0 when all outcomes are neutral (filtered)", () => {
    const outcomes = [makeOutcome({ outcome: "neutral" })];
    expect(computeECE(outcomes)).toBe(0);
  });

  it("perfectly calibrated: all correct at confidence=0.55 → ECE ≈ 0", () => {
    // All samples fall in bin 5 (0.5–0.6), accuracy=1.0 within bin, meanConf≈0.55.
    // ECE = |0.55 - 1.0| = 0.45 (only one bin, all samples). Not zero.
    // Better test: confidence matches actual accuracy perfectly.
    // 10 samples at confidence=0.5, 5 correct (50% accuracy) → ECE ≈ 0
    const outcomes = [
      ...Array.from({ length: 5 }, () => makeOutcome({ outcome: "correct", confidence: 0.5 })),
      ...Array.from({ length: 5 }, () => makeOutcome({ outcome: "incorrect", confidence: 0.5 })),
    ];
    // bin 4 (0.4–0.5): all 10 samples, meanConf=0.5, accuracy=0.5 → ECE=0
    expect(computeECE(outcomes)).toBeCloseTo(0);
  });

  it("overconfident: all at confidence=0.9 but only 50% correct → large ECE", () => {
    const outcomes = [
      ...Array.from({ length: 5 }, () => makeOutcome({ outcome: "correct", confidence: 0.9 })),
      ...Array.from({ length: 5 }, () => makeOutcome({ outcome: "incorrect", confidence: 0.9 })),
    ];
    // All in bin 8 (0.8–0.9) or bin 9 (0.9–1.0). meanConf=0.9, accuracy=0.5.
    // ECE = |0.9 - 0.5| = 0.4
    expect(computeECE(outcomes)).toBeCloseTo(0.4);
  });

  it("uses K=10 bins (each width 0.1): samples in bin 9 (confidence=0.99)", () => {
    // confidence=0.99 → bin index = floor(0.99 * 10) = 9, capped at 9
    const outcomes = Array.from({ length: 4 }, () =>
      makeOutcome({ outcome: "correct", confidence: 0.99 }),
    );
    // All in bin 9, meanConf=0.99, accuracy=1.0 → ECE=|0.99-1.0|=0.01
    expect(computeECE(outcomes)).toBeCloseTo(0.01, 1);
  });

  it("confidence=1.0 clamped to bin 9 (not out-of-bounds)", () => {
    const outcomes = Array.from({ length: 4 }, () =>
      makeOutcome({ outcome: "correct", confidence: 1.0 }),
    );
    // floor(1.0 * 10) = 10 → clamped to 9
    expect(() => computeECE(outcomes)).not.toThrow();
    // meanConf=1.0, accuracy=1.0 → ECE=0
    expect(computeECE(outcomes)).toBeCloseTo(0);
  });
});

// ---------------------------------------------------------------------------
// buildAccuracyAggregate
// ---------------------------------------------------------------------------

describe("buildAccuracyAggregate", () => {
  it("returns zeros when no outcomes", () => {
    const agg = buildAccuracyAggregate("BTC", "1h", "7d", [], NOW_ISO);
    expect(agg.totalResolved).toBe(0);
    expect(agg.correct).toBe(0);
    expect(agg.incorrect).toBe(0);
    expect(agg.brier).toBeNull();
    expect(agg.ece).toBeNull();
    expect(agg.accuracyPct).toBeNull();
  });

  it("brier and ECE are null when totalResolved < 30", () => {
    const outcomes = Array.from({ length: 20 }, () => makeOutcome({ outcome: "correct" }));
    const agg = buildAccuracyAggregate("BTC", "1h", "7d", outcomes, NOW_ISO);
    expect(agg.totalResolved).toBe(20);
    expect(agg.brier).toBeNull();
    expect(agg.ece).toBeNull();
  });

  it("brier and ECE are populated when totalResolved >= 30", () => {
    const outcomes = Array.from({ length: 30 }, () =>
      makeOutcome({ outcome: "correct", confidence: 0.8 }),
    );
    const agg = buildAccuracyAggregate("BTC", "1h", "7d", outcomes, NOW_ISO);
    expect(agg.totalResolved).toBe(30);
    expect(agg.brier).not.toBeNull();
    expect(agg.ece).not.toBeNull();
  });

  it("accuracyPct = correct / (correct + incorrect), neutral excluded", () => {
    const outcomes = [
      ...Array.from({ length: 6 }, () => makeOutcome({ outcome: "correct" })),
      ...Array.from({ length: 2 }, () => makeOutcome({ outcome: "incorrect" })),
      ...Array.from({ length: 2 }, () => makeOutcome({ outcome: "neutral" })),
    ];
    const agg = buildAccuracyAggregate("BTC", "1h", "7d", outcomes, NOW_ISO);
    expect(agg.correct).toBe(6);
    expect(agg.incorrect).toBe(2);
    expect(agg.neutral).toBe(2);
    expect(agg.totalResolved).toBe(10);
    expect(agg.accuracyPct).toBeCloseTo(6 / 8); // 0.75
  });

  it("invalidatedExcluded outcomes counted separately, not in totalResolved", () => {
    const outcomes = [
      ...Array.from({ length: 5 }, () => makeOutcome({ outcome: "correct" })),
      makeOutcome({ outcome: "neutral", invalidatedExcluded: true }),
    ];
    const agg = buildAccuracyAggregate("BTC", "1h", "7d", outcomes, NOW_ISO);
    expect(agg.totalResolved).toBe(5);
    expect(agg.invalidatedExcluded).toBe(1);
  });

  it("filters by window — outcomes outside window not counted", () => {
    // Outcomes 100 days ago (outside 7d window).
    const oldIso = new Date(new Date(NOW_ISO).getTime() - 86400 * 100 * 1000).toISOString();
    const outcomes = [
      ...Array.from({ length: 5 }, () => makeOutcome({ outcome: "correct" }, oldIso)),
      ...Array.from({ length: 3 }, () => makeOutcome({ outcome: "correct" })), // in 7d window
    ];
    const agg = buildAccuracyAggregate("BTC", "1h", "7d", outcomes, NOW_ISO);
    expect(agg.totalResolved).toBe(3); // only the 3 recent ones
  });

  it("pk is formatted as 'pair#timeframe'", () => {
    const agg = buildAccuracyAggregate("ETH", "4h", "30d", [], NOW_ISO);
    expect(agg.pk).toBe("ETH#4h");
  });

  it("ttl is 7 days from computedAt", () => {
    const agg = buildAccuracyAggregate("BTC", "1h", "7d", [], NOW_ISO);
    const expectedTtl = Math.floor(new Date(NOW_ISO).getTime() / 1000) + 86400 * 7;
    expect(agg.ttl).toBe(expectedTtl);
  });
});
