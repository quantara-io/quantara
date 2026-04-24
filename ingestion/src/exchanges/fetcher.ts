import ccxt from "ccxt";
import { EXCHANGES, PAIRS, getSymbol, type ExchangeId, type TradingPair } from "./config.js";

export interface PriceSnapshot {
  exchange: ExchangeId;
  pair: TradingPair;
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume24h: number;
  timestamp: string;
  stale: boolean;
}

const STALE_THRESHOLD_MS = 60_000; // 1 minute

export async function fetchAllPrices(): Promise<PriceSnapshot[]> {
  const results: PriceSnapshot[] = [];
  const errors: { exchange: string; error: string }[] = [];

  const fetchPromises = EXCHANGES.map(async (exchangeId) => {
    const ExchangeClass = ccxt[exchangeId];
    if (!ExchangeClass) {
      errors.push({ exchange: exchangeId, error: `Exchange class not found` });
      return;
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      timeout: 10_000,
    });

    for (const pair of PAIRS) {
      const symbol = getSymbol(exchangeId, pair);
      try {
        const ticker = await exchange.fetchTicker(symbol);
        const now = Date.now();
        const tickerTs = ticker.timestamp ?? now;
        const stale = now - tickerTs > STALE_THRESHOLD_MS;

        results.push({
          exchange: exchangeId,
          pair,
          symbol,
          price: ticker.last ?? 0,
          bid: ticker.bid ?? 0,
          ask: ticker.ask ?? 0,
          volume24h: ticker.quoteVolume ?? ticker.baseVolume ?? 0,
          timestamp: new Date(tickerTs).toISOString(),
          stale,
        });
      } catch (err) {
        errors.push({
          exchange: exchangeId,
          error: `${pair}: ${(err as Error).message}`,
        });
      }
    }
  });

  await Promise.all(fetchPromises);

  if (errors.length > 0) {
    console.warn("[Ingestion] Errors:", JSON.stringify(errors));
  }

  console.log(`[Ingestion] Fetched ${results.length} prices from ${EXCHANGES.length} exchanges`);
  return results;
}
