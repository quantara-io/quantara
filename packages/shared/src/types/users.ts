import { PAIRS } from "../constants/pairs.js";

import type { RiskProfileMap, RiskProfile } from "./risk.js";
import type { BlendProfileMap } from "./blend.js";

export const USER_TYPES = ["retail", "institutional", "admin"] as const;
export type UserType = (typeof USER_TYPES)[number];

/** Free tier → "conservative"; any paid tier → "moderate". */
export type Tier = "free" | "paid";

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  userType: UserType;
  /**
   * Subscription tier. Optional for backwards-compatibility — existing DDB records
   * without this field default to "free" on read (see getOrCreateUserRecord).
   * Replaces the old `tierId: string` field (renamed for clarity; "free"/"paid" are
   * not opaque identifiers, they are the canonical Tier values).
   */
  tier?: Tier;
  bio?: string;
  professionalBackground?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Per-pair risk profiles. Non-optional — every user record must carry this.
   * Populated at user creation and updated on tier change by defaultRiskProfiles().
   * Users may override individual pairs in settings (future UI).
   *
   * Design: §9.2 of docs/SIGNALS_AND_RISK.md / Fix 1
   */
  riskProfiles: RiskProfileMap;
  /**
   * Per-pair blend profiles. Optional for backwards-compatibility — existing DDB
   * records without this field default to "strict" on read (see getBlendProfile).
   * Populated at user creation by defaultBlendProfiles() and updated on tier change.
   * Users may override individual pairs via PATCH /users/me/settings (companion issue).
   *
   * Design: §5.10 of docs/SIGNALS_AND_RISK.md (escape hatch — profile applied at read path).
   * Storage (signals_v2) always uses strict — canonical blend has one ground truth.
   */
  blendProfiles?: BlendProfileMap;
}

/**
 * Build the default RiskProfileMap for a new user based on their tier.
 *
 * - free  → "conservative" for all pairs
 * - paid  → "moderate" for all pairs
 *
 * On tier change, callers should only update pairs that still match the
 * previous default (preserving any per-pair overrides the user set).
 */
export function defaultRiskProfiles(tier: Tier): RiskProfileMap {
  const profile: RiskProfile = tier === "free" ? "conservative" : "moderate";
  return Object.fromEntries(PAIRS.map((p) => [p, profile])) as RiskProfileMap;
}

/**
 * Merge a tier-change update into an existing RiskProfileMap, preserving user
 * overrides. Only pairs whose current profile matches the previous default are
 * updated to the new default.
 *
 * @param current      The user's current riskProfiles map.
 * @param previousTier The tier the user is upgrading/downgrading from.
 * @param newTier      The tier the user is moving to.
 */
export function mergeTierRiskProfiles(
  current: RiskProfileMap,
  previousTier: Tier,
  newTier: Tier,
): RiskProfileMap {
  const previousDefault: RiskProfile = previousTier === "free" ? "conservative" : "moderate";
  const newDefault: RiskProfile = newTier === "free" ? "conservative" : "moderate";
  const result = { ...current };
  for (const pair of PAIRS) {
    if (result[pair] === previousDefault) {
      result[pair] = newDefault;
    }
  }
  return result;
}
