/**
 * Core weighted-vote → type/confidence blend math (§5.3 + §5.6 steps 3-7).
 *
 * Extracted so `ingestion/src/signals/blend.ts:blendTimeframeVotes` (write-time)
 * and `packages/shared/src/signals/blend.ts:reblendWithProfile` (read-time) share
 * a single implementation and cannot drift independently.
 *
 * This module is intentionally dependency-free beyond `@quantara/shared` types
 * so it can be imported from either workspace without a circular dependency.
 */

import type { TimeframeVote } from "../types/rules.js";
import type { Timeframe } from "../types/ingestion.js";
import { TIMEFRAMES } from "../types/ingestion.js";

/**
 * Result produced by the core blend step (steps 3-7 of §5.3 + §5.6).
 *
 * Callers (`blendTimeframeVotes`, `reblendWithProfile`) are responsible for
 * assembling the surrounding BlendedSignal envelope (pair, asOf,
 * emittingTimeframe, perTimeframe copy, etc.).
 */
export interface CoreBlendResult {
  type: "buy" | "sell" | "hold";
  confidence: number;
  /** Post-renormalization weight map (non-null TFs sum to 1.0). */
  weightsUsed: Record<Timeframe, number>;
  /** Union of rulesFired from all voting timeframes. */
  rulesFired: string[];
}

/**
 * Execute §5.3 + §5.6 steps 3-7 on a set of per-TF votes.
 *
 * Pre-condition: the caller (step 1) has already checked that at least one
 * vote is non-null, and (step 2) has already established that no vote is
 * gated. Passing a gated or all-null map is a caller contract violation and
 * will produce incorrect output.
 *
 * Algorithm:
 *   3. Collect non-null votes; renormalize weights so they sum to 1.0.
 *   4. Map each vote to scalar in [-1, +1]:
 *        buy/strong-buy   →  +confidence
 *        sell/strong-sell →  -confidence
 *        hold             →   0
 *   5. blended = Σ (renormalizedWeight[tf] · scalar[tf])
 *   6. Single-source damping: if only 1 TF voted → multiply confidence by 0.7.
 *   7. Map blended → headline type + confidence:
 *        blended > +T  → buy,  confidence = min(1, blended * 1.2 [* 0.7 if single-source])
 *        blended < -T  → sell, confidence = same with abs(blended)
 *        else          → hold, confidence = min(1, 0.5 + 0.1 * |blended|)
 *
 * @param perTimeframeVotes  Map of TF → vote. Null votes are skipped (warm-up TFs).
 * @param weights            Per-TF weights (raw, not pre-renormalized).
 * @param threshold          Directional signal threshold T (§5.3).
 */
export function coreBlendVotes(
  perTimeframeVotes: Record<Timeframe, TimeframeVote | null>,
  weights: Record<Timeframe, number>,
  threshold: number,
): CoreBlendResult {
  // Step 3: Collect non-null votes and renormalize weights.
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
  // strong-buy / strong-sell carry the same sign as buy / sell — they map to
  // the same scalar direction; the 5-tier distinction is preserved on
  // TimeframeVote.type for per-TF transparency.
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

  // Step 6: Single-source damping — if only 1 TF has a non-null vote.
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

  return {
    type,
    confidence,
    weightsUsed: renormalized,
    rulesFired: Array.from(rulesFiredSet),
  };
}
