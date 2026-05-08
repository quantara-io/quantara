import type { TradingPair } from "./pairs.js";

export const VOL_GATE_THRESHOLDS: Record<TradingPair, number> = {
  "BTC/USDT": 1.5, // 150% annualized
  "ETH/USDT": 2.0,
  "SOL/USDT": 3.0,
  "XRP/USDT": 2.5,
  "DOGE/USDT": 3.5,
};
