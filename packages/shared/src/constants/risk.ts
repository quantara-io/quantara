import type { RiskProfile } from "../types/risk.js";

export const RISK_PCT: Record<RiskProfile, number> = {
  conservative: 0.005, // 0.5% per trade
  moderate: 0.010, // 1.0%
  aggressive: 0.020, // 2.0%
};

export const STOP_MULTIPLIER_ATR: Record<RiskProfile, number> = {
  conservative: 1.5,
  moderate: 2.0,
  aggressive: 3.0,
};

export const TP_R_MULTIPLES: Record<RiskProfile, [number, number, number]> = {
  conservative: [1, 2, 3],
  moderate: [1, 2, 5],
  aggressive: [1, 3, 8],
};

export const TP_CLOSE_PCT: [number, number, number] = [0.50, 0.25, 0.25];

export const TRAILING_STOP_ATR_MULTIPLIER = 2;

export const KELLY_UNLOCK = {
  minResolved: 50,
  pMin: 0.45,
  pMax: 0.65,
  bMin: 0.5,
  bMax: 3.0,
  fractionalCap: 0.25, // hard 25% Kelly cap
};

export const DRAWDOWN_CAPS: Record<
  RiskProfile,
  { daily: number; weekly: number; concurrent: number }
> = {
  conservative: { daily: 0.02, weekly: 0.05, concurrent: 1 },
  moderate: { daily: 0.03, weekly: 0.07, concurrent: 1 },
  aggressive: { daily: 0.05, weekly: 0.12, concurrent: 2 },
};
