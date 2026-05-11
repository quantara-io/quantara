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
 * Aggregate a coinbase 4h candle from the 4 most-recent closed 1h candles
 * stored in DynamoDB. Coinbase does not expose a native 4h OHLCV endpoint via
 * CCXT, so we synthesize the 4h candle by combining the four hourly bars whose
 * openTimes fall within [targetOpenTime, targetOpenTime + 4h).
 *
 * Returns the aggregated Candle on success, or null when fewer than 4 source
 * candles are available (indicating the hourly bars haven't all arrived yet —
 * better to be honestly stale than emit a partial aggregate).
 */
export async function aggregateCoinbase4hFromHourly(
  pair: TradingPair,
  targetOpenTime: number,
): Promise<Candle | null> {
  const oneHourMs = TF_MS["1h"];
  const fourHourMs = TF_MS["4h"];

  // Expected openTimes of the 4 hourly candles that make up this 4h bar.
  // E.g. if 4h openTime = T, we need 1h candles at T, T+1h, T+2h, T+3h.
  const expectedOpenTimes = [
    targetOpenTime,
    targetOpenTime + oneHourMs,
    targetOpenTime + 2 * oneHourMs,
    targetOpenTime + 3 * oneHourMs,
  ];

  // Fetch the most recent 1h candles. We request 6 to give a buffer against
  // re-delivered or slightly out-of-order rows from the 1h poller, then
  // filter to exactly the 4 we need.
  const rows = await getCandles(pair, "coinbase", "1h", 6);

  const matched = expectedOpenTimes.map((t) => rows.find((r) => r.openTime === t));
  const missing = matched.filter((r) => r === undefined).length;

  if (missing > 0) {
    const found = 4 - missing;
    console.warn(
      `[higher-tf-poller] coinbase 4h aggregation skipped — only ${found}/4 hourly candles available for ${pair} @ openTime=${targetOpenTime}`,
    );
    return null;
  }

  // All 4 source candles are present.
  const sources = matched as Candle[];
  const symbol = getSymbol("coinbase", pair);

  const aggregated: Candle = {
    exchange: "coinbase",
    symbol,
    pair,
    timeframe: "4h",
    openTime: sources[0].openTime,
    closeTime: sources[0].openTime + fourHourMs,
    open: sources[0].open,
    close: sources[sources.length - 1].close,
    high: Math.max(...sources.map((s) => s.high)),
    low: Math.min(...sources.map((s) => s.low)),
    volume: sources.reduce((sum, s) => sum + s.volume, 0),
    isClosed: true,
    source: "live",
  };

  return aggregated;
}

/**
 * Fetch the most recent fully-closed candle for (exchange, pair, tf) and
 * write it as live. Idempotent: writing the same (exchange, pair, tf, openTime)
 * candle twice is a harmless overwrite (storeCandles uses a deterministic key).
 *
 * For coinbase + 4h: Coinbase does not natively support a 4h timeframe via
 * CCXT. Instead we aggregate from the 4 closed 1h candles already stored in
 * DynamoDB. All other (exchange, tf) combinations continue to use fetchOHLCV.
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

  // Coinbase does not expose a native 4h granularity via CCXT. Aggregate from
  // the 4 already-stored 1h candles instead of calling fetchOHLCV.
  if (exchangeId === "coinbase" && tf === "4h") {
    try {
      const candle = await aggregateCoinbase4hFromHourly(pair, targetOpenTime);
      if (!candle) return false; // skip logged inside aggregateCoinbase4hFromHourly
      await storeCandles([candle]);
      return true;
    } catch (err) {
      console.error(
        `[higher-tf-poller] Failed coinbase ${pair} 4h aggregation: ${(err as Error).message}`,
      );
      return false;
    }
  }

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

  // Build one ccxt client per exchange so enableRateLimit can coordinate
  // across (pair, tf) tasks. Otherwise each task spins up its own client
  // and the rate limiter only governs that single in-flight request.
  const clients = buildExchangeClients();

  // For each TF that just closed, fetch one candle per (exchange, pair).
  // Tasks share the per-exchange client (rate-limited) — ccxt serializes
  // requests within a client when enableRateLimit is on.
  const tasks: Promise<boolean>[] = [];
  for (const tf of dueTfs) {
    for (const exchangeId of EXCHANGES) {
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
