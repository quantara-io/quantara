import ccxt from "ccxt";
import type { Candle, Timeframe } from "@quantara/shared";
import { getSymbol, type ExchangeId, type TradingPair } from "./config.js";
import { storeCandles } from "../lib/candle-store.js";
import { archiveCandles } from "../lib/s3-archive.js";
import { getCursor, saveCursor } from "../lib/metadata-store.js";

const BATCH_SIZE = 500;

interface BackfillOptions {
  exchangeId: ExchangeId;
  pair: TradingPair;
  timeframe: Timeframe;
  days: number;
  archiveToS3?: boolean;
}

export async function backfillCandles(options: BackfillOptions): Promise<number> {
  const { exchangeId, pair, timeframe, days, archiveToS3 = true } = options;

  const metaKey = `backfill:${exchangeId}:${pair}:${timeframe}`;
  const cursor = await getCursor(metaKey);

  const ExchangeClass = ccxt[exchangeId];
  if (!ExchangeClass) {
    throw new Error(`Exchange class not found: ${exchangeId}`);
  }

  const exchange = new ExchangeClass({
    enableRateLimit: true,
    timeout: 30_000,
  });

  const symbol = getSymbol(exchangeId, pair);
  const now = Date.now();
  const since = cursor
    ? new Date(cursor.lastTimestamp).getTime()
    : now - days * 86400 * 1000;

  let fetchSince = since;
  let totalFetched = 0;

  console.log(
    `[Backfill] Starting ${exchangeId} ${pair} ${timeframe} from ${new Date(fetchSince).toISOString()}`
  );

  while (fetchSince < now) {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, fetchSince, BATCH_SIZE);

    if (ohlcv.length === 0) {
      console.log(`[Backfill] No more data at ${new Date(fetchSince).toISOString()}`);
      break;
    }

    const candles: Candle[] = ohlcv
      .filter((row) => row[0] != null)
      .map(([ts, open, high, low, close, volume]) => ({
        exchange: exchangeId,
        symbol,
        pair,
        timeframe,
        openTime: ts!,
        closeTime: ts! + timeframeToMs(timeframe),
        open: open ?? 0,
        high: high ?? 0,
        low: low ?? 0,
        close: close ?? 0,
        volume: volume ?? 0,
        isClosed: ts! + timeframeToMs(timeframe) < now,
      }));

    await storeCandles(candles);
    totalFetched += candles.length;

    if (archiveToS3) {
      const date = new Date(candles[0].openTime).toISOString().slice(0, 10);
      await archiveCandles(exchangeId, pair, `${date}_${timeframe}`, candles);
    }

    const lastEntry = ohlcv[ohlcv.length - 1];
    const lastTs = lastEntry[0] ?? fetchSince;
    fetchSince = lastTs + timeframeToMs(timeframe);

    await saveCursor({
      metaKey,
      lastTimestamp: new Date(fetchSince).toISOString(),
      status: "in_progress",
      updatedAt: new Date().toISOString(),
      metadata: { totalFetched, pair, timeframe },
    });

    console.log(
      `[Backfill] ${totalFetched} candles so far, up to ${new Date(fetchSince).toISOString()}`
    );
  }

  await saveCursor({
    metaKey,
    lastTimestamp: new Date(fetchSince).toISOString(),
    status: "complete",
    updatedAt: new Date().toISOString(),
    metadata: { totalFetched, pair, timeframe },
  });

  console.log(`[Backfill] Complete: ${totalFetched} candles for ${exchangeId} ${pair} ${timeframe}`);
  return totalFetched;
}

function timeframeToMs(tf: Timeframe): number {
  const map: Record<Timeframe, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  };
  return map[tf];
}
