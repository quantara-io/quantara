import type { RiskProfileMap, RiskProfile } from "./risk.js";
import { PAIRS } from "../constants/pairs.js";

export const USER_TYPES = ["retail", "institutional", "admin"] as const;
export type UserType = (typeof USER_TYPES)[number];

/** Free tier → "conservative"; any paid tier → "moderate". */
export type Tier = "free" | "paid";

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
   * Per-pair risk profiles. Optional — legacy DDB records without this field
   * get the tier default at read time via getEffectiveRiskProfiles().
   * Populated at user creation and updated on tier change by defaultRiskProfiles().
   * Users may override individual pairs in settings (future UI).
   *
   * Design: §9.2 of docs/SIGNALS_AND_RISK.md / Fix 1 (Correction 3 — Option A)
   */
  riskProfiles?: RiskProfileMap;
}

/**
 * Map a tierId string to the coarse Tier discriminant used for risk defaults.
 * Tier "111" is the free tier (priceMonthly=0); all others are considered paid.
 */
export function tierIdToTier(tierId: string): Tier {
  return tierId === "111" ? "free" : "paid";
}

/**
 * Return the user's effective risk profile map.
 *
 * If the user record has no riskProfiles (legacy or brand-new record before
 * the backend write fires), fall back to the tier default. This is Correction 3
 * (Option A) — no migration needed; existing users without the field work correctly.
 *
 * @param user  A UserProfile (riskProfiles may be absent on old DDB records).
 */
export function getEffectiveRiskProfiles(user: UserProfile): RiskProfileMap {
  return user.riskProfiles ?? defaultRiskProfiles(tierIdToTier(user.tierId));
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
