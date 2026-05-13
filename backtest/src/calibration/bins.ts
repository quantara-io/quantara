/**
 * calibration/bins.ts — Phase 3 calibration-by-bin computation.
 *
 * Buckets signals into 10 bins of width 0.1 by stated confidence, computes
 * realized win rate per bin, and suppresses bins below MIN_BIN_SAMPLES.
 *
 * Mirrors genie-deepdive.math.ts:computeCalibration so the admin UI can
 * consume these CSVs in a future phase.
 *
 * MIN_BIN_SAMPLES is env-aware (mirrors #357 pattern):
 *   prod  → 10
 *   dev   → 3
 */

import type { BacktestSignal } from "../engine.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Minimum directional samples in a bin before it is included in output.
 * Mirrors backend/src/services/genie-deepdive.math.ts and #357.
 */
export const MIN_BIN_SAMPLES = process.env["ENVIRONMENT"] === "prod" ? 10 : 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalibrationBin {
  /** Lower bound of this bin (inclusive), e.g. 0.5 for the 0.5-0.6 bin. */
  binMin: number;
  /** Upper bound of this bin (exclusive), e.g. 0.6. */
  binMax: number;
  /** Number of directional (non-neutral) resolved signals in this bin. */
  count: number;
  /** Mean stated confidence of signals in this bin. */
  meanConfidence: number;
  /** Realized win rate: correct / (correct + incorrect). */
  realizedWinRate: number;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Compute calibration bins from a list of BacktestSignal records.
 *
 * Only directional (non-neutral, resolved) signals contribute.
 * Returns bins sorted by binMin ascending; bins below MIN_BIN_SAMPLES are suppressed.
 */
export function computeCalibrationBins(signals: BacktestSignal[]): CalibrationBin[] {
  const NUM_BINS = 10;

  const bins: { sumConf: number; correct: number; count: number }[] = Array.from(
    { length: NUM_BINS },
    () => ({ sumConf: 0, correct: 0, count: 0 }),
  );

  for (const sig of signals) {
    if (sig.outcome === null || sig.outcome === "neutral") continue;
    // Directional: correct or incorrect only.

    const idx = Math.min(NUM_BINS - 1, Math.floor(sig.confidence * NUM_BINS));
    bins[idx]!.count += 1;
    bins[idx]!.sumConf += sig.confidence;
    if (sig.outcome === "correct") bins[idx]!.correct += 1;
  }

  const result: CalibrationBin[] = [];
  for (let i = 0; i < NUM_BINS; i++) {
    const b = bins[i]!;
    if (b.count < MIN_BIN_SAMPLES) continue;

    result.push({
      binMin: i * 0.1,
      binMax: (i + 1) * 0.1,
      count: b.count,
      meanConfidence: b.sumConf / b.count,
      realizedWinRate: b.correct / b.count,
    });
  }

  return result;
}
