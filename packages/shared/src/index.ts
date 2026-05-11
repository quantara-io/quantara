export type * from "./types/blend.js";
export {
  BLEND_PROFILES,
  defaultBlendProfiles,
  getBlendProfile,
  mergeTierBlendProfiles,
} from "./types/blend.js";
export type * from "./types/tiers.js";
export type * from "./types/signal-tags.js";
export type * from "./types/signals.js";
export type * from "./types/users.js";
export type * from "./types/risk.js";
export type * from "./types/deals.js";
export type * from "./types/coach.js";
export type * from "./types/api.js";
export type * from "./types/ingestion.js";
export type * from "./types/indicators.js";
export type * from "./types/rules.js";
export type * from "./types/events.js";

export { TIER_IDS } from "./types/tiers.js";
export { SIGNAL_TYPES } from "./types/signals.js";
export { SIGNAL_TAGS } from "./types/signal-tags.js";
export { USER_TYPES } from "./types/users.js";
export { defaultRiskProfiles, mergeTierRiskProfiles } from "./types/users.js";
export { DEAL_TYPES, DEAL_SORT_OPTIONS } from "./types/deals.js";

export { TIMEFRAMES } from "./types/ingestion.js";

export { TIER_DEFINITIONS } from "./constants/tiers.js";
export {
  SIGNAL_COLORS,
  ADVISORY_DISCLAIMER,
  VOLATILITY_BANNER,
  RULES,
  MIN_CONFLUENCE,
  STRONG_CONFLUENCE,
  STRONG_NET_MARGIN,
} from "./constants/signals.js";
export { PAIRS, type TradingPair } from "./constants/pairs.js";
export { VOL_GATE_THRESHOLDS } from "./constants/vol-gates.js";
export {
  HAIKU_INPUT_PRICE_PER_M,
  HAIKU_OUTPUT_PRICE_PER_M,
  HAIKU_MODEL_TAG,
} from "./constants/llm-pricing.js";

export { GLOSSARY } from "./constants/glossary.js";
export type { GlossaryEntry, GlossaryKey } from "./constants/glossary.js";

// Signal interpretation helper — Phase B2 (#171)
export { buildInterpretation } from "./signals/interpretation.js";

// Read-path re-blend helper — applies user BlendProfile to persisted per-TF votes (#302)
export { reblendWithProfile } from "./signals/blend.js";

// Signal explanation templater — v2 Phase 2 (#253)
export { explainRules } from "./signals/explain.js";

// Risk helpers (Gap 1 — moved from ingestion/src/risk/ so backend can import)
export { attachRiskRecommendation } from "./risk/attach.js";
export {
  computeRiskRecommendation,
  kellyUnlocked,
  RISK_PCT,
  STOP_MULTIPLIER,
  TP_MULTIPLES,
  MIN_SIZE_PCT,
  PRICE_PREFIX,
  TRAILING_STOP_MULTIPLIER,
} from "./risk/recommend.js";
