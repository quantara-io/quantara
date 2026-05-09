/**
 * higher-tf-poller-handler.ts — EventBridge-triggered Lambda that produces live
 * higher-TF candles (15m / 1h / 4h / 1d) by calling fetchOHLCV on each
 * (exchange, pair, timeframe) combination on close-boundary minutes.
 *
 * Runs once per minute via EventBridge cron(* * * * ? *). For each TF,
 * checks whether the current minute is a close-boundary for that TF; if so,
 * fetches the most recent fully-closed candle and writes it to the candles
 * table with `source: "live"`.
 *
 * Required by the v6 design (§5.9 + §12.3): the IndicatorLambda is now triggered
 * by DDB Streams on the candles table with FilterCriteria
 * `{ source: "live", timeframe: ["15m","1h","4h","1d"] }`. Without a live
 * higher-TF writer, no candles match the filter and zero signals get computed.
 *
 * MarketStreamManager (CCXT Pro) only writes 1m candles. backfillCandles tags
 * its output as "backfill". This poller fills the gap.
 */
import ccxt from "ccxt";
import type { Candle, Timeframe } from "@quantara/shared";

import { storeCandles } from "./lib/candle-store.js";
import {
  EXCHANGES,
  PAIRS,
  getSymbol,
  type ExchangeId,
  type TradingPair,
} from "./exchanges/config.js";

// Timeframes this poller handles. 1m and 5m are covered elsewhere
// (1m by MarketStreamManager via CCXT Pro; 5m is not part of the
// blender — see §5.2). Add 5m here only if/when 1m/5m signal collection
// (#133) lands.
const POLLED_TIMEFRAMES: readonly Timeframe[] = ["15m", "1h", "4h", "1d"];

const TF_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

interface ScheduledEvent {
  // EventBridge scheduled event shape (we only need to know the trigger time).
  time?: string;
}

/**
 * Returns true when `now` is within the first minute after a `tf` close boundary.
 *
 * Cron fires at the top of each minute. The candle whose closeTime aligns with
 * the boundary just elapsed is fully closed and ready to fetch. Use a small
 * grace window (60s) to absorb cron jitter and exchange-side commit latency.
 */
function isCloseBoundary(now: number, tf: Timeframe): boolean {
  const tfMs = TF_MS[tf];
  // Most-recent boundary at or before `now`:
  const lastBoundary = Math.floor(now / tfMs) * tfMs;
  // We want this poller to fire shortly after the boundary, not before.
  return now - lastBoundary < 60_000;
}

/**
 * Fetch the most recent fully-closed candle for (exchange, pair, tf) and
 * write it as live. Idempotent: writing the same (exchange, pair, tf, openTime)
 * candle twice is a harmless overwrite (storeCandles uses a deterministic key).
 */
async function fetchAndStoreLatestCandle(
  exchangeId: ExchangeId,
  pair: TradingPair,
  tf: Timeframe,
  now: number,
): Promise<boolean> {
  // We need the candle whose closeTime <= now. Its openTime is one tfMs earlier.
  const tfMs = TF_MS[tf];
  const lastBoundary = Math.floor(now / tfMs) * tfMs;
  const targetOpenTime = lastBoundary - tfMs;

  const ExchangeClass = ccxt[exchangeId];
  if (!ExchangeClass) {
    console.error(`[higher-tf-poller] Exchange class not found: ${exchangeId}`);
    return false;
  }

  const exchange = new ExchangeClass({ enableRateLimit: true, timeout: 15_000 });
  const symbol = getSymbol(exchangeId, pair);

  try {
    // Fetch a small window centered around our target open time. Some exchanges
    // return more than asked; we filter to the exact target below.
    const ohlcv = await exchange.fetchOHLCV(symbol, tf, targetOpenTime, 2);
    const row = ohlcv.find((r) => r[0] === targetOpenTime);
    if (!row) {
      console.log(
        `[higher-tf-poller] No candle returned for ${exchangeId} ${pair} ${tf} @ openTime=${targetOpenTime}`,
      );
      return false;
    }

    const [ts, open, high, low, close, volume] = row;
    const candle: Candle = {
      exchange: exchangeId,
      symbol,
      pair,
      timeframe: tf,
      openTime: ts!,
      closeTime: ts! + tfMs,
      open: Number(open ?? 0),
      high: Number(high ?? 0),
      low: Number(low ?? 0),
      close: Number(close ?? 0),
      volume: Number(volume ?? 0),
      isClosed: true,
      source: "live",
    };

    await storeCandles([candle]);
    return true;
  } catch (err) {
    console.error(
      `[higher-tf-poller] Failed ${exchangeId} ${pair} ${tf}: ${(err as Error).message}`,
    );
    return false;
  }
}

export const handler = async (event: ScheduledEvent): Promise<void> => {
  const now = event.time ? Date.parse(event.time) : Date.now();

  const dueTfs = POLLED_TIMEFRAMES.filter((tf) => isCloseBoundary(now, tf));
  if (dueTfs.length === 0) {
    return;
  }

  console.log(
    `[higher-tf-poller] Tick at ${new Date(now).toISOString()} — TFs due: ${dueTfs.join(",")}`,
  );

  // For each TF that just closed, fetch one candle per (exchange, pair).
  // Run all fetches in parallel — each is independent and storeCandles
  // is idempotent.
  const tasks: Promise<boolean>[] = [];
  for (const tf of dueTfs) {
    for (const exchangeId of EXCHANGES) {
      for (const pair of PAIRS) {
        tasks.push(fetchAndStoreLatestCandle(exchangeId, pair, tf, now));
      }
    }
  }

  const results = await Promise.allSettled(tasks);
  const ok = results.filter((r) => r.status === "fulfilled" && r.value).length;
  console.log(`[higher-tf-poller] Wrote ${ok}/${tasks.length} candles`);
};
