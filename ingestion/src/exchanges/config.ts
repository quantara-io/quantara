export const EXCHANGES = ["binanceus", "coinbase", "kraken"] as const;
export type ExchangeId = (typeof EXCHANGES)[number];

export const PAIRS = [
  "BTC/USDT",
  "ETH/USDT",
  "SOL/USDT",
  "XRP/USDT",
  "DOGE/USDT",
] as const;
export type TradingPair = (typeof PAIRS)[number];

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
