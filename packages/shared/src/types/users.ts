import { PAIRS } from "../constants/pairs.js";

import type { RiskProfileMap, RiskProfile } from "./risk.js";

export const USER_TYPES = ["retail", "institutional", "admin"] as const;
export type UserType = (typeof USER_TYPES)[number];

/** Free tier → "conservative"; any paid tier → "moderate". */
export type Tier = "free" | "paid";

/**
 * Map an Aldero tierId string to Quantara's two-value Tier enum.
 *
 * - "111" is the free tier (priceMonthly === 0).
 * - Any other known tierId is a paid tier.
 * - Unknown tierId strings fall back to "free" to avoid accidentally granting
 *   paid defaults to a user whose tier cannot be resolved.
 */
export function tierIdToTier(tierId: string | undefined | null): Tier {
  if (!tierId) return "free";
  return tierId === "111" ? "free" : "paid";
}

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  userType: UserType;
  tierId: string;
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
