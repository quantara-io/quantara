/**
 * Per-timeframe scoring engine.
 *
 * Design: §4.1 – §4.5 of docs/SIGNALS_AND_RISK.md
 *
 * Five terminal states (§4.5, extended in v2 Phase 2 #253):
 *   - TimeframeVote { type: "strong-buy" | "buy", ... }  — bullish signal above threshold
 *   - TimeframeVote { type: "strong-sell" | "sell", ... } — bearish signal above threshold
 *   - TimeframeVote { type: "hold", volatilityFlag: true, gateReason }  — gated hold
 *   - null  — no opinion (no eligible rule can evaluate; all warm-ups failed)
 *
 * Confidence is ORDINAL in v1. See TimeframeVote JSDoc for details.
 */

import type { IndicatorState } from "@quantara/shared";
import type { Rule, FiredRule, TimeframeVote, GateResult, SignalTag } from "@quantara/shared";
import {
  MIN_CONFLUENCE,
  STRONG_CONFLUENCE,
  STRONG_NET_MARGIN,
  explainRules,
} from "@quantara/shared";

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
// detectTags
// ---------------------------------------------------------------------------

/**
 * Populate auxiliary tags independent of the tier verdict.
 *
 * Tags are emitted on every signal emission (including holds).
 * May return an empty array when no conditions fire.
 *
 * Design: v2 Phase 2 (#253) — tags channel.
 */
export function detectTags(state: IndicatorState, fired: FiredRule[]): SignalTag[] {
  const tags: SignalTag[] = [];

  // RSI watch — always emit regardless of confluence.
  if (state.rsi14 !== null && state.rsi14 < 30) tags.push("rsi-oversold-watch");
  if (state.rsi14 !== null && state.rsi14 > 70) tags.push("rsi-overbought-watch");

  // Volume spike — derived from which directional rule fired.
  if (fired.some((r) => r.name === "volume-spike-bull")) tags.push("volume-spike-bull");
  if (fired.some((r) => r.name === "volume-spike-bear")) tags.push("volume-spike-bear");

  // bull-div / bear-div / breakout-up / breakout-down: requires new rules.
  // Tag types are reserved in SIGNAL_TAGS — deferred to a follow-up issue.

  return tags;
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
 * 5-tier ladder (v2 Phase 2 #253):
 *   bull >= STRONG_CONFLUENCE && net >= STRONG_NET_MARGIN → strong-buy
 *   bull >= MIN_CONFLUENCE   && net > 0                  → buy
 *   bear >= STRONG_CONFLUENCE && net <= -STRONG_NET_MARGIN → strong-sell
 *   bear >= MIN_CONFLUENCE   && net < 0                  → sell
 *   otherwise                                             → hold
 *
 * Gate logic always forces hold regardless of conviction.
 *
 * @param state        - Current indicator state. Never mutated.
 * @param rules        - Rule definitions. Never mutated.
 * @param lastFireBars - Caller-managed cooldown tracking (see scoreRules).
 * @param options.minConfluence     - Override MIN_CONFLUENCE (default 1.5).
 * @param options.strongConfluence  - Override STRONG_CONFLUENCE (default 3.0).
 * @param options.strongNetMargin   - Override STRONG_NET_MARGIN (default 2.0).
 * @param options.gateResult        - Explicit gate decision from evaluateGates()
 *   (gates.ts, Issue D / #45). When `gateResult.fired === true` the vote is
 *   forced to `type: "hold"` with `gateReason = gateResult.reason` and
 *   `rulesFired = []` (the gate is caller-supplied, not rule-encoded). When
 *   null or omitted, no gate is applied. Gates are always explicit via this
 *   parameter — Rule.direction does not include "gate".
 * @param options.disabledRuleKeys  - Set of "{rule}#{pair}#{TF}" keys for
 *   rules that have been auto-disabled by the Phase 8 §10.10 prune job. Skipped
 *   rules are appended to `rulesFired` as `"disabled:<ruleName>"` for the audit
 *   trail (explainability). Load once per Lambda invocation and pass in; do not
 *   call DynamoDB inside this function.
 */
export function scoreTimeframe(
  state: IndicatorState,
  rules: Rule[],
  lastFireBars: Record<string, number>,
  options?: {
    minConfluence?: number;
    strongConfluence?: number;
    strongNetMargin?: number;
    gateResult?: GateResult | null;
    disabledRuleKeys?: ReadonlySet<string>;
  },
): TimeframeVote | null {
  const minConfluence = options?.minConfluence ?? MIN_CONFLUENCE;
  const strongConfluence = options?.strongConfluence ?? STRONG_CONFLUENCE;
  const strongNetMargin = options?.strongNetMargin ?? STRONG_NET_MARGIN;
  const gateResult = options?.gateResult ?? null;
  const disabledRuleKeys = options?.disabledRuleKeys;

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
      // Carry the gate's decision inputs so blend.ts can surface them in the HOLD
      // rationale (issue #216). Omitted when context is absent (pre-context gate paths).
      ...(gateResult.context !== undefined ? { gateContext: gateResult.context } : {}),
      reasoning: explainRules([], gateResult.reason),
      tags: detectTags(state, []),
      asOf: state.asOf,
    };
  }

  // 2. Partition rules into active and auto-disabled (Phase 8 §10.10).
  //    A rule is suppressed when its "{name}#{pair}#{TF}" key appears in
  //    disabledRuleKeys. Suppressed rules that would otherwise pass all other
  //    eligibility checks (timeframe, warm-up, cooldown, predicate) are
  //    tracked for the audit trail but contribute no directional score.
  //    We filter disabled rules out BEFORE calling scoreRules so that group-max
  //    selection only considers active rules, matching the semantic that a
  //    disabled rule is as if it doesn't exist for this invocation.
  let activeRules = rules;
  const disabledNames: string[] = [];
  if (disabledRuleKeys !== undefined && disabledRuleKeys.size > 0) {
    const active: Rule[] = [];
    for (const r of rules) {
      const key = `${r.name}#${state.pair}#${state.timeframe}`;
      if (disabledRuleKeys.has(key)) {
        // Only track if the rule would actually fire (eligible + predicate passes).
        if (
          r.appliesTo.includes(state.timeframe) &&
          state.barsSinceStart >= r.requiresPrior &&
          r.when(state)
        ) {
          disabledNames.push(r.name);
        }
      } else {
        active.push(r);
      }
    }
    activeRules = active;
  }

  // 3. Compute fired rules (only reached when gate did not fire).
  const fired = scoreRules(state, activeRules, lastFireBars);

  // 4. Sum directional scores.
  let bullishScore = 0;
  let bearishScore = 0;
  for (const r of fired) {
    if (r.direction === "bullish") bullishScore += r.strength;
    else if (r.direction === "bearish") bearishScore += r.strength;
  }

  // 5. Determine direction — 5-tier ladder (v2 Phase 2 #253).
  const net = bullishScore - bearishScore;
  // Append disabled-rule entries for explainability (Phase 8 §10.10).
  // Format: "disabled:<ruleName>" — readers can split on ":" to identify suppressed rules.
  const rulesFired = [...fired.map((r) => r.name), ...disabledNames.map((n) => `disabled:${n}`)];
  const tags = detectTags(state, fired);

  // Strong-buy: high bullish conviction with clear net margin.
  if (bullishScore >= strongConfluence && net >= strongNetMargin) {
    return {
      type: "strong-buy",
      confidence: sigmoid(bullishScore - bearishScore),
      rulesFired,
      bullishScore,
      bearishScore,
      volatilityFlag: false,
      gateReason: null,
      reasoning: explainRules(rulesFired, null),
      tags,
      asOf: state.asOf,
    };
  }

  // Buy: bullish score above threshold with positive net.
  if (bullishScore >= minConfluence && net > 0) {
    return {
      type: "buy",
      confidence: sigmoid(bullishScore - bearishScore),
      rulesFired,
      bullishScore,
      bearishScore,
      volatilityFlag: false,
      gateReason: null,
      reasoning: explainRules(rulesFired, null),
      tags,
      asOf: state.asOf,
    };
  }

  // Strong-sell: high bearish conviction with clear net margin.
  if (bearishScore >= strongConfluence && net <= -strongNetMargin) {
    return {
      type: "strong-sell",
      confidence: sigmoid(bearishScore - bullishScore),
      rulesFired,
      bullishScore,
      bearishScore,
      volatilityFlag: false,
      gateReason: null,
      reasoning: explainRules(rulesFired, null),
      tags,
      asOf: state.asOf,
    };
  }

  // Sell: bearish score above threshold with negative net.
  if (bearishScore >= minConfluence && net < 0) {
    return {
      type: "sell",
      confidence: sigmoid(bearishScore - bullishScore),
      rulesFired,
      bullishScore,
      bearishScore,
      volatilityFlag: false,
      gateReason: null,
      reasoning: explainRules(rulesFired, null),
      tags,
      asOf: state.asOf,
    };
  }

  // Below threshold or tied: hold with templated reasoning and score context.
  return {
    type: "hold",
    confidence: Math.min(1, 0.5 + 0.1 * Math.abs(bullishScore - bearishScore)),
    rulesFired,
    bullishScore,
    bearishScore,
    volatilityFlag: false,
    gateReason: null,
    reasoning: explainRules(rulesFired, null, { bullishScore, bearishScore }),
    tags,
    asOf: state.asOf,
  };
}
