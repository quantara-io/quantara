/**
 * Per-timeframe scoring engine.
 *
 * Design: §4.1 – §4.5 of docs/SIGNALS_AND_RISK.md
 *
 * Three terminal states (§4.5):
 *   - TimeframeVote { type: "buy" | "sell", ... }  — a directional signal above threshold
 *   - TimeframeVote { type: "hold", volatilityFlag: true, gateReason }  — gated hold
 *   - null  — no opinion (no eligible rule can evaluate; all warm-ups failed)
 *
 * Confidence is ORDINAL in v1. See TimeframeVote JSDoc for details.
 */

import type { IndicatorState } from "@quantara/shared";
import type { Rule, FiredRule, TimeframeVote, GateResult } from "@quantara/shared";
import { MIN_CONFLUENCE } from "@quantara/shared";

// GateResult is declared in @quantara/shared (packages/shared/src/types/rules.ts) —
// single source of truth shared with gates.ts. Re-exported here so importers that
// pull directly from score.ts continue to work without changing their imports.
export type { GateResult } from "@quantara/shared";

/**
 * Sigmoid with half-scale: sigmoid(x) = 1 / (1 + exp(-x/2))
 * Bounded in (0, 1). Saturates above ±5.
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x / 2));
}

// ---------------------------------------------------------------------------
// scoreRules
// ---------------------------------------------------------------------------

/**
 * Filter rules whose conditions match the state, are eligible for the
 * timeframe, past warm-up, and out of cooldown. Then collapse
 * mutually-exclusive groups by keeping the highest-strength rule per group.
 *
 * **Cooldown semantics:** `lastFireBars[ruleName]` is the number of bars elapsed
 * since the rule last fired, measured from the *current* bar.
 *   - If the rule fired at bar `t`, then at bar `t` itself `lastFireBars[name] = 0`
 *     (zero bars have elapsed since the fire).
 *   - A `cooldownBars` of 3 means the rule is suppressed at bars t, t+1, t+2
 *     (i.e. `lastFireBars < 3`) and is re-eligible at bar t+3 (`lastFireBars >= 3`).
 *
 * @param state - Current indicator state. Never mutated.
 * @param rules - Rule definitions. Never mutated.
 * @param lastFireBars - Caller-managed map of ruleName → bars since last fire.
 *   If a rule name is absent it is treated as never having fired (no cooldown).
 * @returns Fired rules after group-max selection.
 */
export function scoreRules(
  state: IndicatorState,
  rules: Rule[],
  lastFireBars: Record<string, number>,
): FiredRule[] {
  // 1. Filter to eligible, condition-passing rules.
  const passing: Rule[] = rules.filter((r) => {
    // Timeframe filter.
    if (!r.appliesTo.includes(state.timeframe)) return false;

    // Warm-up gate: we need at least requiresPrior bars before the rule fires.
    if (state.barsSinceStart < r.requiresPrior) return false;

    // Cooldown gate: if lastFireBars[r.name] is defined, it must be >= cooldownBars.
    // See JSDoc above for the "bars elapsed" convention.
    const barsAgo = lastFireBars[r.name];
    if (barsAgo !== undefined && r.cooldownBars !== undefined && r.cooldownBars > 0) {
      if (barsAgo < r.cooldownBars) return false;
    }

    // Predicate (must not mutate state — contract enforced by Rule type).
    return r.when(state);
  });

  // 2. Group-max selection: keep only the highest-strength rule per group.
  //    Tie-break: lexicographic order on rule name (deterministic regardless of
  //    the order rules appear in the constants array).
  const byGroup = new Map<string, Rule>();
  for (const r of passing) {
    const key = r.group ?? r.name;
    const existing = byGroup.get(key);
    if (!existing) {
      byGroup.set(key, r);
    } else if (r.strength > existing.strength) {
      byGroup.set(key, r);
    } else if (r.strength === existing.strength && r.name < existing.name) {
      // Equal strength: pick lexicographically smaller name for determinism.
      byGroup.set(key, r);
    }
  }

  // 3. Map to FiredRule (resolve group field).
  return Array.from(byGroup.values()).map((r) => ({
    name: r.name,
    direction: r.direction,
    strength: r.strength,
    group: r.group ?? r.name,
  }));
}

// ---------------------------------------------------------------------------
// scoreTimeframe
// ---------------------------------------------------------------------------

/**
 * Compute a per-timeframe vote from fired rules.
 *
 * Returns `null` when **no eligible rule can produce a vote** — specifically,
 * when every rule in the set is blocked by `requiresPrior` or `appliesTo`.
 * A partial-warm-up state (e.g. `ema200 === null`) is handled at the rule
 * predicate level: if a rule's `when` function doesn't dereference `ema200`,
 * that rule will still fire even though `ema200` is null. Only rules that
 * explicitly guard on a null indicator will be blocked.
 *
 * Returns a TimeframeVote (possibly `type: "hold"`) otherwise.
 *
 * @param state        - Current indicator state. Never mutated.
 * @param rules        - Rule definitions. Never mutated.
 * @param lastFireBars - Caller-managed cooldown tracking (see scoreRules).
 * @param options.minConfluence - Override MIN_CONFLUENCE (default 1.5).
 * @param options.gateResult   - Explicit gate decision from evaluateGates()
 *   (gates.ts, Issue D / #45). When `gateResult.fired === true` the vote is
 *   forced to `type: "hold"` with `gateReason = gateResult.reason` and
 *   `rulesFired = []` (the gate is caller-supplied, not rule-encoded). When
 *   null or omitted, no gate is applied. Gates are always explicit via this
 *   parameter — Rule.direction does not include "gate".
 */
export function scoreTimeframe(
  state: IndicatorState,
  rules: Rule[],
  lastFireBars: Record<string, number>,
  options?: { minConfluence?: number; gateResult?: GateResult | null },
): TimeframeVote | null {
  const minConfluence = options?.minConfluence ?? MIN_CONFLUENCE;
  const gateResult = options?.gateResult ?? null;

  // Null guard: return null only when no rule is eligible to evaluate.
  // A rule is "eligible" if appliesTo matches AND barsSinceStart >= requiresPrior.
  // We check eligibility (excluding the `when` predicate) to decide whether we
  // have enough information to produce any opinion at all.
  const hasEligibleRule = rules.some(
    (r) => r.appliesTo.includes(state.timeframe) && state.barsSinceStart >= r.requiresPrior,
  );

  // If no rule is eligible at all (all blocked by warm-up or timeframe), no opinion.
  if (!hasEligibleRule) return null;

  // 1. Apply explicit gate result (from evaluateGates in gates.ts).
  //    Gates are explicit via the gateResult parameter — not encoded as rule
  //    direction:"gate". When a gate fires, all directional scoring is suppressed
  //    and rulesFired is empty (no rule "caused" the gate; the caller did via
  //    evaluateGates). bullishScore and bearishScore are both zero to be
  //    consistent with the "gate suppresses everything" semantic.
  if (gateResult !== null && gateResult.fired) {
    return {
      type: "hold",
      confidence: 0.5,
      rulesFired: [],
      bullishScore: 0,
      bearishScore: 0,
      volatilityFlag: true,
      gateReason: gateResult.reason,
      asOf: state.asOf,
    };
  }

  // 2. Compute fired rules (only reached when gate did not fire).
  const fired = scoreRules(state, rules, lastFireBars);

  // 3. Sum directional scores.
  let bullishScore = 0;
  let bearishScore = 0;
  for (const r of fired) {
    if (r.direction === "bullish") bullishScore += r.strength;
    else if (r.direction === "bearish") bearishScore += r.strength;
  }

  // 4. Determine direction.
  const rulesFired = fired.map((r) => r.name);

  if (bullishScore > bearishScore && bullishScore >= minConfluence) {
    return {
      type: "buy",
      confidence: sigmoid(bullishScore - bearishScore),
      rulesFired,
      bullishScore,
      bearishScore,
      volatilityFlag: false,
      gateReason: null,
      asOf: state.asOf,
    };
  }

  if (bearishScore > bullishScore && bearishScore >= minConfluence) {
    return {
      type: "sell",
      confidence: sigmoid(bearishScore - bullishScore),
      rulesFired,
      bullishScore,
      bearishScore,
      volatilityFlag: false,
      gateReason: null,
      asOf: state.asOf,
    };
  }

  // Below threshold or tied: hold with weak confidence, clamped to [0, 1].
  return {
    type: "hold",
    confidence: Math.min(1, 0.5 + 0.1 * Math.abs(bullishScore - bearishScore)),
    rulesFired,
    bullishScore,
    bearishScore,
    volatilityFlag: false,
    gateReason: null,
    asOf: state.asOf,
  };
}
