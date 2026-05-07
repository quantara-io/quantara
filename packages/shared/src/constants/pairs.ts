export const PAIRS = [
  "BTC/USDT",
  "ETH/USDT",
  "SOL/USDT",
  "XRP/USDT",
  "DOGE/USDT",
] as const;

export type TradingPair = (typeof PAIRS)[number];
