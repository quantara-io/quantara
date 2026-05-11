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
 *
 * ## Kraken commit latency
 *
 * Kraken's REST OHLCV endpoint takes 60-120 seconds after a bar closes before
 * the completed bar is visible in the API response. The default 60-second
 * `isCloseBoundary` window (designed to match the 1-minute cron tick) is too
 * narrow: the cron fires at T+0, Lambda initializes by T+2, and `fetchOHLCV`
 * at T+5 finds the bar uncommitted. The next cron tick at T+60s sees
 * `now - lastBoundary ≥ 60_000`, which fails the strict `< 60_000` guard, so
 * Kraken's candle is never fetched for that boundary. The IndicatorHandler
 * then sees Kraken's head candle as one full TF behind the current closeTime
 * and logs "treating as stale" for every 15m/1h/4h close.
 *
 * Fix: widen the close-boundary detection window for Kraken to
 * KRAKEN_BOUNDARY_WINDOW_MS (default 120s, env-configurable). This allows the
 * Lambda invocation at T+60s to still fetch Kraken's just-committed bar, while
 * binanceus/coinbase retain the tight 60s window to avoid spurious refetches.
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
 * Extended close-boundary detection window for Kraken (milliseconds).
 *
 * Kraken's REST OHLCV endpoint has 60-120 seconds of commit latency for the
 * bar that just closed. The standard 60s window (one cron tick) is too narrow:
 * the T+0 invocation finds the bar uncommitted, and the T+60s invocation misses
 * the `< 60_000` guard entirely. By widening to 120s, the T+60s invocation
 * (now = boundary + ~60s) still falls within the Kraken window and retrieves
 * the now-committed bar.
 *
 * Default: 120_000 ms (2 minutes). Must be > 60_000 for the fix to take effect.
 * Configurable via KRAKEN_BOUNDARY_WINDOW_MS env var for tuning without a
 * code change (e.g. set to 90_000 if Kraken's latency improves).
 */
export const KRAKEN_BOUNDARY_WINDOW_MS = (() => {
  const raw = process.env.KRAKEN_BOUNDARY_WINDOW_MS;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
})();

/**
 * Returns true when `now` is within the first minute after a `tf` close boundary.
 *
 * Cron fires at the top of each minute. The candle whose closeTime aligns with
 * the boundary just elapsed is fully closed and ready to fetch. Use a small
 * grace window (60s) to absorb cron jitter and exchange-side commit latency.
 *
 * For Kraken, use isKrakenCloseBoundary instead — it applies a wider window
 * to account for Kraken's longer bar-commit latency.
 */
export function isCloseBoundary(now: number, tf: Timeframe): boolean {
  const tfMs = TF_MS[tf];
  // Most-recent boundary at or before `now`:
  const lastBoundary = Math.floor(now / tfMs) * tfMs;
  // We want this poller to fire shortly after the boundary, not before.
  return now - lastBoundary < 60_000;
}

/**
 * Returns true when `now` falls within KRAKEN_BOUNDARY_WINDOW_MS after the
 * most recent `tf` close boundary.
 *
 * Unlike isCloseBoundary (which uses a strict 60s window matching one cron
 * tick), this uses a wider window so that even the second cron tick after a
 * boundary (T+60s) still triggers a Kraken fetch. The wider window allows the
 * Lambda to retrieve Kraken bars that commit 60-120s after the close.
 *
 * To avoid writing a stale bar from a *previous* boundary on a non-boundary
 * minute (when `now` is far from any boundary), the function only returns true
 * when `now` is within `KRAKEN_BOUNDARY_WINDOW_MS` of the most-recent boundary.
 * Idempotent writes (same primary key) make duplicate writes harmless.
 */
export function isKrakenCloseBoundary(now: number, tf: Timeframe): boolean {
  const tfMs = TF_MS[tf];
  const lastBoundary = Math.floor(now / tfMs) * tfMs;
  return now - lastBoundary < KRAKEN_BOUNDARY_WINDOW_MS;
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

  // Fetch the 8 most recent 1h candles for this pair from coinbase in DDB.
  // We request 8 (2× the required 4) so that if a slightly stale or extra row
  // is present before the window, the window filter below still surfaces the
  // correct 4. getCandles returns descending order (newest first).
  const hourlyCandles = await getCandles(pair, "coinbase", "1h", 8);
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

  // Standard close-boundary TFs (binanceus + coinbase, 60s window).
  const dueTfs = POLLED_TIMEFRAMES.filter((tf) => isCloseBoundary(now, tf));
  // Kraken-specific due TFs: wider window to tolerate Kraken's 60-120s bar
  // commit latency. May include TFs that are no longer in dueTfs (i.e., we
  // are in the second minute after a boundary where isCloseBoundary returned
  // false but isKrakenCloseBoundary still returns true).
  const krakenDueTfs = POLLED_TIMEFRAMES.filter((tf) => isKrakenCloseBoundary(now, tf));

  if (dueTfs.length === 0 && krakenDueTfs.length === 0) {
    return;
  }

  console.log(
    `[higher-tf-poller] Tick at ${new Date(now).toISOString()} — TFs due (standard): ${dueTfs.join(",") || "none"} | Kraken TFs due: ${krakenDueTfs.join(",") || "none"}`,
  );

  // Build one ccxt client per exchange so enableRateLimit can coordinate
  // across (pair, tf) tasks. Otherwise each task spins up its own client
  // and the rate limiter only governs that single in-flight request.
  const clients = buildExchangeClients();

  // Phase 1: fetch + store all native-exchange candles (including coinbase 1h).
  // These writes must complete before Phase 2 reads from DDB, because the
  // coinbase 4h aggregator reads the 1h rows that Phase 1 just wrote.
  // Mixing both phases into a single Promise.allSettled would let the aggregator
  // read DDB before the 1h write settles, reproducing the "only N/4 hourly candles
  // available" skip that issue #321 describes.
  //
  // Kraken uses its own due-TF list (krakenDueTfs) so that second-minute ticks
  // still fetch Kraken candles that were not yet committed at the first-minute tick.
  const fetchTasks: Promise<boolean>[] = [];
  const aggregateTfs: Array<{ tf: Timeframe; pairs: TradingPair[] }> = [];

  // Union of all TFs that need any work so we iterate once.
  const allDueTfs = [...new Set([...dueTfs, ...krakenDueTfs])];

  for (const tf of allDueTfs) {
    for (const exchangeId of EXCHANGES) {
      // Kraken uses its wider boundary window; other exchanges use the standard window.
      const isExchangeDue =
        exchangeId === "kraken" ? krakenDueTfs.includes(tf) : dueTfs.includes(tf);
      if (!isExchangeDue) continue;

      const aggregateFromTf = AGGREGATED_TIMEFRAMES[exchangeId]?.[tf];
      if (aggregateFromTf !== undefined) {
        // Collect aggregation work for Phase 2 — do not start yet.
        if (exchangeId === "coinbase" && tf === "4h") {
          aggregateTfs.push({ tf, pairs: [...PAIRS] });
        }
        continue;
      }
      const exchange = clients[exchangeId];
      if (!exchange) continue; // exchange class missing — already logged
      for (const pair of PAIRS) {
        fetchTasks.push(fetchAndStoreLatestCandle(exchangeId, exchange, pair, tf, now));
      }
    }
  }

  // Await all Phase 1 writes before starting aggregation reads.
  const fetchResults = await Promise.allSettled(fetchTasks);

  // Phase 2: DDB-aggregation tasks that depend on Phase 1 writes being visible.
  const aggregateTasks: Promise<boolean>[] = [];
  for (const { pairs } of aggregateTfs) {
    for (const pair of pairs) {
      aggregateTasks.push(aggregateCoinbase4hFromHourly(pair, now));
    }
  }
  const aggregateResults = await Promise.allSettled(aggregateTasks);

  const allResults = [...fetchResults, ...aggregateResults];
  const ok = allResults.filter((r) => r.status === "fulfilled" && r.value).length;
  const total = fetchTasks.length + aggregateTasks.length;
  console.log(`[higher-tf-poller] Wrote ${ok}/${total} candles`);
};
