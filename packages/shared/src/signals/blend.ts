/**
 * Read-path re-blend helper for BlendProfile application (§5.10 / #302).
 *
 * The ingestion service writes signals_v2 using the strict profile (canonical
 * ground truth for calibration). At the API read path, this helper re-runs the
 * blend logic against the persisted per-TF votes stored on BlendedSignal.perTimeframe,
 * using the user's active BlendProfile's weights and threshold.
 *
 * This is intentionally a simplified re-implementation of the ingestion-side
 * blendTimeframeVotes() — it operates on shared types only and does not require
 * importing from the ingestion workspace. The two must stay in sync with respect
 * to the core blending math (steps 1–7 of §5.3 + §5.6).
 *
 * KEY INVARIANT: Gates (vol/dispersion/stale) always force hold regardless of
 * profile — profiles only tune T and weights, never override safety gates.
 */

import type { BlendedSignal } from "../types/signals.js";
import type { TimeframeVote, GateContext } from "../types/rules.js";
import type { Timeframe } from "../types/ingestion.js";
import type { BlendProfile } from "../types/blend.js";
import { TIMEFRAMES } from "../types/ingestion.js";
import { BLEND_PROFILES } from "../types/blend.js";

/** Priority order for gate reasons: vol > dispersion > stale. */
const GATE_PRIORITY: Record<"vol" | "dispersion" | "stale", number> = {
  vol: 3,
  dispersion: 2,
  stale: 1,
};

/**
 * Re-blend a stored BlendedSignal using the given user BlendProfile.
 *
 * Runs the §5.3 + §5.6 algorithm against signal.perTimeframe (the persisted
 * per-TF votes) with the profile's weights and threshold.
 *
 * Returns a new BlendedSignal. The following fields are always carried
 * forward from the stored signal unchanged (not re-derived):
 *   - risk               (populated downstream by enrichWithRisk)
 *   - interpretation     (caller re-populates via buildInterpretation)
 *   - invalidatedAt / invalidationReason
 *   - asOf / emittingTimeframe / pair
 *
 * Ratification fields (ratificationStatus / ratificationVerdict / algoVerdict)
 * are carried forward ONLY when the re-derived headline type matches the
 * stored signal's type. When the type flips (e.g. strict "hold" → balanced
 * "buy"), all three are cleared so buildInterpretation falls back to
 * source="algo-only" with the re-blended rulesFired text — surfacing the
 * strict-era LLM reasoning under a flipped headline is incorrect.
 *
 * Gates (vol/dispersion/stale) on any perTimeframe vote always force the
 * blended result to hold regardless of the chosen profile.
 *
 * @param signal        The stored BlendedSignal (canonical strict blend).
 * @param blendProfile  The user's active BlendProfile for this pair.
 * @returns             A new BlendedSignal with profile's T and weights applied.
 */
export function reblendWithProfile(
  signal: BlendedSignal,
  blendProfile: BlendProfile,
): BlendedSignal {
  const params = BLEND_PROFILES[blendProfile];
  const { weights, threshold } = params;
  const perTimeframeVotes = signal.perTimeframe;

  // Step 1: If ALL votes are null → return signal unchanged (warm-up state).
  const allNull = TIMEFRAMES.every((tf) => perTimeframeVotes[tf] === null);
  if (allNull) return signal;

  // Step 2: Gate cascade — any vote with volatilityFlag or gateReason forces hold.
  // Gates always override profile — only T and weights are profile-tunable.
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
    // Gated hold — profile does not change the gate outcome.
    // Reconstruct weightsUsed using profile weights for consistency.
    const weightsUsed = buildWeightsUsed(perTimeframeVotes, weights);

    // Find gateContext from the highest-priority gate's vote.
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

    // Collect union of rulesFired across all non-null TFs.
    const rulesFiredSet = new Set<string>();
    for (const tf of TIMEFRAMES) {
      const vote = perTimeframeVotes[tf];
      if (vote !== null) {
        for (const r of vote.rulesFired) rulesFiredSet.add(r);
      }
    }

    // Same type-flip ratification clearing as the non-gated branch below: if
    // the stored signal had a directional ratified headline but profile-time
    // gate evaluation forces hold, the ratification narrative is for the
    // wrong headline and must be dropped. In practice the ingestion-time
    // gate cascade should already have produced hold + null ratification on
    // the stored row, but guard against drift.
    const typeFlipped = signal.type !== "hold";

    return {
      ...signal,
      type: "hold",
      confidence: 0.5,
      volatilityFlag: highestGateReason === "vol",
      gateReason: highestGateReason,
      gateContext,
      rulesFired: Array.from(rulesFiredSet),
      weightsUsed,
      ...(typeFlipped
        ? {
            ratificationStatus: null,
            ratificationVerdict: null,
            algoVerdict: null,
          }
        : {}),
    };
  }

  // Step 3: Collect non-null, non-gated votes and renormalize weights.
  const votingTfs: Timeframe[] = TIMEFRAMES.filter((tf) => perTimeframeVotes[tf] !== null);
  const rawWeightSum = votingTfs.reduce((sum, tf) => sum + weights[tf], 0);

  const renormalized: Record<Timeframe, number> = {} as Record<Timeframe, number>;
  for (const tf of TIMEFRAMES) {
    if (perTimeframeVotes[tf] !== null) {
      renormalized[tf] = rawWeightSum > 0 ? weights[tf] / rawWeightSum : 0;
    } else {
      renormalized[tf] = 0;
    }
  }

  // Steps 4 + 5: Compute blended scalar.
  let blended = 0;
  for (const tf of votingTfs) {
    const vote = perTimeframeVotes[tf]!;
    let scalar: number;
    if (vote.type === "buy" || vote.type === "strong-buy") {
      scalar = +vote.confidence;
    } else if (vote.type === "sell" || vote.type === "strong-sell") {
      scalar = -vote.confidence;
    } else {
      scalar = 0; // hold
    }
    blended += renormalized[tf] * scalar;
  }

  // Step 6: Single-source confidence damping.
  const isSingleSource = votingTfs.length === 1;
  const dampingFactor = isSingleSource ? 0.7 : 1.0;

  // Collect union of rulesFired from voting TFs.
  const rulesFiredSet = new Set<string>();
  for (const tf of votingTfs) {
    const vote = perTimeframeVotes[tf]!;
    for (const r of vote.rulesFired) rulesFiredSet.add(r);
  }

  // Step 7: Map blended scalar → headline signal type + confidence.
  let type: "buy" | "sell" | "hold";
  let confidence: number;

  if (blended > threshold) {
    type = "buy";
    confidence = Math.min(1, blended * 1.2 * dampingFactor);
  } else if (blended < -threshold) {
    type = "sell";
    confidence = Math.min(1, Math.abs(blended) * 1.2 * dampingFactor);
  } else {
    type = "hold";
    confidence = Math.min(1, 0.5 + 0.1 * Math.abs(blended));
  }

  // When the re-derived headline type differs from the stored strict type, the
  // LLM's strict-era ratification narrative is no longer valid for the flipped
  // headline (e.g. strict "hold — Mixed TFs; safer to wait" → balanced "buy"
  // must not surface the hold reasoning). Clear ratification fields so
  // buildInterpretation falls back to source="algo-only" with the re-blended
  // rulesFired summary. When the type is unchanged, ratification fields are
  // preserved — only the headline conviction shifted, the narrative still
  // applies.
  const typeFlipped = type !== signal.type;

  return {
    ...signal,
    type,
    confidence,
    volatilityFlag: false,
    gateReason: null,
    // gateContext is null here because the non-gated branch produced this
    // return — without explicit clearing, the spread above would propagate the
    // stored signal's gateContext alongside the now-null gateReason.
    gateContext: null,
    rulesFired: Array.from(rulesFiredSet),
    weightsUsed: renormalized,
    // Clear risk — caller (enrichWithRisk) will re-populate for non-hold signals.
    risk: null,
    ...(typeFlipped
      ? {
          ratificationStatus: null,
          ratificationVerdict: null,
          algoVerdict: null,
        }
      : {}),
  };
}

/**
 * Build a post-renormalization weights record for the non-null TFs.
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
