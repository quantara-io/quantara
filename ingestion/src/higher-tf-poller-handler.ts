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

import { storeCandles, getCandles } from "./lib/candle-store.js";
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

// One ccxt client per (exchange, invocation). Sharing the instance across
// (pair, tf) tasks lets ccxt's enableRateLimit actually coordinate — otherwise
// each task creates its own client and they all hit the exchange in parallel
// with independent rate limiters, defeating the purpose.
type CcxtExchange = InstanceType<(typeof ccxt)[ExchangeId]>;
function buildExchangeClients(): Partial<Record<ExchangeId, CcxtExchange>> {
  const clients: Partial<Record<ExchangeId, CcxtExchange>> = {};
  for (const exchangeId of EXCHANGES) {
    const ExchangeClass = ccxt[exchangeId];
    if (!ExchangeClass) {
      console.error(`[higher-tf-poller] Exchange class not found: ${exchangeId}`);
      continue;
    }
    clients[exchangeId] = new ExchangeClass({ enableRateLimit: true, timeout: 15_000 });
  }
  return clients;
}

/**
 * Fetch the most recent fully-closed candle for (exchange, pair, tf) and
 * write it as live. Idempotent: writing the same (exchange, pair, tf, openTime)
 * candle twice is a harmless overwrite (storeCandles uses a deterministic key).
 *
 * Takes the shared ccxt client for the exchange so rate-limit coordination works.
 */
async function fetchAndStoreLatestCandle(
  exchangeId: ExchangeId,
  exchange: CcxtExchange,
  pair: TradingPair,
  tf: Timeframe,
  now: number,
): Promise<boolean> {
  // We need the candle whose closeTime <= now. Its openTime is one tfMs earlier.
  const tfMs = TF_MS[tf];
  const lastBoundary = Math.floor(now / tfMs) * tfMs;
  const targetOpenTime = lastBoundary - tfMs;

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

/**
 * Exchanges that do not natively support a given timeframe and must be handled
 * by aggregating from a finer-grained timeframe already stored in DynamoDB.
 *
 * Coinbase exposes 1m/5m/15m/30m/1h/2h/6h/1d — no native 4h. We build 4h by
 * reading the 4 most recent closed 1h candles for that pair from DDB and
 * rolling them up. This avoids a round-trip to the exchange for a timeframe
 * it cannot serve, and keeps the consensus quorum at 3 instead of 2.
 */
const AGGREGATED_TIMEFRAMES: Partial<Record<ExchangeId, Partial<Record<Timeframe, Timeframe>>>> = {
  coinbase: { "4h": "1h" },
};

/**
 * Aggregate a synthetic 4h candle for coinbase from its stored 1h candles.
 *
 * Queries DDB for the 4 most recent closed 1h candles whose openTime falls
 * within the closed 4h window [boundary - 4h, boundary). Returns true when
 * the aggregated candle is written, false when there are not enough source
 * candles (< 4) — logs a single warning in that case.
 *
 * Exported for unit testing; not part of the public API.
 */
export async function aggregateCoinbase4hFromHourly(
  pair: TradingPair,
  now: number,
): Promise<boolean> {
  const tfMs4h = TF_MS["4h"];
  const tfMs1h = TF_MS["1h"];

  // The 4h window that just closed: [windowStart, windowEnd)
  const windowEnd = Math.floor(now / tfMs4h) * tfMs4h;
  const windowStart = windowEnd - tfMs4h;

  // Fetch the 4 most recent 1h candles for this pair from coinbase in DDB.
  // getCandles returns descending order (newest first), so we need to reverse.
  const hourlyCandles = await getCandles(pair, "coinbase", "1h", 4);
  // Reverse to ascending (oldest first) for correct open/close assignment.
  const ascending = [...hourlyCandles].reverse();

  // Filter to only those candles whose openTime falls within the 4h window.
  const windowCandles = ascending.filter(
    (c) => c.openTime >= windowStart && c.openTime < windowEnd,
  );

  if (windowCandles.length < 4) {
    console.warn(
      `[higher-tf-poller] coinbase 4h aggregation skipped — only ${windowCandles.length}/4 hourly candles available (pair=${pair} window=${new Date(windowStart).toISOString()})`,
    );
    return false;
  }

  // Sanity-check: each source candle should span exactly 1h (no gaps).
  for (let i = 1; i < windowCandles.length; i++) {
    if (windowCandles[i]!.openTime !== windowCandles[i - 1]!.openTime + tfMs1h) {
      console.warn(
        `[higher-tf-poller] coinbase 4h aggregation skipped — non-contiguous 1h candles for ${pair} @ ${new Date(windowStart).toISOString()}`,
      );
      return false;
    }
  }

  const first = windowCandles[0]!;
  const last = windowCandles[windowCandles.length - 1]!;

  const aggregated: Candle = {
    exchange: "coinbase",
    symbol: getSymbol("coinbase", pair),
    pair,
    timeframe: "4h",
    openTime: first.openTime,
    closeTime: last.closeTime,
    open: first.open,
    close: last.close,
    high: Math.max(...windowCandles.map((c) => c.high)),
    low: Math.min(...windowCandles.map((c) => c.low)),
    volume: windowCandles.reduce((sum, c) => sum + c.volume, 0),
    isClosed: true,
    source: "live",
    aggregatedFrom: "1h×4",
  };

  await storeCandles([aggregated]);
  return true;
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

  // Build one ccxt client per exchange so enableRateLimit can coordinate
  // across (pair, tf) tasks. Otherwise each task spins up its own client
  // and the rate limiter only governs that single in-flight request.
  const clients = buildExchangeClients();

  // For each TF that just closed, fetch one candle per (exchange, pair).
  // Tasks share the per-exchange client (rate-limited) — ccxt serializes
  // requests within a client when enableRateLimit is on.
  // Exchanges that cannot serve a given TF natively (e.g. coinbase has no 4h)
  // are routed to the DDB-aggregation path instead of fetchOHLCV.
  const tasks: Promise<boolean>[] = [];
  for (const tf of dueTfs) {
    for (const exchangeId of EXCHANGES) {
      const aggregateFromTf = AGGREGATED_TIMEFRAMES[exchangeId]?.[tf];
      if (aggregateFromTf !== undefined) {
        // This exchange + TF combination must be synthesised from stored finer candles.
        if (exchangeId === "coinbase" && tf === "4h") {
          for (const pair of PAIRS) {
            tasks.push(aggregateCoinbase4hFromHourly(pair, now));
          }
        }
        continue;
      }
      const exchange = clients[exchangeId];
      if (!exchange) continue; // exchange class missing — already logged
      for (const pair of PAIRS) {
        tasks.push(fetchAndStoreLatestCandle(exchangeId, exchange, pair, tf, now));
      }
    }
  }

  const results = await Promise.allSettled(tasks);
  const ok = results.filter((r) => r.status === "fulfilled" && r.value).length;
  console.log(`[higher-tf-poller] Wrote ${ok}/${tasks.length} candles`);
};
