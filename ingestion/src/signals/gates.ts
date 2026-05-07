import type { IndicatorState } from "@quantara/shared";
import { VOL_GATE_THRESHOLDS } from "@quantara/shared";
import type { TradingPair } from "../exchanges/config.js";

export type GateReason = "vol" | "dispersion" | "stale";

export interface GateResult {
  fired: boolean;
  reason: GateReason | null;
}

const GATE_NOT_FIRED: GateResult = { fired: false, reason: null };

/**
 * Volatility gate. Fires if realized annualized vol exceeds the per-pair threshold.
 * Returns { fired: false, reason: null } when realizedVolAnnualized is null
 * (warm-up — do not gate on missing data).
 */
export function gateVolatility(state: IndicatorState): GateResult {
  const vol = state.realizedVolAnnualized;
  if (vol === null) return GATE_NOT_FIRED;

  const threshold = VOL_GATE_THRESHOLDS[state.pair as TradingPair];
  if (threshold === undefined) return GATE_NOT_FIRED;

  if (vol > threshold) {
    return { fired: true, reason: "vol" };
  }
  return GATE_NOT_FIRED;
}

/**
 * Cross-exchange dispersion gate. Fires when the (max - min)/median spread
 * across non-stale exchanges exceeds 1% (0.01) sustained for 3 consecutive bars
 * on the timeframe in question.
 *
 * The 3-bar persistence is tracked externally — pass dispersionHistory.
 * Returns { fired: false, reason: null } when state.dispersion is null.
 */
export function gateDispersion(
  state: IndicatorState,
  dispersionHistory: number[], // most recent first, last 3+ bars
): GateResult {
  if (state.dispersion === null) return GATE_NOT_FIRED;

  // Require at least 3 bars of history (most recent first).
  // All 3 most recent values must exceed 0.01.
  const last3 = dispersionHistory.slice(0, 3);
  if (last3.length < 3) return GATE_NOT_FIRED;

  const allExceedThreshold = last3.every((v) => v > 0.01);
  if (allExceedThreshold) {
    return { fired: true, reason: "dispersion" };
  }
  return GATE_NOT_FIRED;
}

/**
 * Stale-data gate. Fires if ≥2 of 3 exchanges have stale=true on their latest tick.
 */
export function gateStale(
  exchangeStaleness: Record<string, boolean>,
): GateResult {
  const staleCount = Object.values(exchangeStaleness).filter(Boolean).length;
  if (staleCount >= 2) {
    return { fired: true, reason: "stale" };
  }
  return GATE_NOT_FIRED;
}

/**
 * Combine the three gates. Returns the first reason that fires, in order: vol, dispersion, stale.
 * Returns { fired: false, reason: null } if none fire.
 */
export function evaluateGates(
  state: IndicatorState,
  dispersionHistory: number[],
  exchangeStaleness: Record<string, boolean>,
): GateResult {
  const volResult = gateVolatility(state);
  if (volResult.fired) return volResult;

  const dispResult = gateDispersion(state, dispersionHistory);
  if (dispResult.fired) return dispResult;

  const staleResult = gateStale(exchangeStaleness);
  if (staleResult.fired) return staleResult;

  return GATE_NOT_FIRED;
}
