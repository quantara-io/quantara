import type { TradingPair } from "./pairs.js";

export const VOL_GATE_THRESHOLDS: Record<TradingPair, number> = {
  "BTC/USDT": 1.50,    // 150% annualized
  "ETH/USDT": 2.00,
  "SOL/USDT": 3.00,
  "XRP/USDT": 2.50,
  "DOGE/USDT": 3.50,
};
