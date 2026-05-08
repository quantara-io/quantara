/**
 * Accuracy aggregator — Phase 8 (§10).
 *
 * Computes per-(pair, timeframe) accuracy metrics over rolling 7d / 30d / 90d
 * windows: accuracy %, Brier score, and ECE (Expected Calibration Error).
 *
 * Brier and ECE are only populated when totalResolved >= 30 (too few points
 * produce noisy calibration estimates).
 *
 * ECE uses K=10 uniform bins of width 0.1 (§10 spec).
 */

import type { OutcomeRecord } from "./resolver.js";

export type AccuracyWindow = "7d" | "30d" | "90d";

export interface AccuracyAggregate {
  /** Composite PK: "pair#timeframe". */
  pk: string;
  pair: string;
  timeframe: string;
  window: AccuracyWindow;
  totalResolved: number;
  correct: number;
  incorrect: number;
  neutral: number;
  /** Count of invalidated signals excluded from totalResolved. */
  invalidatedExcluded: number;
  /** correct / (correct + incorrect); neutral and invalidated excluded.  null if no directional outcomes. */
  accuracyPct: number | null;
  /** Brier score — null if totalResolved < 30. */
  brier: number | null;
  /** Expected Calibration Error — null if totalResolved < 30. */
  ece: number | null;
  computedAt: string;
  /** computedAt + 7 days (Unix seconds). */
  ttl: number;
}

const BRIER_MIN_SAMPLES = 30;
const ECE_BIN_COUNT = 10;
const TTL_SECONDS = 86400 * 7;

const WINDOW_MS: Record<AccuracyWindow, number> = {
  "7d": 86400 * 7 * 1000,
  "30d": 86400 * 30 * 1000,
  "90d": 86400 * 90 * 1000,
};

/**
 * Compute Brier score for a set of outcome records.
 * Neutral outcomes are excluded (only correct / incorrect contribute).
 *
 * Brier = (1/N) Σ (confidence − actual)²
 * where actual = 1 for "correct", 0 for "incorrect".
 */
export function computeBrier(outcomes: OutcomeRecord[]): number {
  const filtered = outcomes.filter((o) => o.outcome !== "neutral");
  if (filtered.length === 0) return 0;
  const sum = filtered.reduce(
    (s, o) => s + (o.confidence - (o.outcome === "correct" ? 1 : 0)) ** 2,
    0,
  );
  return sum / filtered.length;
}

/**
 * Compute Expected Calibration Error using K=10 uniform bins of width 0.1.
 *
 * ECE = Σ_k (|B_k| / N) × |mean_confidence(B_k) − accuracy(B_k)|
 *
 * Neutral outcomes are excluded.
 */
export function computeECE(outcomes: OutcomeRecord[]): number {
  const filtered = outcomes.filter((o) => o.outcome !== "neutral");
  if (filtered.length === 0) return 0;

  const bins = Array.from({ length: ECE_BIN_COUNT }, () => ({
    count: 0,
    sumConfidence: 0,
    correct: 0,
  }));

  for (const o of filtered) {
    const idx = Math.min(ECE_BIN_COUNT - 1, Math.floor(o.confidence * ECE_BIN_COUNT));
    bins[idx]!.count++;
    bins[idx]!.sumConfidence += o.confidence;
    if (o.outcome === "correct") bins[idx]!.correct++;
  }

  let ece = 0;
  for (const b of bins) {
    if (b.count === 0) continue;
    const meanConf = b.sumConfidence / b.count;
    const accuracy = b.correct / b.count;
    ece += (b.count / filtered.length) * Math.abs(meanConf - accuracy);
  }
  return ece;
}

/**
 * Build an AccuracyAggregate from a set of outcome records for one (pair, timeframe) bucket.
 *
 * @param pair        Trading pair.
 * @param timeframe   Emitting timeframe.
 * @param window      Rolling window size.
 * @param outcomes    All outcome records for this bucket, already filtered to the window.
 * @param nowIso      Current time (ISO8601); defaults to now.
 */
export function buildAccuracyAggregate(
  pair: string,
  timeframe: string,
  window: AccuracyWindow,
  outcomes: OutcomeRecord[],
  nowIso: string = new Date().toISOString(),
): AccuracyAggregate {
  const nowMs = new Date(nowIso).getTime();
  const windowStart = new Date(nowMs - WINDOW_MS[window]).toISOString();

  // Filter to window.
  const inWindow = outcomes.filter((o) => !o.invalidatedExcluded && o.resolvedAt >= windowStart);

  const invalidatedExcluded = outcomes.filter(
    (o) => o.invalidatedExcluded && o.resolvedAt >= windowStart,
  ).length;

  const correct = inWindow.filter((o) => o.outcome === "correct").length;
  const incorrect = inWindow.filter((o) => o.outcome === "incorrect").length;
  const neutral = inWindow.filter((o) => o.outcome === "neutral").length;
  const totalResolved = inWindow.length;

  const directional = correct + incorrect;
  const accuracyPct = directional > 0 ? correct / directional : null;

  const brier = totalResolved >= BRIER_MIN_SAMPLES ? computeBrier(inWindow) : null;
  const ece = totalResolved >= BRIER_MIN_SAMPLES ? computeECE(inWindow) : null;

  const ttl = Math.floor(new Date(nowIso).getTime() / 1000) + TTL_SECONDS;

  return {
    pk: `${pair}#${timeframe}`,
    pair,
    timeframe,
    window,
    totalResolved,
    correct,
    incorrect,
    neutral,
    invalidatedExcluded,
    accuracyPct,
    brier,
    ece,
    computedAt: nowIso,
    ttl,
  };
}
