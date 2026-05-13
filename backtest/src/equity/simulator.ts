/**
 * equity/simulator.ts — Phase 3 equity-curve simulation.
 *
 * Translates a stream of resolved BacktestSignal records into a PnL time series,
 * applying:
 *   - Position sizing per strategy.sizing (fixed-pct supported; kelly + vol-target
 *     are documented as deferred — see below).
 *   - 15 bps round-trip transaction cost on every directional bet (configurable
 *     via equity/constants.ts: SLIPPAGE_BPS + FEE_BPS, each per-side).
 *   - Running drawdown tracking and Sharpe annualization.
 *
 * Kelly and vol-target sizing are deferred to a future phase. The simulator
 * falls back to DEFAULT_FIXED_PCT for those modes and emits a console.warn so
 * callers know the substitution occurred.
 */

import type { BacktestSignal } from "../engine.js";
import type { Strategy } from "../strategy/types.js";
import type { EquityCurve, EquityPoint, DrawdownPeriod } from "./types.js";
import {
  ROUND_TRIP_COST,
  DEFAULT_FIXED_PCT,
  MIN_POSITION_SIZE,
  MAX_POSITION_SIZE,
  SHARPE_ANNUALIZATION_FACTOR,
  SHARPE_MIN_SIGNALS,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Position sizing
// ---------------------------------------------------------------------------

/**
 * Compute the fractional position size for one signal given the current equity
 * and the strategy's sizing policy.
 *
 * Returns a value in [MIN_POSITION_SIZE, MAX_POSITION_SIZE].
 */
function computePositionSize(sizing: Strategy["sizing"], _currentEquity: number): number {
  let raw: number;

  switch (sizing.kind) {
    case "fixed-pct":
      raw = sizing.pct;
      break;

    case "kelly":
      // Deferred: Kelly fraction requires empirical win-rate + odds-ratio from prior
      // outcomes. Full Kelly sizing will be wired in a future phase. Fall back to
      // kellyFraction × DEFAULT_FIXED_PCT as a conservative placeholder.
      console.warn(
        "[backtest/equity] kelly sizing is deferred — using kellyFraction × 2% as placeholder",
      );
      raw = sizing.kellyFraction * DEFAULT_FIXED_PCT;
      break;

    case "vol-target":
      // Deferred: vol-target requires realized-vol from the recent return series.
      // Full vol-targeting will be wired in a future phase. Fall back to volTarget
      // as a direct fraction (capped by MAX_POSITION_SIZE).
      console.warn(
        "[backtest/equity] vol-target sizing is deferred — using volTarget directly as fraction",
      );
      raw = sizing.volTarget;
      break;
  }

  return Math.max(MIN_POSITION_SIZE, Math.min(MAX_POSITION_SIZE, raw));
}

// ---------------------------------------------------------------------------
// Sharpe
// ---------------------------------------------------------------------------

/**
 * Compute annualized Sharpe ratio from a series of per-bet returns.
 * Returns null if fewer than SHARPE_MIN_SIGNALS observations or std = 0.
 */
function computeSharpe(returns: number[]): number | null {
  if (returns.length < SHARPE_MIN_SIGNALS) return null;
  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return (mean / std) * SHARPE_ANNUALIZATION_FACTOR;
}

// ---------------------------------------------------------------------------
// Drawdown period extraction
// ---------------------------------------------------------------------------

/**
 * Walk the equity points and identify the top-N worst drawdown periods.
 * A period starts when equity drops below the current peak and ends when
 * equity recovers to (or above) that peak.
 */
export function extractDrawdownPeriods(points: EquityPoint[], topN = 3): DrawdownPeriod[] {
  if (points.length === 0) return [];

  const periods: DrawdownPeriod[] = [];
  let peakEquity = points[0]!.equity;
  let peakTs = points[0]!.ts;
  let inDrawdown = false;
  let troughEquity = peakEquity;
  let troughTs = peakTs;

  for (const pt of points) {
    if (pt.equity >= peakEquity) {
      // Recovered (or new high).
      if (inDrawdown) {
        periods.push({
          startTs: peakTs,
          troughTs,
          recoveryTs: pt.ts,
          drawdownPct: (peakEquity - troughEquity) / peakEquity,
        });
        inDrawdown = false;
      }
      peakEquity = pt.equity;
      peakTs = pt.ts;
      troughEquity = pt.equity;
      troughTs = pt.ts;
    } else {
      // In a drawdown.
      inDrawdown = true;
      if (pt.equity < troughEquity) {
        troughEquity = pt.equity;
        troughTs = pt.ts;
      }
    }
  }

  // Ongoing drawdown at end of series.
  if (inDrawdown) {
    periods.push({
      startTs: peakTs,
      troughTs,
      recoveryTs: null,
      drawdownPct: (peakEquity - troughEquity) / peakEquity,
    });
  }

  // Return top-N by magnitude.
  return periods.sort((a, b) => b.drawdownPct - a.drawdownPct).slice(0, topN);
}

// ---------------------------------------------------------------------------
// Main simulator
// ---------------------------------------------------------------------------

/**
 * Simulate the equity curve from a list of resolved BacktestSignal records.
 *
 * Signals that are unresolved (outcome === null) or neutral are included in
 * the signalsToDate count but do not affect equity.
 */
export function simulateEquityCurve(
  signals: BacktestSignal[],
  sizing: Strategy["sizing"],
): EquityCurve {
  // Sort signals chronologically.
  const sorted = [...signals].sort(
    (a, b) => new Date(a.emittedAt).getTime() - new Date(b.emittedAt).getTime(),
  );

  let equity = 1.0;
  let peakEquity = 1.0;
  let troughEquity = 1.0;
  let troughTs = sorted[0]?.emittedAt ?? new Date(0).toISOString();
  let maxDrawdownPct = 0;
  let winsToDate = 0;
  const points: EquityPoint[] = [];
  const perBetReturns: number[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const sig = sorted[i]!;
    const isDirectional =
      sig.type === "buy" ||
      sig.type === "strong-buy" ||
      sig.type === "sell" ||
      sig.type === "strong-sell";
    const isResolved = sig.outcome !== null;

    if (isDirectional && isResolved && sig.outcome !== "neutral") {
      const posSize = computePositionSize(sizing, equity);
      const movePct = sig.priceMovePct ?? 0;
      const signedMove = sig.type === "sell" || sig.type === "strong-sell" ? -movePct : movePct;

      const grossReturn =
        sig.outcome === "correct"
          ? posSize * Math.abs(signedMove)
          : sig.outcome === "incorrect"
            ? -posSize * Math.abs(signedMove)
            : 0;

      // Subtract round-trip transaction cost on every directional bet.
      const netReturn = grossReturn - posSize * ROUND_TRIP_COST;

      equity = equity * (1 + netReturn);
      equity = Math.max(0, equity); // equity can't go negative

      if (sig.outcome === "correct") winsToDate += 1;
      perBetReturns.push(netReturn);
    }

    if (equity > peakEquity) {
      peakEquity = equity;
    }

    const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;

    if (equity < troughEquity) {
      troughEquity = equity;
      troughTs = sig.emittedAt;
    }

    if (drawdownPct > maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
    }

    points.push({
      ts: sig.emittedAt,
      equity,
      drawdownPct,
      signalsToDate: i + 1,
      winsToDate,
    });
  }

  const sharpeAnnualized = computeSharpe(perBetReturns);

  return {
    points,
    peakEquity,
    trough: { ts: troughTs, equity: troughEquity },
    maxDrawdownPct,
    finalEquity: equity,
    sharpeAnnualized,
  };
}
