import type { RiskProfileMap, DrawdownState } from "./risk.js";

export const USER_TYPES = ["retail", "institutional", "admin"] as const;
export type UserType = (typeof USER_TYPES)[number];

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
  /** Per-pair risk profile, keyed by TradingPair. Populated at user create/upgrade time. */
  riskProfiles?: RiskProfileMap;
  /** Drawdown tracking state — written by Phase 9+ position marking. Optional until then. */
  drawdownState?: DrawdownState;
}
