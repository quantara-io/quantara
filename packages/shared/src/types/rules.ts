import type { IndicatorState } from "./indicators.js";
import type { Timeframe } from "./ingestion.js";

/**
 * A single scoring rule. Rules are pure predicates over IndicatorState.
 *
 * Design: §4.1 of docs/SIGNALS_AND_RISK.md
 */
export interface Rule {
  /** Unique identifier used in rulesFired output. */
  name: string;
  /** Direction this rule contributes to when it fires. */
  direction: "bullish" | "bearish" | "gate";
  /**
   * Score contribution on fire. Gates use this field only for ranking within
   * their group — gate votes always produce type="hold", never add to a
   * directional score.
   */
  strength: number;
  /** Pure predicate. Must not mutate state. */
  when: (state: IndicatorState) => boolean;

  /** Timeframes this rule is valid for. Rules are silently skipped on others. */
  appliesTo: Timeframe[];
  /**
   * Mutually-exclusive group name. When multiple rules in the same group fire,
   * only the highest-strength rule is kept (group-max selection).
   * Defaults to the rule name if omitted (i.e. no mutual exclusion).
   */
  group?: string;
  /**
   * Suppress re-fire for N bars after last fire.
   * Caller is responsible for passing lastFireBars. Defaults to 0.
   */
  cooldownBars?: number;
  /**
   * Minimum barsSinceStart required before this rule is eligible to fire.
   * Guards against junk values during indicator warm-up.
   */
  requiresPrior: number;
}

/**
 * A rule that passed all eligibility checks and whose predicate returned true,
 * after group-max selection has collapsed mutually-exclusive groups.
 */
export interface FiredRule {
  name: string;
  direction: "bullish" | "bearish" | "gate";
  strength: number;
  /** Resolved group — equals rule.group ?? rule.name. */
  group: string;
}

/**
 * Per-timeframe vote produced by scoreTimeframe.
 *
 * Note on confidence (v1): confidence is ORDINAL, not a calibrated probability.
 * Higher = more conviction, but confidence: 0.8 does NOT mean 80% hit-rate.
 * Phase 8 will fit Platt scaling per (pair, timeframe) against actual outcomes.
 * Until then the UI must not represent confidence as a probability.
 */
export interface TimeframeVote {
  /** Signal direction produced by this timeframe. */
  type: "buy" | "sell" | "hold";
  /**
   * Ordinal confidence in [0, 1].
   * For buy/sell: sigmoid(bullishScore − bearishScore).
   * For gated hold: 0.5.
   * For threshold-hold: 0.5 + 0.1 * |bullishScore − bearishScore|.
   */
  confidence: number;
  /** Names of the rules that fired (after group-max selection). */
  rulesFired: string[];
  /** Sum of strengths of all bullish fired rules. */
  bullishScore: number;
  /** Sum of strengths of all bearish fired rules. */
  bearishScore: number;
  /**
   * True when a gate rule fired (vol / dispersion / stale).
   * A gated vote always has type="hold".
   */
  volatilityFlag: boolean;
  /**
   * Populated when a gate fired. Null when no gate fired.
   * "vol"        — realized volatility exceeds per-pair threshold
   * "dispersion" — cross-exchange spread exceeds 1% for 3+ consecutive bars
   * "stale"      — ≥2 of 3 exchanges are stale
   */
  gateReason: "vol" | "dispersion" | "stale" | null;
  /** Snapshot of state.asOf passed through for audit / downstream blending. */
  asOf: number;
}
