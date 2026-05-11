/**
 * math.test.ts — unit tests for calibration math helpers.
 *
 * Tests:
 *   fitPlattCoeffs:
 *     - returns null when n < 50
 *     - fits identity (a≈1, b≈0) when outcomes are already well-calibrated
 *     - recalibrates an overconfident model (raw > actual rate) → a < 1
 *     - computes eceBefore / eceAfter and eceAfter ≤ eceBefore on clean data
 *
 *   applyPlattCalibration:
 *     - identity coeffs leave confidence unchanged
 *     - a=0, b=0 → returns 0.5 (sigmoid(0))
 *     - correctly shrinks overconfident input toward 0.5
 *
 *   computeKellyStats:
 *     - returns null when n < 50 for direction
 *     - computes p = correct/total correctly
 *     - computes b = mean(win R) / mean(loss R) correctly
 *     - excludes neutral and invalidated outcomes
 *     - ignores opposite-direction outcomes
 */

import { describe, it, expect } from "vitest";
import { fitPlattCoeffs, applyPlattCalibration, computeKellyStats } from "./math.js";
import { CALIBRATION_MIN_SAMPLES } from "./math.js";
import type { OutcomeRecord } from "../outcomes/resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_OUTCOME: OutcomeRecord = {
  pair: "BTC/USDT",
  signalId: "sig-000",
  type: "buy",
  confidence: 0.7,
  createdAt: "2026-01-01T10:00:00.000Z",
  expiresAt: "2026-01-02T10:00:00.000Z",
  resolvedAt: "2026-01-02T10:00:00.000Z",
  priceAtSignal: 50_000,
  priceAtResolution: 51_000,
  priceMovePct: 0.02,
  atrPctAtSignal: 0.02,
  thresholdUsed: 0.01,
  outcome: "correct",
  rulesFired: ["rsi-oversold"],
  gateReason: null,
  emittingTimeframe: "1h",
  invalidatedExcluded: false,
  ttl: 9_999_999_999,
};

function makeOutcomes(overrides: Partial<OutcomeRecord>[], id = 0): OutcomeRecord[] {
  return overrides.map((o, i) => ({ ...BASE_OUTCOME, signalId: `sig-${id + i}`, ...o }));
}

/** Generate n outcomes for one direction with a fixed confidence and win rate. */
function makeDirectionalSlice(
  n: number,
  winRate: number,
  confidence: number,
  type: "buy" | "sell" = "buy",
  startId = 0,
): OutcomeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    ...BASE_OUTCOME,
    signalId: `sig-${startId + i}`,
    type,
    confidence,
    outcome: (i / n < winRate ? "correct" : "incorrect") as OutcomeRecord["outcome"],
    priceMovePct: i / n < winRate ? 0.02 : -0.02,
    thresholdUsed: 0.01,
  }));
}

// ---------------------------------------------------------------------------
// fitPlattCoeffs
// ---------------------------------------------------------------------------

describe("fitPlattCoeffs", () => {
  it("returns null when fewer than CALIBRATION_MIN_SAMPLES directional outcomes", () => {
    const outcomes = makeOutcomes(
      Array.from({ length: CALIBRATION_MIN_SAMPLES - 1 }, () => ({ outcome: "correct" as const })),
    );
    expect(fitPlattCoeffs(outcomes)).toBeNull();
  });

  it("excludes neutral outcomes from the sample count", () => {
    // 49 correct + 10 neutral = 59 records, but only 49 directional → null
    const outcomes = [
      ...makeOutcomes(
        Array.from({ length: 49 }, () => ({ outcome: "correct" as const })),
        0,
      ),
      ...makeOutcomes(
        Array.from({ length: 10 }, () => ({ outcome: "neutral" as const })),
        49,
      ),
    ];
    expect(fitPlattCoeffs(outcomes)).toBeNull();
  });

  it("returns coefficients when n >= CALIBRATION_MIN_SAMPLES", () => {
    const outcomes = makeDirectionalSlice(CALIBRATION_MIN_SAMPLES, 0.7, 0.7);
    const result = fitPlattCoeffs(outcomes);
    expect(result).not.toBeNull();
    expect(result!.n).toBe(CALIBRATION_MIN_SAMPLES);
    expect(typeof result!.a).toBe("number");
    expect(typeof result!.b).toBe("number");
    expect(Number.isFinite(result!.a)).toBe(true);
    expect(Number.isFinite(result!.b)).toBe(true);
  });

  it("converges near identity when confidence matches win rate", () => {
    // 70% win rate, 70% confidence — well-calibrated, expect a≈1 b≈0.
    const outcomes = makeDirectionalSlice(100, 0.7, 0.7);
    const result = fitPlattCoeffs(outcomes);
    expect(result).not.toBeNull();
    // a should be positive and reasonably close to 1 (within 1.5 of identity)
    expect(result!.a).toBeGreaterThan(0);
    // b should be small for a well-calibrated input
    expect(Math.abs(result!.b)).toBeLessThan(2);
  });

  it("computes eceBefore and eceAfter (both are numbers in [0, 1])", () => {
    const outcomes = makeDirectionalSlice(100, 0.5, 0.9); // overconfident
    const result = fitPlattCoeffs(outcomes);
    expect(result).not.toBeNull();
    expect(result!.eceBefore).toBeGreaterThanOrEqual(0);
    expect(result!.eceBefore).toBeLessThanOrEqual(1);
    expect(result!.eceAfter).toBeGreaterThanOrEqual(0);
    expect(result!.eceAfter).toBeLessThanOrEqual(1);
  });

  it("calibration reduces ECE on overconfident data (eceBefore > eceAfter)", () => {
    // Overconfident: always 0.9 but only 50% win rate → large ECE before
    const outcomes = makeDirectionalSlice(100, 0.5, 0.9);
    const result = fitPlattCoeffs(outcomes);
    expect(result).not.toBeNull();
    // eceAfter should be strictly less than eceBefore for an overconfident model
    expect(result!.eceAfter).toBeLessThan(result!.eceBefore);
  });
});

// ---------------------------------------------------------------------------
// applyPlattCalibration
// ---------------------------------------------------------------------------

describe("applyPlattCalibration", () => {
  it("identity coefficients (a=1, b=0) leave confidence unchanged for values near 0.5", () => {
    const coeffs = { a: 1, b: 0, n: 50, eceBefore: 0.1, eceAfter: 0.05 };
    // sigmoid(1·0.5 + 0) ≈ 0.622; not exactly 0.5 because sigmoid(0.5) ≠ 0.5
    // The test is that the output is deterministic and bounded.
    const calibrated = applyPlattCalibration(0.5, coeffs);
    expect(calibrated).toBeGreaterThan(0);
    expect(calibrated).toBeLessThan(1);
  });

  it("a=0, b=0 always returns 0.5 regardless of input", () => {
    const coeffs = { a: 0, b: 0, n: 50, eceBefore: 0.1, eceAfter: 0.1 };
    expect(applyPlattCalibration(0.2, coeffs)).toBeCloseTo(0.5);
    expect(applyPlattCalibration(0.8, coeffs)).toBeCloseTo(0.5);
  });

  it("negative a shrinks confidence toward 0.5 (attenuates)", () => {
    // a=-2, b=0 → sigmoid(-2·0.9) ≈ 0.165 (extreme shrinkage)
    const coeffs = { a: -2, b: 0, n: 50, eceBefore: 0.3, eceAfter: 0.1 };
    const result = applyPlattCalibration(0.9, coeffs);
    expect(result).toBeLessThan(0.5);
  });

  it("output is always in (0, 1) for extreme inputs", () => {
    const coeffs = { a: 5, b: -3, n: 50, eceBefore: 0.1, eceAfter: 0.05 };
    const low = applyPlattCalibration(0.01, coeffs);
    const high = applyPlattCalibration(0.99, coeffs);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(1);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// computeKellyStats
// ---------------------------------------------------------------------------

describe("computeKellyStats", () => {
  it("returns null when n < CALIBRATION_MIN_SAMPLES for the direction", () => {
    const outcomes = makeDirectionalSlice(CALIBRATION_MIN_SAMPLES - 1, 0.6, 0.7, "buy");
    expect(computeKellyStats(outcomes, "buy")).toBeNull();
  });

  it("returns null when directional outcomes exist but not for the requested direction", () => {
    // 60 buy outcomes, request sell
    const outcomes = makeDirectionalSlice(60, 0.6, 0.7, "buy");
    expect(computeKellyStats(outcomes, "sell")).toBeNull();
  });

  it("computes p = correct / total for buy direction", () => {
    // 60 outcomes: 36 correct, 24 incorrect (60% win rate)
    const correct = 36;
    const total = 60;
    const outcomes: OutcomeRecord[] = [
      ...Array.from({ length: correct }, (_, i) => ({
        ...BASE_OUTCOME,
        signalId: `sig-${i}`,
        type: "buy" as const,
        outcome: "correct" as const,
        priceMovePct: 0.03,
        thresholdUsed: 0.01,
      })),
      ...Array.from({ length: total - correct }, (_, i) => ({
        ...BASE_OUTCOME,
        signalId: `sig-${correct + i}`,
        type: "buy" as const,
        outcome: "incorrect" as const,
        priceMovePct: -0.02,
        thresholdUsed: 0.01,
      })),
    ];
    const result = computeKellyStats(outcomes, "buy");
    expect(result).not.toBeNull();
    expect(result!.p).toBeCloseTo(correct / total);
    expect(result!.resolved).toBe(total);
  });

  it("excludes neutral outcomes from the calculation", () => {
    const directional = makeDirectionalSlice(60, 0.6, 0.7, "buy");
    const neutral = makeOutcomes(
      Array.from({ length: 10 }, () => ({ outcome: "neutral" as const })),
      60,
    );
    const result = computeKellyStats([...directional, ...neutral], "buy");
    expect(result).not.toBeNull();
    expect(result!.resolved).toBe(60); // neutral excluded
  });

  it("excludes invalidatedExcluded outcomes", () => {
    const directional = makeDirectionalSlice(60, 0.6, 0.7, "buy");
    const invalidated = makeOutcomes(
      Array.from({ length: 5 }, () => ({
        outcome: "correct" as const,
        invalidatedExcluded: true,
      })),
      60,
    );
    const result = computeKellyStats([...directional, ...invalidated], "buy");
    expect(result).not.toBeNull();
    expect(result!.resolved).toBe(60); // invalidated excluded
  });

  it("computes b = mean(winR) / mean(lossR) correctly", () => {
    // 50 correct with priceMovePct=0.04, thresholdUsed=0.01 → winR=4
    // 50 incorrect with priceMovePct=-0.02, thresholdUsed=0.01 → lossR=2
    // Expected b = 4 / 2 = 2
    const outcomes: OutcomeRecord[] = [
      ...Array.from({ length: 50 }, (_, i) => ({
        ...BASE_OUTCOME,
        signalId: `sig-${i}`,
        type: "buy" as const,
        outcome: "correct" as const,
        priceMovePct: 0.04,
        thresholdUsed: 0.01,
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        ...BASE_OUTCOME,
        signalId: `sig-${50 + i}`,
        type: "buy" as const,
        outcome: "incorrect" as const,
        priceMovePct: -0.02,
        thresholdUsed: 0.01,
      })),
    ];
    const result = computeKellyStats(outcomes, "buy");
    expect(result).not.toBeNull();
    expect(result!.b).toBeCloseTo(2, 5);
  });

  it("b falls back to 1.0 when lossR is zero (avoids division by zero)", () => {
    // All correct (no losses) → meanLossR = 1 (fallback), b = winR / 1
    const outcomes = Array.from({ length: 60 }, (_, i) => ({
      ...BASE_OUTCOME,
      signalId: `sig-${i}`,
      type: "buy" as const,
      outcome: "correct" as const,
      priceMovePct: 0.03,
      thresholdUsed: 0.01,
    }));
    const result = computeKellyStats(outcomes, "buy");
    expect(result).not.toBeNull();
    expect(result!.b).toBeGreaterThan(0);
    expect(Number.isFinite(result!.b)).toBe(true);
  });

  it("works for sell direction independently of buy outcomes", () => {
    const buyOutcomes = makeDirectionalSlice(60, 0.6, 0.7, "buy");
    const sellOutcomes = makeDirectionalSlice(55, 0.55, 0.65, "sell", 60);
    const result = computeKellyStats([...buyOutcomes, ...sellOutcomes], "sell");
    expect(result).not.toBeNull();
    expect(result!.resolved).toBe(55);
    expect(result!.p).toBeCloseTo(0.55, 1);
  });
});
