import type { TradingPair } from "@quantara/shared";
export { PAIRS } from "@quantara/shared";
export type { TradingPair };

export const EXCHANGES = ["binanceus", "coinbase", "kraken"] as const;
export type ExchangeId = (typeof EXCHANGES)[number];

// Some exchanges use different quote currencies
export const PAIR_OVERRIDES: Partial<Record<ExchangeId, Partial<Record<TradingPair, string>>>> = {
  coinbase: {
    "BTC/USDT": "BTC/USD",
    "ETH/USDT": "ETH/USD",
    "SOL/USDT": "SOL/USD",
    "XRP/USDT": "XRP/USD",
    "DOGE/USDT": "DOGE/USD",
  },
};

export function getSymbol(exchange: ExchangeId, pair: TradingPair): string {
  return PAIR_OVERRIDES[exchange]?.[pair] ?? pair;
}
