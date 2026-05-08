import type { TradingPair } from "../constants/pairs.js";
import type { Timeframe } from "./ingestion.js";

// ---------------------------------------------------------------------------
// Risk profile
// ---------------------------------------------------------------------------

export type RiskProfile = "conservative" | "moderate" | "aggressive";

/**
 * Per-pair risk profile map. Every user must have a profile for every pair.
 * Populated automatically at user creation / tier change by defaultRiskProfiles().
 *
 * Design: §9.2 of docs/SIGNALS_AND_RISK.md
 */
export type RiskProfileMap = Record<TradingPair, RiskProfile>;

// ---------------------------------------------------------------------------
// Kelly stats — scoped per (pair, timeframe, direction) per §9.3.1 / Fix 6
// ---------------------------------------------------------------------------

/**
 * Historical outcome statistics for a (pair, timeframe, direction) slice.
 * Phase 8 populates these from resolved signals; Phase 7 reads them via
 * a getter that falls back gracefully when unavailable (returns undefined).
 *
 * Fields:
 *   pair        — trading pair, e.g. "BTC/USDT"
 *   timeframe   — signal timeframe
 *   direction   — "buy" | "sell" (separate stats; long bias in crypto is real)
 *   resolved    — number of resolved signals for this slice (requires ≥50 to unlock Kelly)
 *   p           — win rate (resolved-correct / resolved-total)
 *   b           — average win-size / average loss-size ratio
 */
export interface KellyStats {
  pair: string;
  timeframe: Timeframe;
  direction: "buy" | "sell";
  resolved: number;
  p: number;
  b: number;
}

// ---------------------------------------------------------------------------
// Risk recommendation
// ---------------------------------------------------------------------------

/**
 * Advisory risk recommendation emitted alongside each non-hold BlendedSignal.
 * null when signal.type === "hold" or when computed sizePct falls below the
 * minimum threshold (0.001 = 0.1%).
 *
 * Design: §9.9 of docs/SIGNALS_AND_RISK.md (stopDistanceR renamed → stopDistance per Fix 4)
 */
export interface RiskRecommendation {
  pair: string;
  profile: RiskProfile;
  positionSizePct: number;
  positionSizeModel: "fixed" | "vol-targeted" | "kelly";
  stopLoss: number;
  /** ATR × multiplier (price delta, not an R-multiple) */
  stopDistance: number;
  takeProfit: { price: number; closePct: number; rMultiple: number }[];
  /** Human-readable invalidation condition (mobile UX). */
  invalidationCondition: string;
  trailingStopAfterTP2: { multiplier: number; reference: "ATR" };
}
