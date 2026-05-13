/**
 * Multi-horizon blender — Phase 3.
 *
 * Takes per-timeframe votes from scoreTimeframe (Phase 2) and combines them
 * into one headline BlendedSignal per pair using the §5 algorithm.
 *
 * Design: §5 of docs/SIGNALS_AND_RISK.md
 * This is the pure blending logic. Persistence to DDB and the scheduler/Lambda
 * belong to Phase 4 (out of scope here).
 */

import type { TimeframeVote, BlendedSignal, Timeframe, GateContext } from "@quantara/shared";
import { TIMEFRAMES, coreBlendVotes } from "@quantara/shared";

/**
 * Default per-timeframe weights. Single vector for v1 across all pairs (§5.7).
 * Per-pair overrides land in Phase 8 calibration.
 *
 * DESIGN NOTE (§5.10): With these weights and BLEND_THRESHOLD_T = 0.25, a
 * directional vote on 15m (max contribution ±0.15) or 1h (max contribution
 * ±0.20) cannot drive the blended scalar past T on its own — even at perfect
 * confidence. Short-TF directional signals are intentionally suppressed unless
 * a longer-TF vote (4h or 1d) co-fires. This filters whipsaw at the cost of
 * missing high-conviction short-TF entries on quiet long-TF backgrounds.
 * Revisit once calibration data from the Performance page exists.
 * See docs/SIGNALS_AND_RISK.md §5.10 for the full decision record.
 */
export const DEFAULT_TIMEFRAME_WEIGHTS: Record<Timeframe, number> = {
  "1m": 0,
  "5m": 0,
  "15m": 0.15,
  "1h": 0.2,
  "4h": 0.3,
  "1d": 0.35,
};

/**
 * Threshold T above which |blended| maps to a directional signal (§5.3).
 *
 * DESIGN NOTE (§5.10): T = 0.25 means 15m (weight 0.15) and 1h (weight 0.20)
 * cannot produce a directional blended signal in isolation. This is intentional
 * for v1 — long-TF votes dominate to reduce whipsaw noise. Do not lower this
 * value without empirical win-rate data from the Performance page calibration
 * view. See docs/SIGNALS_AND_RISK.md §5.10 for options (B), (C), and (D).
 */
export const BLEND_THRESHOLD_T = 0.25;

/** Priority order for gate reasons: vol > dispersion > stale. */
const GATE_PRIORITY: Record<"vol" | "dispersion" | "stale", number> = {
  vol: 3,
  dispersion: 2,
  stale: 1,
};

/**
 * Blend per-timeframe votes into one headline signal.
 *
 * Algorithm (§5.3 + §5.6):
 *   1. If ALL votes are null → return null (no opinion; warm-up state).
 *   2. If ANY vote has volatilityFlag === true OR gateReason !== null:
 *        return BlendedSignal { type: "hold", volatilityFlag, gateReason: <highest-priority>, ... }
 *        Priority: vol > dispersion > stale.
 *   3. Drop null votes; renormalize remaining weights so they sum to 1.0.
 *   4. Map each remaining vote to scalar in [-1, +1]:
 *        buy   →  +confidence
 *        sell  →  -confidence
 *        hold  →   0
 *   5. blended = Σ (renormalizedWeight[tf] · scalar[tf])
 *   6. Single-source confidence damping: if only 1 TF voted (others null),
 *        multiply final confidence by 0.7 to reflect reduced source diversity.
 *   7. Map blended → headline signal:
 *        if blended > +T: type = "buy", confidence = min(1, blended * 1.2 [* 0.7 if single-source])
 *        if blended < -T: type = "sell", confidence = same with abs
 *        else:            type = "hold", confidence = 0.5 + 0.1 * |blended|, clamped to [0, 1]
 *
 * @param pair  Trading pair this blend applies to.
 * @param perTimeframeVotes  Map of TF → vote (null means no opinion / warm-up for that TF).
 * @param emittingTimeframe  Which TF's close triggered this blend run (for lifecycle tracking).
 * @param weights  Per-TF weight overrides (default: DEFAULT_TIMEFRAME_WEIGHTS).
 * @param threshold  Threshold T override (default: BLEND_THRESHOLD_T). Used at the API read
 *                   path to apply the user's BlendProfile without re-writing stored signals.
 */
export function blendTimeframeVotes(
  pair: string,
  perTimeframeVotes: Record<Timeframe, TimeframeVote | null>,
  emittingTimeframe: Timeframe,
  weights: Record<Timeframe, number> = DEFAULT_TIMEFRAME_WEIGHTS,
  threshold: number = BLEND_THRESHOLD_T,
): BlendedSignal | null {
  // Step 1: If ALL votes are null → return null.
  const allNull = TIMEFRAMES.every((tf) => perTimeframeVotes[tf] === null);
  if (allNull) return null;

  // Determine asOf: latest asOf among non-null votes.
  let asOf = 0;
  for (const tf of TIMEFRAMES) {
    const vote = perTimeframeVotes[tf];
    if (vote !== null && vote.asOf > asOf) {
      asOf = vote.asOf;
    }
  }

  // Step 2: Gate cascade — any vote with volatilityFlag or gateReason forces a hold.
  let highestGateReason: "vol" | "dispersion" | "stale" | null = null;
  let anyGated = false;
  for (const tf of TIMEFRAMES) {
    const vote = perTimeframeVotes[tf];
    if (vote === null) continue;
    if (vote.volatilityFlag || vote.gateReason !== null) {
      anyGated = true;
      const reason = vote.gateReason ?? (vote.volatilityFlag ? "vol" : null);
      if (reason !== null) {
        if (
          highestGateReason === null ||
          GATE_PRIORITY[reason] > GATE_PRIORITY[highestGateReason]
        ) {
          highestGateReason = reason;
        }
      }
    }
  }

  if (anyGated) {
    // Collect union of rules fired across all contributing (non-null) TFs.
    const rulesFiredSet = new Set<string>();
    for (const tf of TIMEFRAMES) {
      const vote = perTimeframeVotes[tf];
      if (vote !== null) {
        for (const r of vote.rulesFired) rulesFiredSet.add(r);
      }
    }

    // Build renormalized weights (all non-null TFs contribute their raw weights).
    const weightsUsed = buildWeightsUsed(perTimeframeVotes, weights);

    // Shallow-copy the top-level map so caller mutation cannot corrupt the returned signal.
    const perTimeframe: Record<Timeframe, TimeframeVote | null> = {
      "1m": perTimeframeVotes["1m"],
      "5m": perTimeframeVotes["5m"],
      "15m": perTimeframeVotes["15m"],
      "1h": perTimeframeVotes["1h"],
      "4h": perTimeframeVotes["4h"],
      "1d": perTimeframeVotes["1d"],
    };

    // Pick the gateContext from the highest-priority gate's vote (issue #216).
    // GATE_PRIORITY: vol > dispersion > stale. The winning gate reason is in
    // highestGateReason; find a vote that carries a matching gateContext.
    let gateContext: GateContext | null = null;
    if (highestGateReason !== null) {
      for (const tf of TIMEFRAMES) {
        const vote = perTimeframeVotes[tf];
        if (
          vote !== null &&
          vote.gateReason === highestGateReason &&
          vote.gateContext !== undefined
        ) {
          gateContext = vote.gateContext;
          break;
        }
      }
    }

    return {
      pair,
      type: "hold",
      confidence: 0.5,
      // volatilityFlag is true only for vol gates; dispersion/stale use their own UI copy.
      volatilityFlag: highestGateReason === "vol",
      gateReason: highestGateReason,
      gateContext,
      rulesFired: Array.from(rulesFiredSet),
      perTimeframe,
      weightsUsed,
      asOf,
      emittingTimeframe,
      // TODO(Phase 4b): attachRiskRecommendation is invoked by the indicator-handler
      // before putSignal; the blender always returns risk: null here and the caller
      // is responsible for enriching non-hold signals via attachRiskRecommendation.
      risk: null,
    };
  }

  // Steps 3-7: Delegate to shared coreBlendVotes to keep write-time and
  // read-time blend math in sync (extracted by #322).
  const core = coreBlendVotes(perTimeframeVotes, weights, threshold);

  // Shallow-copy the top-level map so caller mutation cannot corrupt the returned signal.
  const perTimeframe: Record<Timeframe, TimeframeVote | null> = {
    "1m": perTimeframeVotes["1m"],
    "5m": perTimeframeVotes["5m"],
    "15m": perTimeframeVotes["15m"],
    "1h": perTimeframeVotes["1h"],
    "4h": perTimeframeVotes["4h"],
    "1d": perTimeframeVotes["1d"],
  };

  return {
    pair,
    type: core.type,
    confidence: core.confidence,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: core.rulesFired,
    perTimeframe,
    weightsUsed: core.weightsUsed,
    asOf,
    emittingTimeframe,
    // TODO(Phase 4b): attachRiskRecommendation is invoked by the indicator-handler
    // before putSignal; the blender always returns risk: null and the caller enriches
    // non-hold signals via attachRiskRecommendation(signal, state, user.riskProfiles).
    risk: null,
  };
}

/**
 * Build a post-renormalization weights record for the non-null TFs.
 * Used by the gated-hold path to populate weightsUsed consistently.
 */
function buildWeightsUsed(
  perTimeframeVotes: Record<Timeframe, TimeframeVote | null>,
  weights: Record<Timeframe, number>,
): Record<Timeframe, number> {
  const votingTfs = TIMEFRAMES.filter((tf) => perTimeframeVotes[tf] !== null);
  const rawWeightSum = votingTfs.reduce((sum, tf) => sum + weights[tf], 0);
  const result: Record<Timeframe, number> = {} as Record<Timeframe, number>;
  for (const tf of TIMEFRAMES) {
    if (perTimeframeVotes[tf] !== null) {
      result[tf] = rawWeightSum > 0 ? weights[tf] / rawWeightSum : 0;
    } else {
      result[tf] = 0;
    }
  }
  return result;
}

/**
 * Compare two blended signals to decide whether to emit a user-visible UI change.
 * Returns true if the change is "trivial" and the UI should suppress notification.
 *
 * Per §5.5:
 *   - Same type
 *   - |confidence delta| < 0.05
 *   - Same volatilityFlag
 *   - Same gateReason
 */
export function isTrivialChange(
  previous: BlendedSignal | null,
  current: BlendedSignal | null,
): boolean {
  // Both null → trivial (no change).
  if (previous === null && current === null) return true;
  // One null, one not → significant change.
  if (previous === null || current === null) return false;

  if (previous.type !== current.type) return false;
  if (Math.abs(previous.confidence - current.confidence) >= 0.05) return false;
  if (previous.volatilityFlag !== current.volatilityFlag) return false;
  if (previous.gateReason !== current.gateReason) return false;

  return true;
}
