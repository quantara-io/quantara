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

import type { TimeframeVote, BlendedSignal, Timeframe } from "@quantara/shared";
import { TIMEFRAMES } from "@quantara/shared";

/**
 * Default per-timeframe weights. Single vector for v1 across all pairs (§5.7).
 * Per-pair overrides land in Phase 8 calibration.
 */
export const DEFAULT_TIMEFRAME_WEIGHTS: Record<Timeframe, number> = {
  "1m": 0,
  "5m": 0,
  "15m": 0.15,
  "1h": 0.20,
  "4h": 0.30,
  "1d": 0.35,
};

/**
 * Threshold T above which |blended| maps to a directional signal (§5.3).
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
 */
export function blendTimeframeVotes(
  pair: string,
  perTimeframeVotes: Record<Timeframe, TimeframeVote | null>,
  emittingTimeframe: Timeframe,
  weights: Record<Timeframe, number> = DEFAULT_TIMEFRAME_WEIGHTS,
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

    return {
      pair,
      type: "hold",
      confidence: 0.5,
      volatilityFlag: true,
      gateReason: highestGateReason,
      rulesFired: Array.from(rulesFiredSet),
      perTimeframe: perTimeframeVotes,
      weightsUsed,
      asOf,
      emittingTimeframe,
    };
  }

  // Step 3: Collect non-null, non-gated votes and renormalize weights.
  const votingTfs: Timeframe[] = TIMEFRAMES.filter(
    (tf) => perTimeframeVotes[tf] !== null,
  );

  const rawWeightSum = votingTfs.reduce((sum, tf) => sum + weights[tf], 0);

  // Build renormalized weight map (all non-null TFs).
  const renormalized: Record<Timeframe, number> = {} as Record<Timeframe, number>;
  for (const tf of TIMEFRAMES) {
    if (perTimeframeVotes[tf] !== null) {
      renormalized[tf] = rawWeightSum > 0 ? weights[tf] / rawWeightSum : 0;
    } else {
      renormalized[tf] = 0;
    }
  }

  // Step 4 + 5: Compute blended scalar.
  let blended = 0;
  for (const tf of votingTfs) {
    const vote = perTimeframeVotes[tf]!;
    let scalar: number;
    if (vote.type === "buy") {
      scalar = +vote.confidence;
    } else if (vote.type === "sell") {
      scalar = -vote.confidence;
    } else {
      scalar = 0; // hold
    }
    blended += renormalized[tf] * scalar;
  }

  // Step 6: Single-source damping — if only 1 TF has a non-null vote.
  const isSingleSource = votingTfs.length === 1;
  const dampingFactor = isSingleSource ? 0.7 : 1.0;

  // Collect union of rules fired from contributing TFs.
  const rulesFiredSet = new Set<string>();
  for (const tf of votingTfs) {
    const vote = perTimeframeVotes[tf]!;
    for (const r of vote.rulesFired) rulesFiredSet.add(r);
  }

  // Step 7: Map blended scalar → headline signal type + confidence.
  let type: "buy" | "sell" | "hold";
  let confidence: number;

  if (blended > BLEND_THRESHOLD_T) {
    type = "buy";
    confidence = Math.min(1, blended * 1.2 * dampingFactor);
  } else if (blended < -BLEND_THRESHOLD_T) {
    type = "sell";
    confidence = Math.min(1, Math.abs(blended) * 1.2 * dampingFactor);
  } else {
    type = "hold";
    confidence = Math.min(1, 0.5 + 0.1 * Math.abs(blended));
  }

  return {
    pair,
    type,
    confidence,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: Array.from(rulesFiredSet),
    perTimeframe: perTimeframeVotes,
    weightsUsed: renormalized,
    asOf,
    emittingTimeframe,
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
