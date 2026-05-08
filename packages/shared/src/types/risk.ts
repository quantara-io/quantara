import type { TradingPair } from "../constants/pairs.js";

export type RiskProfile = "conservative" | "moderate" | "aggressive";

export type RiskProfileMap = Record<TradingPair, RiskProfile>;

export interface RiskRecommendation {
  pair: string;
  profile: RiskProfile;
  positionSizePct: number; // % of account
  positionSizeModel: "fixed" | "vol-targeted" | "kelly";
  stopLoss: number; // price
  stopDistanceR: number; // ATR × multiplier
  takeProfit: { price: number; closePct: number; rMultiple: number }[];
  invalidationCondition: string; // human-readable, mobile UX
  trailingStopAfterTP2: { multiplier: number; reference: "ATR" };
}

export interface DrawdownState {
  dailyLoss: number;
  weeklyLoss: number;
  concurrentPositions: number;
  lastResetDaily: string; // ISO date
  lastResetWeekly: string; // ISO date
}
