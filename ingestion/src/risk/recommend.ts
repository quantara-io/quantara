/**
 * Risk recommendation computation — re-exports from @quantara/shared.
 *
 * The canonical implementation was moved to packages/shared/src/risk/recommend.ts
 * (issue #87) so both the backend (read-time attach) and ingestion can use it
 * without cross-workspace references.
 *
 * This file re-exports everything so existing ingestion-internal imports
 * (ingestion/src/risk/attach.ts, tests) continue to work unchanged.
 *
 * Design: §9 of docs/SIGNALS_AND_RISK.md
 */

export {
  computeRiskRecommendation,
  attachRiskRecommendation,
  kellyUnlocked,
  RISK_PCT,
  STOP_MULTIPLIER,
  TP_MULTIPLES,
  MIN_SIZE_PCT,
  TRAILING_STOP_MULTIPLIER,
  PRICE_PREFIX,
} from "@quantara/shared";
