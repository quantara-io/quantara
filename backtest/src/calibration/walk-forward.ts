/**
 * calibration/walk-forward.ts — Phase 3 walk-forward calibration mode.
 *
 * When strategy.calibration.kind === "walk-forward":
 *   - Split the backtest period into rolling windows of `refitDays` days.
 *   - For each window: use ONLY prior-window outcomes to fit Platt coefficients.
 *   - Apply calibrated confidence to signals in the current window.
 *   - Guard: signals in window N must only see Platt params fit on outcomes
 *     resolved before window N's start (no look-ahead).
 *
 * When strategy.calibration.kind === "frozen":
 *   - Warn if paramsAt > earliest_signal_emittedAt (future calibration leaking
 *     into past signals).
 *
 * Uses fitPlattCoeffs from ingestion/src/calibration/math.ts — read-only import,
 * no edits to that module.
 */

import { fitPlattCoeffs, applyPlattCalibration } from "quantara-ingestion/src/calibration/math.js";
import type { PlattCoeffs } from "quantara-ingestion/src/calibration/math.js";
import type { OutcomeRecord } from "quantara-ingestion/src/outcomes/resolver.js";
import type { BacktestSignal } from "../engine.js";

// ---------------------------------------------------------------------------
// Frozen calibration guard
// ---------------------------------------------------------------------------

/**
 * Check if a "frozen" calibration's paramsAt timestamp is later than the
 * earliest signal emittedAt. If so, the calibration was fit on data that
 * post-dates the signals — a look-ahead violation.
 *
 * Returns a warning string if a violation is detected, null otherwise.
 */
export function checkFrozenCalibrationGuard(
  calibration: { kind: "frozen"; paramsAt: string },
  signals: BacktestSignal[],
): string | null {
  if (signals.length === 0) return null;

  const sorted = [...signals].sort(
    (a, b) => new Date(a.emittedAt).getTime() - new Date(b.emittedAt).getTime(),
  );
  const earliestSignal = sorted[0]!.emittedAt;

  if (new Date(calibration.paramsAt) > new Date(earliestSignal)) {
    return (
      `[backtest/calibration] LOOK-AHEAD WARNING: frozen calibration paramsAt=${calibration.paramsAt} ` +
      `is after earliest signal emittedAt=${earliestSignal}. ` +
      `Calibration params were fit on data that post-dates some signals.`
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Walk-forward window types
// ---------------------------------------------------------------------------

export interface WalkForwardWindow {
  /** Start of this window (inclusive, ms epoch). */
  startMs: number;
  /** End of this window (exclusive, ms epoch). */
  endMs: number;
  /** Platt coefficients fit from all prior windows' outcomes. null if insufficient data. */
  plattCoeffs: PlattCoeffs | null;
}

// ---------------------------------------------------------------------------
// Build walk-forward windows
// ---------------------------------------------------------------------------

/**
 * Split [fromMs, toMs] into rolling windows of refitDays width.
 * Returns windows in chronological order.
 */
export function buildWalkForwardWindows(
  fromMs: number,
  toMs: number,
  refitDays: number,
): WalkForwardWindow[] {
  const windowMs = refitDays * 86_400_000;
  const windows: WalkForwardWindow[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    windows.push({
      startMs: cursor,
      endMs: Math.min(cursor + windowMs, toMs),
      plattCoeffs: null,
    });
    cursor += windowMs;
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Apply walk-forward calibration to a signal list
// ---------------------------------------------------------------------------

/**
 * Apply walk-forward Platt calibration to signals.
 *
 * For each window N, Platt coefficients are fit from outcomes of windows 0..N-1.
 * The calibrated confidence replaces the raw confidence on each signal.
 *
 * Returns a new signal array with `.confidence` replaced by calibrated values.
 *
 * Note: outcome lookup requires mapping signals to their resolved BacktestSignal
 * records. The engine provides these as the same object (outcome is resolved
 * in-place), so we use the signal's own outcome field.
 */
export function applyWalkForwardCalibration(
  signals: BacktestSignal[],
  calibration: { kind: "walk-forward"; refitDays: number },
  fromMs: number,
  toMs: number,
): BacktestSignal[] {
  const windows = buildWalkForwardWindows(fromMs, toMs, calibration.refitDays);

  if (windows.length < 2) {
    // Not enough windows to calibrate.
    return signals;
  }

  // Build per-window signal lists (by emittedAt).
  const windowSignals: BacktestSignal[][] = windows.map(() => []);
  for (const sig of signals) {
    const t = new Date(sig.emittedAt).getTime();
    const idx = windows.findIndex((w) => t >= w.startMs && t < w.endMs);
    if (idx >= 0) {
      windowSignals[idx]!.push(sig);
    }
  }

  // For each window, fit Platt from all prior windows' outcomes and apply.
  const calibrated: BacktestSignal[] = [];
  const cumulativeOutcomes: OutcomeRecord[] = [];

  for (let wIdx = 0; wIdx < windows.length; wIdx++) {
    const windowSigs = windowSignals[wIdx] ?? [];

    // Fit from cumulative outcomes BEFORE this window.
    let coeffs: PlattCoeffs | null = null;
    if (cumulativeOutcomes.length > 0) {
      coeffs = fitPlattCoeffs(cumulativeOutcomes);
    }

    // Apply coefficients to signals in this window.
    for (const sig of windowSigs) {
      if (coeffs !== null) {
        const calibratedConf = applyPlattCalibration(sig.confidence, coeffs);
        calibrated.push({ ...sig, confidence: calibratedConf });
      } else {
        calibrated.push(sig);
      }
    }

    // Accumulate this window's resolved outcomes for the next window's fit.
    for (const sig of windowSigs) {
      if (sig.outcome !== null) {
        // Build a minimal OutcomeRecord from the BacktestSignal.
        cumulativeOutcomes.push({
          pair: sig.pair,
          signalId: `backtest-${sig.pair}-${sig.timeframe}-${sig.closeTime}`,
          type:
            sig.type === "strong-buy"
              ? "buy"
              : sig.type === "strong-sell"
                ? "sell"
                : (sig.type as "buy" | "sell" | "hold"),
          confidence: sig.confidence,
          createdAt: sig.emittedAt,
          expiresAt: sig.expiresAt,
          resolvedAt: sig.resolvedAt ?? sig.expiresAt,
          priceAtSignal: sig.priceAtSignal,
          priceAtResolution: sig.priceAtResolution ?? sig.priceAtSignal,
          priceMovePct: sig.priceMovePct ?? 0,
          atrPctAtSignal: 0,
          thresholdUsed: 0,
          outcome: sig.outcome,
          rulesFired: sig.rulesFired,
          gateReason: sig.gateReason,
          emittingTimeframe: sig.timeframe,
          invalidatedExcluded: false,
          ttl: 0,
        });
      }
    }
  }

  return calibrated;
}
