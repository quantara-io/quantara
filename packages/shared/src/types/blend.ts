import type { TradingPair } from "../constants/pairs.js";

import type { Timeframe } from "./ingestion.js";

/**
 * Blend profile — controls the threshold T and per-TF weights used when
 * assembling the headline blended signal from per-TF votes at read time.
 *
 * Three named profiles for v1 (§5.10 escape hatches B/C/D):
 *   strict      — current defaults; long-TF votes dominate; directional signals
 *                 require 4h or 1d co-firing.
 *   balanced    — slightly lower T + boosted 1h weight; 1h alone can push
 *                 through when conviction is high.
 *   aggressive  — lowest T + equal short-TF representation; 15m+1h directional
 *                 signals can surface on quiet long-TF backgrounds.
 *
 * Per-user, per-pair. Stored on UserProfile.blendProfiles. Defaults via
 * defaultBlendProfiles(tier): free → "strict", paid → "balanced".
 *
 * Storage (signals_v2) always uses the strict profile — canonical blend has one
 * ground truth so calibration / outcome attribution is not fragmented.
 * Profile application happens at the API read path only.
 */
export type BlendProfile = "strict" | "balanced" | "aggressive";

/**
 * Per-pair blend profile map. Optional on UserProfile — absent on pre-302 rows.
 * Readers default to "strict" when the map or a per-pair entry is absent.
 */
export type BlendProfileMap = Record<TradingPair, BlendProfile>;

/**
 * Parameters that define a blend profile: threshold T and per-TF weights.
 */
export interface BlendProfileParams {
  /** Threshold above which |blended| maps to a directional signal (§5.3). */
  threshold: number;
  /** Per-TF weights. Must sum to 1.0 across the four blending TFs (15m/1h/4h/1d). */
  weights: Record<Timeframe, number>;
}

/**
 * Canonical blend profile definitions (§5.10 table).
 *
 * | Profile    | T    | 15m  | 1h   | 4h   | 1d   |
 * | ---------- | ---- | ---- | ---- | ---- | ---- |
 * | strict     | 0.25 | 0.15 | 0.20 | 0.30 | 0.35 |
 * | balanced   | 0.22 | 0.10 | 0.25 | 0.30 | 0.35 |
 * | aggressive | 0.18 | 0.15 | 0.25 | 0.30 | 0.30 |
 *
 * Non-blending TFs (1m, 5m) always carry weight 0.
 */
export const BLEND_PROFILES: Record<BlendProfile, BlendProfileParams> = {
  strict: {
    threshold: 0.25,
    weights: {
      "1m": 0,
      "5m": 0,
      "15m": 0.15,
      "1h": 0.2,
      "4h": 0.3,
      "1d": 0.35,
    },
  },
  balanced: {
    threshold: 0.22,
    weights: {
      "1m": 0,
      "5m": 0,
      "15m": 0.1,
      "1h": 0.25,
      "4h": 0.3,
      "1d": 0.35,
    },
  },
  aggressive: {
    threshold: 0.18,
    weights: {
      "1m": 0,
      "5m": 0,
      "15m": 0.15,
      "1h": 0.25,
      "4h": 0.3,
      "1d": 0.3,
    },
  },
};

/**
 * Build the default BlendProfileMap for a new user based on their tier.
 *
 * - free  → "strict" for all pairs (current behavior unchanged)
 * - paid  → "balanced" for all pairs (unlock lower threshold + boosted 1h weight)
 *
 * Parallel to defaultRiskProfiles(tier) in users.ts.
 */
export function defaultBlendProfiles(tier: "free" | "paid"): BlendProfileMap {
  const profile: BlendProfile = tier === "free" ? "strict" : "balanced";
  return {
    "BTC/USDT": profile,
    "ETH/USDT": profile,
    "SOL/USDT": profile,
    "XRP/USDT": profile,
    "DOGE/USDT": profile,
  };
}

/**
 * Look up the active BlendProfile for a pair from a user's BlendProfileMap.
 * Falls back to "strict" when the map is absent or the pair entry is missing.
 */
export function getBlendProfile(
  blendProfiles: BlendProfileMap | undefined,
  pair: TradingPair,
): BlendProfile {
  return blendProfiles?.[pair] ?? "strict";
}

/**
 * Merge a tier-change update into an existing BlendProfileMap, preserving
 * user overrides. Only pairs whose current profile matches the previous
 * tier's default are updated to the new tier's default.
 *
 * Parallel to mergeTierRiskProfiles in users.ts. When current is undefined
 * (pre-302 record), seeds the full defaults for the new tier so the field
 * is always populated after tier change.
 *
 * @param current      The user's current blendProfiles map (or undefined).
 * @param previousTier The tier the user is upgrading/downgrading from.
 * @param newTier      The tier the user is moving to.
 */
export function mergeTierBlendProfiles(
  current: BlendProfileMap | undefined,
  previousTier: "free" | "paid",
  newTier: "free" | "paid",
): BlendProfileMap {
  const defaults = defaultBlendProfiles(newTier);
  if (!current) return defaults;
  const previousDefault: BlendProfile = previousTier === "free" ? "strict" : "balanced";
  const newDefault: BlendProfile = newTier === "free" ? "strict" : "balanced";
  const result: BlendProfileMap = { ...current };
  for (const pair of Object.keys(defaults) as (keyof BlendProfileMap)[]) {
    if (result[pair] === previousDefault) {
      result[pair] = newDefault;
    } else if (result[pair] === undefined) {
      // Pair missing from old map (pre-302 partial record) — seed new default.
      result[pair] = newDefault;
    }
  }
  return result;
}
