export const TIER_IDS = ["111", "222", "333", "444", "555", "666", "777", "888", "999"] as const;
export type TierId = (typeof TIER_IDS)[number];

export interface TierFeatures {
  "genie.signals": boolean;
  "genie.history": boolean;
  "coach.sessions": boolean;
  "coach.history": boolean;
  "dealflow.browse": boolean;
  "dealflow.post": boolean;
  "dealflow.interest": boolean;
  "marketing.email": boolean;
  "marketing.phone": boolean;
  "admin.access": boolean;
}

export interface TierGrants {
  signalsPerDay: number;
  coachMessagesPerMonth: number;
  dealPostsPerMonth: number;
  emailsPerMonth: number;
  callsPerMonth: number;
}

export interface TierDefinition {
  id: TierId;
  name: string;
  description: string;
  features: TierFeatures;
  grants: TierGrants;
  priceMonthly: number;
  priceYearly: number;
}
