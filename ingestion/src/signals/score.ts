/**
 * Per-timeframe scoring engine.
 *
 * Design: §4.1 – §4.5 of docs/SIGNALS_AND_RISK.md
 *
 * Three terminal states (§4.5):
 *   - TimeframeVote { type: "buy" | "sell", ... }  — a directional signal above threshold
 *   - TimeframeVote { type: "hold", volatilityFlag: true, gateReason }  — gated hold
 *   - null  — no opinion (warm-up, missing required indicators)
 *
 * Confidence is ORDINAL in v1. See TimeframeVote JSDoc for details.
 */

import type { IndicatorState } from "@quantara/shared";
import type { Rule, FiredRule, TimeframeVote } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Constants (§4.3)
// ---------------------------------------------------------------------------

/** Minimum directional score required to emit a buy/sell signal. */
const MIN_CONFLUENCE = 1.5;

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
    const barsAgo = lastFireBars[r.name];
    if (barsAgo !== undefined && r.cooldownBars !== undefined && r.cooldownBars > 0) {
      if (barsAgo < r.cooldownBars) return false;
    }

    // Predicate (must not mutate state — contract enforced by Rule type).
    return r.when(state);
  });

  // 2. Group-max selection: keep only the highest-strength rule per group.
  const byGroup = new Map<string, Rule>();
  for (const r of passing) {
    const key = r.group ?? r.name;
    const existing = byGroup.get(key);
    if (!existing || r.strength > existing.strength) {
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
 * Returns `null` when warm-up or required indicators are missing
 * (distinct from a gated `hold`). Returns a TimeframeVote otherwise.
 *
 * @param state - Current indicator state. Never mutated.
 * @param rules - Rule definitions. Never mutated.
 * @param lastFireBars - Caller-managed cooldown tracking (see scoreRules).
 * @param options.minConfluence - Override MIN_CONFLUENCE (default 1.5).
 */
export function scoreTimeframe(
  state: IndicatorState,
  rules: Rule[],
  lastFireBars: Record<string, number>,
  options?: { minConfluence?: number },
): TimeframeVote | null {
  const minConfluence = options?.minConfluence ?? MIN_CONFLUENCE;

  // Null guard: no warm-up at all.
  // We return null (no opinion) when there are zero bars recorded. The caller
  // is responsible for stricter per-rule warm-up via requiresPrior.
  if (state.barsSinceStart === 0) return null;

  // 1. Compute fired rules.
  const fired = scoreRules(state, rules, lastFireBars);

  // 2. Sum directional scores.
  let bullishScore = 0;
  let bearishScore = 0;
  for (const r of fired) {
    if (r.direction === "bullish") bullishScore += r.strength;
    else if (r.direction === "bearish") bearishScore += r.strength;
    // gate rules contribute to gateCheck below, not to directional scores.
  }

  // 3. Check for any gate.
  const gateFired = fired.find((r) => r.direction === "gate");
  if (gateFired) {
    // Resolve the gateReason from the rule name heuristic. The actual gate
    // logic (vol threshold, dispersion bars, stale count) is the caller's
    // responsibility — they wire the appropriate gate rules. We derive the
    // category from the name as a best-effort label for the UI.
    const gateReason = resolveGateReason(gateFired.name);
    return {
      type: "hold",
      confidence: 0.5,
      rulesFired: fired.map((r) => r.name),
      bullishScore,
      bearishScore,
      volatilityFlag: true,
      gateReason,
      asOf: state.asOf,
    };
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

  // Below threshold or tied: hold with weak confidence.
  return {
    type: "hold",
    confidence: 0.5 + 0.1 * Math.abs(bullishScore - bearishScore),
    rulesFired,
    bullishScore,
    bearishScore,
    volatilityFlag: false,
    gateReason: null,
    asOf: state.asOf,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a gateReason label from the rule name.
 * Gate rules are Issue D (not yet implemented); this function provides
 * reasonable defaults so the scoring engine works with any gate rule.
 */
function resolveGateReason(
  name: string,
): "vol" | "dispersion" | "stale" | null {
  if (name.includes("vol")) return "vol";
  if (name.includes("dispersion")) return "dispersion";
  if (name.includes("stale")) return "stale";
  return null;
}
