import type { TradingPair } from "./pairs.js";

/**
 * Annualized realized-volatility cutoffs. When realized vol exceeds the threshold,
 * the volatility gate fires and the timeframe vote is forced to `hold`.
 *
 * v1 uses absolute per-pair thresholds for cold-start safety. Migrate to a
 * 30-day z-score in v2 once history exists.
 */
export const VOL_GATE_THRESHOLDS: Record<TradingPair, number> = {
  "BTC/USDT": 1.50, // 150% annualized
  "ETH/USDT": 2.00,
  "SOL/USDT": 3.00,
  "XRP/USDT": 2.50,
  "DOGE/USDT": 3.50,
};
