export interface SymbolMeta {
  pair: string;
  symbol: string;
  name: string;
  asset: "btc" | "eth" | "sol" | "xrp" | "doge" | "avax" | "link";
}

/**
 * Default watchlist for the workstation. Mirrors PAIRS from the backend's
 * Market endpoint; no per-user customization yet (PR #2 ships with a fixed list).
 */
export const WATCHLIST: SymbolMeta[] = [
  { pair: "BTC/USDT", symbol: "BTC", name: "Bitcoin", asset: "btc" },
  { pair: "ETH/USDT", symbol: "ETH", name: "Ethereum", asset: "eth" },
  { pair: "SOL/USDT", symbol: "SOL", name: "Solana", asset: "sol" },
  { pair: "XRP/USDT", symbol: "XRP", name: "XRP", asset: "xrp" },
  { pair: "DOGE/USDT", symbol: "DOGE", name: "Dogecoin", asset: "doge" },
];

export const DEFAULT_PAIR = WATCHLIST[0].pair;
export const DEFAULT_EXCHANGE = "binanceus";

export function metaForPair(pair: string): SymbolMeta {
  return WATCHLIST.find((s) => s.pair === pair) ?? WATCHLIST[0];
}
