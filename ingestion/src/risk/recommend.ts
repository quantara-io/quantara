/**
 * Re-export from @quantara/shared — functions moved there so backend can import.
 * Gap 1 — issue #115.
 *
 * Ingestion code continues to work without any import changes.
 */
export {
  computeRiskRecommendation,
  kellyUnlocked,
  RISK_PCT,
  STOP_MULTIPLIER,
  TP_MULTIPLES,
  MIN_SIZE_PCT,
  PRICE_PREFIX,
  TRAILING_STOP_MULTIPLIER,
} from "@quantara/shared";
