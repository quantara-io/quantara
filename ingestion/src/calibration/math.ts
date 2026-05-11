/**
 * calibration/math.ts — pure math helpers for Phase 8/7 calibration job.
 *
 * Platt scaling (§10.6): fit a = [a, b] via Newton-Raphson so that
 *   P(correct | raw) ≈ σ(a·raw + b)
 * against the resolved binary outcomes for a (pair, TF) slice.
 *
 * Kelly stats (§9.3.1): per (pair, TF, direction), compute
 *   p = correct / (correct + incorrect)
 *   b = mean(positive_R) / mean(|negative_R|)
 * over the resolved cohort for that direction.
 *
 * All functions are pure (no I/O).
 */

import type { OutcomeRecord } from "../outcomes/resolver.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum resolved samples required to fit coefficients. */
export const CALIBRATION_MIN_SAMPLES = 50;

/** Newton-Raphson max iterations for Platt fit. */
const MAX_ITER = 100;

/** Newton-Raphson convergence tolerance (gradient magnitude). */
const GRAD_TOL = 1e-7;

// ---------------------------------------------------------------------------
// Platt scaling
// ---------------------------------------------------------------------------

export interface PlattCoeffs {
  /** Scale parameter for raw confidence. */
  a: number;
  /** Bias parameter. */
  b: number;
  /** Number of samples used to fit. */
  n: number;
  /** ECE before calibration (from raw confidence). */
  eceBefore: number;
  /** ECE after calibration (using calibrated confidence). */
  eceAfter: number;
}

/**
 * Standard sigmoid: σ(x) = 1 / (1 + exp(−x)).
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * ECE with K=10 uniform bins, identical to the aggregator convention (§10 spec).
 */
function computeECE(confs: number[], actuals: number[]): number {
  const K = 10;
  const bins = Array.from({ length: K }, () => ({
    count: 0,
    sumConf: 0,
    correct: 0,
  }));
  for (let i = 0; i < confs.length; i++) {
    const c = confs[i]!;
    const a = actuals[i]!;
    const idx = Math.min(K - 1, Math.floor(c * K));
    bins[idx]!.count++;
    bins[idx]!.sumConf += c;
    bins[idx]!.correct += a;
  }
  let ece = 0;
  for (const b of bins) {
    if (b.count === 0) continue;
    const meanConf = b.sumConf / b.count;
    const accuracy = b.correct / b.count;
    ece += (b.count / confs.length) * Math.abs(meanConf - accuracy);
  }
  return ece;
}

/**
 * Fit Platt scaling coefficients via Newton-Raphson (2-parameter logistic).
 *
 * Minimizes the binary cross-entropy loss:
 *   L(a, b) = −Σ [ y·log(σ(a·x + b)) + (1−y)·log(1−σ(a·x + b)) ]
 *
 * where x = raw_confidence, y ∈ {0, 1} (1 = correct).
 *
 * Neutral outcomes are excluded (only correct / incorrect contribute).
 *
 * Returns null when the slice has fewer than CALIBRATION_MIN_SAMPLES directional outcomes.
 */
export function fitPlattCoeffs(outcomes: OutcomeRecord[]): PlattCoeffs | null {
  const directional = outcomes.filter((o) => o.outcome !== "neutral");
  if (directional.length < CALIBRATION_MIN_SAMPLES) return null;

  const xs = directional.map((o) => o.confidence);
  const ys = directional.map((o) => (o.outcome === "correct" ? 1 : 0));
  const n = directional.length;

  // ECE before calibration (raw confidence vs actual outcomes).
  const eceBefore = computeECE(xs, ys);

  // Newton-Raphson: parameters [a, b], init a=1 b=0 (identity).
  let a = 1.0;
  let b = 0.0;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // Forward pass: compute sigmoid output and residual.
    const ps = xs.map((x) => sigmoid(a * x + b));

    // Gradient: ∂L/∂a = Σ (p_i - y_i)·x_i,  ∂L/∂b = Σ (p_i - y_i)
    let ga = 0;
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const r = ps[i]! - ys[i]!;
      ga += r * xs[i]!;
      gb += r;
    }

    // Hessian diagonal elements (second derivatives):
    // H_aa = Σ p_i(1−p_i)·x_i²,  H_bb = Σ p_i(1−p_i),  H_ab = Σ p_i(1−p_i)·x_i
    let haa = 0;
    let hbb = 0;
    let hab = 0;
    for (let i = 0; i < n; i++) {
      const pq = ps[i]! * (1 - ps[i]!);
      haa += pq * xs[i]! * xs[i]!;
      hbb += pq;
      hab += pq * xs[i]!;
    }

    // Newton step: [a, b] -= H^{-1} · grad
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break; // singular Hessian — stop

    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;

    a -= da;
    b -= db;

    // Convergence check on gradient magnitude.
    if (Math.sqrt(ga * ga + gb * gb) < GRAD_TOL) break;
  }

  // ECE after calibration.
  const calibratedConfs = xs.map((x) => sigmoid(a * x + b));
  const eceAfter = computeECE(calibratedConfs, ys);

  return { a, b, n, eceBefore, eceAfter };
}

/**
 * Apply Platt calibration to a raw confidence score.
 *
 * Returns the raw confidence unchanged when coeffs are null.
 */
export function applyPlattCalibration(rawConfidence: number, coeffs: PlattCoeffs): number {
  return sigmoid(coeffs.a * rawConfidence + coeffs.b);
}

// ---------------------------------------------------------------------------
// Kelly stats
// ---------------------------------------------------------------------------

export interface KellyResult {
  /** Win rate p = correct / (correct + incorrect). */
  p: number;
  /**
   * Odds ratio b = mean(positive_R) / mean(|negative_R|).
   *
   * Positive R comes from correct trades (winner's gain expressed as R-multiple).
   * Negative R comes from incorrect trades (loser's loss expressed as R-multiple).
   *
   * We approximate R-multiple from priceMovePct / thresholdUsed (a 1R proxy):
   *   win:  priceMovePct / thresholdUsed (should be > 1 when correct)
   *   loss: |priceMovePct| / thresholdUsed (should be > 1 when incorrect)
   */
  b: number;
  /** Number of resolved directional outcomes used. */
  resolved: number;
}

/**
 * Compute Kelly stats for a single direction ("buy" | "sell") slice.
 *
 * Neutral and invalidated outcomes are excluded.
 *
 * Returns null when fewer than CALIBRATION_MIN_SAMPLES directional outcomes exist
 * for this direction.
 */
export function computeKellyStats(
  outcomes: OutcomeRecord[],
  direction: "buy" | "sell",
): KellyResult | null {
  // Filter to the requested direction only.
  const directional = outcomes.filter(
    (o) => o.type === direction && o.outcome !== "neutral" && !o.invalidatedExcluded,
  );

  if (directional.length < CALIBRATION_MIN_SAMPLES) return null;

  const correct = directional.filter((o) => o.outcome === "correct");
  const incorrect = directional.filter((o) => o.outcome === "incorrect");

  const p = correct.length / directional.length;

  // Compute b = mean(|priceMovePct|/threshold for wins) / mean(|priceMovePct|/threshold for losses).
  // Fallback to 1.0 if either cohort is empty.
  const winRs = correct.map((o) =>
    o.thresholdUsed > 0 ? Math.abs(o.priceMovePct) / o.thresholdUsed : 1,
  );
  const lossRs = incorrect.map((o) =>
    o.thresholdUsed > 0 ? Math.abs(o.priceMovePct) / o.thresholdUsed : 1,
  );

  const meanWinR = winRs.length > 0 ? winRs.reduce((s, v) => s + v, 0) / winRs.length : 1;
  const meanLossR = lossRs.length > 0 ? lossRs.reduce((s, v) => s + v, 0) / lossRs.length : 1;

  const b = meanLossR > 0 ? meanWinR / meanLossR : meanWinR;

  return { p, b, resolved: directional.length };
}
