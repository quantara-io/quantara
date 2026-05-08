/**
 * Risk recommendation engine — Phase 7.
 *
 * Produces a RiskRecommendation (position size %, ATR-based stop, R-multiple TPs,
 * trailing stop spec) for every non-hold BlendedSignal, parameterized by the
 * user's per-pair risk profile.
 *
 * Design: §9 of docs/SIGNALS_AND_RISK.md
 */

import type {
  BlendedSignal,
  IndicatorState,
  RiskRecommendation,
  RiskProfile,
} from "@quantara/shared";
import {
  RISK_PCT,
  STOP_MULTIPLIER_ATR,
  TP_R_MULTIPLES,
  TP_CLOSE_PCT,
  TRAILING_STOP_ATR_MULTIPLIER,
  KELLY_UNLOCK,
} from "@quantara/shared";

export interface KellyStats {
  resolved: number;
  p: number; // accuracy (win rate)
  b: number; // avg win / avg loss in R-multiples
}

/**
 * Check whether Kelly sizing is unlocked for the given stats.
 *
 * Conditions (all must be true):
 *   - resolved ≥ 50
 *   - p ∈ [0.45, 0.65]
 *   - b ∈ [0.5, 3.0]
 */
export function isKellyUnlocked(stats: KellyStats | undefined): boolean {
  if (!stats) return false;
  return (
    stats.resolved >= KELLY_UNLOCK.minResolved &&
    stats.p >= KELLY_UNLOCK.pMin &&
    stats.p <= KELLY_UNLOCK.pMax &&
    stats.b >= KELLY_UNLOCK.bMin &&
    stats.b <= KELLY_UNLOCK.bMax
  );
}

/**
 * Compute the fractional Kelly f:
 *   f = (p * b - (1 - p)) / b
 * Capped at KELLY_UNLOCK.fractionalCap (25%).
 */
function kellyFraction(stats: KellyStats): number {
  const { p, b } = stats;
  const f = (p * b - (1 - p)) / b;
  return Math.min(KELLY_UNLOCK.fractionalCap, Math.max(0, f));
}

/**
 * Compute the risk recommendation for a non-hold BlendedSignal.
 *
 * Returns null if signal.type === "hold" (no recommendation needed).
 *
 * Sizing model selection:
 *   - conservative  → fixed-fractional always
 *   - moderate      → vol-targeted by default
 *   - aggressive    → vol-targeted by default; Kelly if unlock conditions met
 *
 * @param signal     The blended signal (must be non-hold for a recommendation to be produced).
 * @param state      Current IndicatorState — provides ATR14 and the latest close price.
 * @param profile    The user's risk profile for this pair.
 * @param kellyStats Optional trade-outcome stats; if absent or unlock not met, falls back.
 */
export function computeRiskRecommendation(
  signal: BlendedSignal,
  state: IndicatorState,
  profile: RiskProfile,
  kellyStats?: KellyStats,
): RiskRecommendation | null {
  // Step 1: hold signals need no recommendation.
  if (signal.type === "hold") return null;

  // Step 2: resolve entry price from the most recent close in indicator history.
  // history.close[0] is the current (most recent) bar close.
  const entryPrice =
    state.history.close[0] !== null && state.history.close[0] !== undefined
      ? (state.history.close[0] as number)
      : null;

  if (entryPrice === null || entryPrice <= 0) return null;

  const atr = state.atr14;
  if (atr === null || atr <= 0) return null;

  const direction = signal.type; // "buy" | "sell"
  const isBuy = direction === "buy";

  // Step 3: compute stop.
  const multiplier = STOP_MULTIPLIER_ATR[profile];
  const stopDistance = atr * multiplier;
  const stopLoss = isBuy ? entryPrice - stopDistance : entryPrice + stopDistance;

  // Step 4: sizing model selection.
  let positionSizeModel: "fixed" | "vol-targeted" | "kelly";
  let positionSizePct: number;

  if (profile === "conservative") {
    positionSizeModel = "fixed";
    positionSizePct = RISK_PCT["conservative"];
  } else if (profile === "aggressive" && isKellyUnlocked(kellyStats)) {
    positionSizeModel = "kelly";
    const kf = kellyFraction(kellyStats!);
    // Position size = Kelly fraction scaled by base risk pct.
    // Hard cap at 25% × RISK_PCT["aggressive"].
    positionSizePct = kf * RISK_PCT["aggressive"];
    // Additional safety: never exceed 2× the profile's base risk pct.
    positionSizePct = Math.min(positionSizePct, RISK_PCT["aggressive"] * 2);
  } else {
    // moderate (always) and aggressive (fallback when Kelly not unlocked): vol-targeted.
    positionSizeModel = "vol-targeted";
    // vol-targeted: RISK_PCT[profile] / (atrPct × multiplier), clamped to [0, RISK_PCT[profile] × 2].
    const atrPct = atr / entryPrice;
    const rawSize = RISK_PCT[profile] / (atrPct * multiplier);
    positionSizePct = Math.max(0, Math.min(rawSize, RISK_PCT[profile] * 2));
  }

  // Step 5: compute take-profit levels.
  const rMultiples = TP_R_MULTIPLES[profile]; // [r1, r2, r3]
  const takeProfit = rMultiples.map((rMultiple, i) => {
    const tpPrice = isBuy
      ? entryPrice + stopDistance * rMultiple
      : entryPrice - stopDistance * rMultiple;
    return {
      price: tpPrice,
      closePct: TP_CLOSE_PCT[i],
      rMultiple,
    };
  });

  // Step 6: build human-readable invalidation condition.
  const stopFormatted = formatPrice(stopLoss);
  const pairBase = signal.pair.split("/")[0] ?? signal.pair;
  const atrMultiplierStr = multiplier.toString();
  const invalidationCondition = isBuy
    ? `Stop hit at $${stopFormatted} (${pairBase} trades below ${atrMultiplierStr}× ATR from entry)`
    : `Setup invalid if ${pairBase} closes above $${stopFormatted} (${atrMultiplierStr}× ATR above entry)`;

  // Step 7: return the recommendation.
  return {
    pair: signal.pair,
    profile,
    positionSizePct,
    positionSizeModel,
    stopLoss,
    stopDistanceR: stopDistance,
    takeProfit,
    invalidationCondition,
    trailingStopAfterTP2: { multiplier: TRAILING_STOP_ATR_MULTIPLIER, reference: "ATR" },
  };
}

/**
 * Format a price as a locale-style string with up to 2 decimal places.
 * e.g. 79210.5 → "79,210.50"
 */
function formatPrice(price: number): string {
  return price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
