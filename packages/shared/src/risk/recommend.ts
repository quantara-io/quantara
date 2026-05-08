/**
 * Risk recommendation computation — Phase 7 (revised).
 *
 * Computes an advisory RiskRecommendation for a non-hold BlendedSignal,
 * given the user's per-pair risk profile and optional Kelly statistics.
 *
 * Moved to packages/shared so both the backend (read-time attach) and
 * ingestion (tests) can import without cross-workspace references.
 *
 * Design: §9 of docs/SIGNALS_AND_RISK.md
 *
 * Key fixes from the v2 re-scope (#77):
 *   Fix 3 — vol-targeted formula has no upper clamp
 *   Fix 4 — stopDistance (was stopDistanceR)
 *   Fix 5 — sell invalidation wording uses "crosses above" not "closes above"
 *   Fix 6 — KellyStats scoped to (pair, timeframe, direction)
 *   Fix 7 — zero-size recommendations return null
 *   Fix 8 — PRICE_PREFIX constant instead of hard-coded "$"
 */

import type { BlendedSignal } from "../types/signals.js";
import type { IndicatorState } from "../types/indicators.js";
import type { RiskProfile, RiskRecommendation, KellyStats, RiskProfileMap } from "../types/risk.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Currency prefix used in invalidation condition strings. */
export const PRICE_PREFIX = "$";

/**
 * Risk-percent per profile — fraction of account capital risked per trade.
 *   conservative: 0.5%
 *   moderate:     1.0%
 *   aggressive:   2.0%
 */
export const RISK_PCT: Record<RiskProfile, number> = {
  conservative: 0.005,
  moderate: 0.01,
  aggressive: 0.02,
};

/**
 * ATR stop-loss multipliers per profile.
 *   conservative: 1.5×
 *   moderate:     2.0×
 *   aggressive:   3.0×
 */
export const STOP_MULTIPLIER: Record<RiskProfile, number> = {
  conservative: 1.5,
  moderate: 2.0,
  aggressive: 3.0,
};

/**
 * Take-profit R-multiples per profile (TP1, TP2, TP3).
 * Close percentages are constant at 50% / 25% / 25%.
 */
export const TP_MULTIPLES: Record<RiskProfile, [number, number, number]> = {
  conservative: [1, 2, 3],
  moderate: [1, 2, 5],
  aggressive: [1, 3, 8],
};

/** Minimum meaningful position size (0.1%). Below this, return null (Fix 7). */
export const MIN_SIZE_PCT = 0.001;

/** Trailing stop ATR multiplier (§9.5.1). */
export const TRAILING_STOP_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Kelly helpers
// ---------------------------------------------------------------------------

/**
 * Kelly fraction: kelly_f = (p·b − q) / b  where q = 1 − p.
 */
function kellyF(p: number, b: number): number {
  const q = 1 - p;
  return (p * b - q) / b;
}

/**
 * Returns true when the Kelly unlock conditions are met.
 *   n ≥ 50 resolved signals; p ∈ [0.45, 0.65]; b ∈ [0.5, 3.0]
 */
export function kellyUnlocked(stats: KellyStats): boolean {
  return (
    stats.resolved >= 50 &&
    stats.p >= 0.45 &&
    stats.p <= 0.65 &&
    stats.b >= 0.5 &&
    stats.b <= 3.0
  );
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute an advisory RiskRecommendation for a non-hold BlendedSignal.
 *
 * Returns null when signal.type === "hold" or sizePct < MIN_SIZE_PCT.
 */
export function computeRiskRecommendation(
  signal: BlendedSignal,
  state: IndicatorState,
  profile: RiskProfile,
  kelly?: KellyStats,
): RiskRecommendation | null {
  if (signal.type === "hold") return null;

  const atr = state.atr14;
  if (atr === null || atr <= 0) return null;

  const entryPrice = latestClose(state);
  if (entryPrice === null || entryPrice <= 0) return null;

  const multiplier = STOP_MULTIPLIER[profile];
  const stopDistance = atr * multiplier;
  const atrPct = atr / entryPrice;

  let sizePct: number;
  let model: RiskRecommendation["positionSizeModel"];

  if (profile === "conservative") {
    sizePct = RISK_PCT[profile];
    model = "fixed";
  } else if (profile === "aggressive" && kelly !== undefined && kellyUnlocked(kelly)) {
    const kf = kellyF(kelly.p, kelly.b);
    sizePct = 0.25 * Math.max(0, kf);
    model = "kelly";
  } else {
    sizePct = Math.max(0, RISK_PCT[profile] / (atrPct * multiplier));
    model = "vol-targeted";
  }

  if (sizePct < MIN_SIZE_PCT) return null;

  const isBuy = signal.type === "buy";
  const stopLoss = isBuy ? entryPrice - stopDistance : entryPrice + stopDistance;

  const tpMultiples = TP_MULTIPLES[profile];
  const takeProfit = [
    { closePct: 0.5, rMultiple: tpMultiples[0] },
    { closePct: 0.25, rMultiple: tpMultiples[1] },
    { closePct: 0.25, rMultiple: tpMultiples[2] },
  ].map(({ closePct, rMultiple }) => ({
    price: isBuy
      ? entryPrice + stopDistance * rMultiple
      : entryPrice - stopDistance * rMultiple,
    closePct,
    rMultiple,
  }));

  const stopPriceStr = `${PRICE_PREFIX}${stopLoss.toFixed(2)}`;
  const invalidationCondition = isBuy
    ? `Setup invalid if ${signal.pair} crosses below ${stopPriceStr}`
    : `Setup invalid if ${signal.pair} crosses above ${stopPriceStr}`;

  return {
    pair: signal.pair,
    profile,
    positionSizePct: sizePct,
    positionSizeModel: model,
    stopLoss,
    stopDistance,
    takeProfit,
    invalidationCondition,
    trailingStopAfterTP2: { multiplier: TRAILING_STOP_MULTIPLIER, reference: "ATR" },
  };
}

/**
 * Attach a RiskRecommendation to a BlendedSignal.
 *
 * - hold signals: risk = null (no computation).
 * - buy/sell: calls computeRiskRecommendation with the user's per-pair profile.
 *
 * Always returns a new object (does not mutate the input).
 *
 * @param signal         The BlendedSignal from DynamoDB (risk is null as persisted).
 * @param state          IndicatorState for the signal's pair/emittingTimeframe.
 * @param riskProfiles   The user's effective per-pair risk profile map.
 * @param kellyByPair    Optional Kelly stats keyed by pair.
 */
export function attachRiskRecommendation(
  signal: BlendedSignal,
  state: IndicatorState,
  riskProfiles: RiskProfileMap,
  kellyByPair?: Record<string, KellyStats | undefined>,
): BlendedSignal {
  if (signal.type === "hold") {
    return { ...signal, risk: null };
  }

  const profile = riskProfiles[signal.pair as keyof RiskProfileMap];
  const kelly = kellyByPair?.[signal.pair];

  const recommendation = computeRiskRecommendation(signal, state, profile, kelly);
  return { ...signal, risk: recommendation };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function latestClose(state: IndicatorState): number | null {
  const closes = state.history.close;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (c !== null && c > 0) return c;
  }
  return null;
}
