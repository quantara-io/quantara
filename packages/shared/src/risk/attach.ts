/**
 * attachRiskRecommendation — Phase 7 helper.
 *
 * Callers invoke this BEFORE putSignal so every persisted BlendedSignal
 * carries a risk field. signal-store.ts itself does NOT compute risk inline
 * (separation of concerns — it just persists what it's handed).
 *
 * Usage:
 *   const enriched = attachRiskRecommendation(signal, state, user.riskProfiles, kellyStats);
 *   await putSignal(enriched);
 *
 * Design: Fix 2 of issue #77 / §9.9 of docs/SIGNALS_AND_RISK.md
 */

import type { BlendedSignal } from "../types/signals.js";
import type { IndicatorState } from "../types/indicators.js";
import type { RiskProfileMap, KellyStats } from "../types/risk.js";

import { computeRiskRecommendation } from "./recommend.js";

/**
 * Attach a RiskRecommendation to a BlendedSignal.
 *
 * - For hold signals: sets risk = null without calling computeRiskRecommendation.
 * - For buy/sell signals: calls computeRiskRecommendation with the user's per-pair
 *   profile and optional Kelly stats for (pair, emittingTimeframe, direction).
 *
 * Always returns a new BlendedSignal object (does not mutate the input).
 *
 * @param signal         The BlendedSignal produced by the blender.
 * @param state          IndicatorState for the signal's pair/emittingTimeframe.
 * @param riskProfiles   The user's per-pair risk profile map.
 * @param kellyByPair    Optional map of pair → KellyStats (keyed by pair).
 *                       The caller should already have filtered to the correct
 *                       (pair, timeframe, direction) slice before passing.
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
