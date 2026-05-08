/**
 * attachRiskRecommendation — Phase 7 helper.
 *
 * Callers at read time (backend route) look up the user's riskProfiles and
 * call this to enrich a persisted BlendedSignal (which always has risk: null).
 *
 * The implementation lives in packages/shared/src/risk/recommend.ts (moved
 * in issue #87 so the backend can also import it without cross-workspace refs).
 * This file re-exports via ./recommend.js so ingestion-internal mocks in tests
 * continue to work — the mock of "./recommend.js" intercepts the call.
 *
 * Design: Fix 2 of issue #77 / §9.9 of docs/SIGNALS_AND_RISK.md
 */

import type {
  BlendedSignal,
  IndicatorState,
  RiskProfileMap,
  KellyStats,
} from "@quantara/shared";
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
 * @param signal         The BlendedSignal produced by the blender (or fetched from DDB).
 * @param state          IndicatorState for the signal's pair/emittingTimeframe.
 * @param riskProfiles   The user's effective per-pair risk profile map.
 * @param kellyByPair    Optional map of pair → KellyStats (keyed by pair).
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
