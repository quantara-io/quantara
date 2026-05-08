/**
 * Risk recommendation computation — Phase 7 (revised).
 *
 * Computes an advisory RiskRecommendation for a non-hold BlendedSignal,
 * given the user's per-pair risk profile and optional Kelly statistics.
 *
 * Design: §9 of docs/SIGNALS_AND_RISK.md
 *
 * Key fixes from the v2 re-scope (#77):
 *   Fix 3 — vol-targeted formula has no upper clamp (Fix 3)
 *   Fix 4 — stopDistance (was stopDistanceR)
 *   Fix 5 — sell invalidation wording uses "crosses above" not "closes above"
 *   Fix 6 — KellyStats scoped to (pair, timeframe, direction)
 *   Fix 7 — zero-size recommendations return null
 *   Fix 8 — PRICE_PREFIX constant instead of hard-coded "$"
 */

import type { BlendedSignal } from "../types/signals.js";
import type { IndicatorState } from "../types/indicators.js";
import type { RiskProfile, RiskRecommendation, KellyStats } from "../types/risk.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Currency prefix used in invalidation condition strings. Single named constant for grep-replaceability. */
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
 *
 * Design: §9.5 of docs/SIGNALS_AND_RISK.md
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
 * Positive when the edge (p·b − q) is positive.
 */
function kellyF(p: number, b: number): number {
  const q = 1 - p;
  return (p * b - q) / b;
}

/**
 * Returns true when the Kelly unlock conditions are met for a stats slice.
 *
 * Conditions (§9.3.1):
 *   n ≥ 50 resolved signals
 *   p ∈ [0.45, 0.65]  (inclusive bounds)
 *   b ∈ [0.5, 3.0]    (inclusive bounds)
 */
export function kellyUnlocked(stats: KellyStats): boolean {
  return (
    stats.resolved >= 50 && stats.p >= 0.45 && stats.p <= 0.65 && stats.b >= 0.5 && stats.b <= 3.0
  );
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute an advisory RiskRecommendation for a non-hold BlendedSignal.
 *
 * Returns null in two cases:
 *   1. signal.type === "hold" (caller should not reach here; handled defensively)
 *   2. Computed sizePct falls below MIN_SIZE_PCT (Fix 7)
 *
 * @param signal     The BlendedSignal being enriched (must be buy or sell).
 * @param state      IndicatorState for the signal's pair/emittingTimeframe.
 * @param profile    The user's risk profile for this pair.
 * @param kelly      Optional KellyStats for (pair, emittingTimeframe, direction).
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

  // --- Entry price: median of non-stale exchange prices from latest signal data.
  // Fallback: use close from indicator state history.
  const entryPrice = latestClose(state);
  if (entryPrice === null || entryPrice <= 0) return null;

  const multiplier = STOP_MULTIPLIER[profile];
  const stopDistance = atr * multiplier;
  const atrPct = atr / entryPrice;

  // --- Position sizing (§9.3)
  let sizePct: number;
  let model: RiskRecommendation["positionSizeModel"];

  if (profile === "conservative") {
    // Conservative: always fixed-fractional
    sizePct = RISK_PCT[profile];
    model = "fixed";
  } else if (profile === "aggressive" && kelly !== undefined && kellyUnlocked(kelly)) {
    // Aggressive with Kelly unlocked: 0.25 × kelly_f (no extra × RISK_PCT scaling)
    const kf = kellyF(kelly.p, kelly.b);
    sizePct = 0.25 * Math.max(0, kf);
    model = "kelly";
  } else {
    // Moderate (and aggressive pre-Kelly-unlock): vol-targeted
    // Formula: sizePct = RISK_PCT[profile] / (atrPct × multiplier)
    // No upper clamp — the formula is dimensionally correct (Fix 3).
    // Lower clamp to 0 only as a safety against negative ATR (shouldn't happen).
    sizePct = Math.max(0, RISK_PCT[profile] / (atrPct * multiplier));
    model = "vol-targeted";
  }

  // Fix 7: zero-size suppression
  if (sizePct < MIN_SIZE_PCT) return null;

  // --- Stop levels (§9.4)
  const isBuy = signal.type === "buy";
  const stopLoss = isBuy ? entryPrice - stopDistance : entryPrice + stopDistance;

  // --- Take-profit levels (§9.5)
  const tpMultiples = TP_MULTIPLES[profile];
  const takeProfit = [
    { closePct: 0.5, rMultiple: tpMultiples[0] },
    { closePct: 0.25, rMultiple: tpMultiples[1] },
    { closePct: 0.25, rMultiple: tpMultiples[2] },
  ].map(({ closePct, rMultiple }) => ({
    price: isBuy ? entryPrice + stopDistance * rMultiple : entryPrice - stopDistance * rMultiple,
    closePct,
    rMultiple,
  }));

  // --- Invalidation condition (§9.5, Fix 5)
  // Sell: "setup invalid if {pair} crosses above ${stop_price}" (not "closes above")
  // Buy:  "setup invalid if {pair} crosses below ${stop_price}"
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the latest available close price from the indicator state history.
 * Returns the most recent non-null close, or null if none available.
 */
function latestClose(state: IndicatorState): number | null {
  const closes = state.history.close;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (c !== null && c > 0) return c;
  }
  return null;
}
