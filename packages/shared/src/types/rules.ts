import type { IndicatorState } from "./indicators.js";
import type { Timeframe } from "./ingestion.js";

// ---------------------------------------------------------------------------
// Gate types — single source of truth (also imported by ingestion/signals/)
// ---------------------------------------------------------------------------

/**
 * Reason a gate fired. Mirrors the three gate functions in
 * ingestion/src/signals/gates.ts (evaluateGates).
 *   "vol"        — realized volatility exceeds the per-pair threshold
 *   "dispersion" — cross-exchange spread > 1% for 3 consecutive bars
 *   "stale"      — ≥2 of 3 exchanges are stale
 */
export type GateReason = "vol" | "dispersion" | "stale";

/**
 * Result produced by evaluateGates() (gates.ts). scoreTimeframe accepts this
 * as an optional parameter; when fired=true the vote is forced to type="hold".
 *
 * Declared here (not in gates.ts) so @quantara/shared is the single source of
 * truth — both score.ts and gates.ts import from this package.
 */
export interface GateResult {
  fired: boolean;
  reason: GateReason | null;
}

// ---------------------------------------------------------------------------
// Rule types
// ---------------------------------------------------------------------------

/**
 * A single scoring rule. Rules are pure predicates over IndicatorState.
 *
 * Design: §4.1 of docs/SIGNALS_AND_RISK.md
 */
export interface Rule {
  /** Unique identifier used in rulesFired output. */
  name: string;
  /**
   * Direction this rule contributes to when it fires.
   * Gates are explicit via the gateResult parameter of scoreTimeframe
   * (evaluateGates from gates.ts) — not encoded as a rule direction.
   */
  direction: "bullish" | "bearish";
  /** Score contribution on fire. */
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
  direction: "bullish" | "bearish";
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
