import ccxt from "ccxt";
import type { Candle, Timeframe } from "@quantara/shared";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

import { storeCandles } from "../lib/candle-store.js";
import { storePriceSnapshots } from "../lib/store.js";

import { EXCHANGES, PAIRS, getSymbol, type ExchangeId, type TradingPair } from "./config.js";
import type { PriceSnapshot } from "./fetcher.js";

const WATCHDOG_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 5 * 60_000;
const RECONNECT_THRESHOLD_MS = 10 * 60_000;
const COINBASE_BACKFILL_INTERVAL_MS = 30_000;

/**
 * Shape of a single OHLCV row returned by ccxt's `fetchOHLCV` / `watchOHLCV`.
 * ts (open-timestamp ms) is reliably a number across adapters; the numeric
 * slots (open/high/low/close/volume) are typed as `string | number | null`
 * because adapters disagree — Kraken returns strings, Binance returns
 * numbers, both can return null for missing fields. We coerce internally
 * via `Number(... ?? 0)`.
 */
export type OhlcvRow = [number, ...(string | number | null)[]];

interface StreamState {
  exchange: ExchangeId;
  pair: TradingPair;
  lastDataAt: number;
  running: boolean;
  /** Per-stream abort controller so the watchdog can restart one stream without affecting others. */
  abortController: AbortController;
}

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

export class MarketStreamManager {
  private streams: Map<string, StreamState> = new Map();
  private exchanges: Map<ExchangeId, any> = new Map();
  /** Manager-wide controller: aborted only on stop() to tear down everything. */
  private abortController = new AbortController();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks the last closeTime (ms) we successfully wrote for each coinbase pair. */
  private coinbaseLastCloseTime: Map<TradingPair, number> = new Map();
  /** DynamoDB document client — created per-instance so mocks are applied correctly in tests. */
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor() {
    this.ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  getStatus(): Record<string, any> {
    const connections: Record<string, any> = {};
    for (const [key, state] of this.streams) {
      connections[key] = {
        running: state.running,
        lastDataAt: state.lastDataAt ? new Date(state.lastDataAt).toISOString() : null,
        stale: state.lastDataAt ? Date.now() - state.lastDataAt > STALE_THRESHOLD_MS : true,
      };
    }
    return { streams: connections, totalStreams: this.streams.size };
  }

  async start(): Promise<void> {
    console.log("[Stream] Starting market stream manager...");

    for (const exchangeId of EXCHANGES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ProExchange = (ccxt.pro as any)[exchangeId];
      if (!ProExchange) {
        console.warn(`[Stream] No Pro support for ${exchangeId}, skipping`);
        continue;
      }

      const exchange = new ProExchange({
        enableRateLimit: true,
        timeout: 30_000,
      });
      this.exchanges.set(exchangeId, exchange);

      const supportsOHLCV = !!exchange.has?.watchOHLCV;
      if (!supportsOHLCV) {
        if (exchangeId === "coinbase") {
          console.log(`[Stream] ${exchangeId} has no watchOHLCV; using REST backfill instead`);
        } else {
          console.warn(`[Stream] ${exchangeId} does not support watchOHLCV; skipping OHLCV stream`);
        }
      }

      for (const pair of PAIRS) {
        const key = `${exchangeId}:${pair}`;
        this.streams.set(key, {
          exchange: exchangeId,
          pair,
          lastDataAt: 0,
          running: false,
          abortController: new AbortController(),
        });

        this.startTickerStream(exchangeId, exchange, pair);
        if (supportsOHLCV) {
          this.startOHLCVStream(exchangeId, exchange, pair);
        } else if (exchangeId === "coinbase") {
          // Coinbase Advanced Trade WS has no candles channel.
          // Use REST polling instead so coinbase contributes to close-quorum.
          this.startCoinbaseBackfillLoop(exchange, pair);
        }
      }
    }

    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);
    console.log(
      `[Stream] Started ${this.streams.size} streams across ${this.exchanges.size} exchanges`,
    );
  }

  async stop(): Promise<void> {
    console.log("[Stream] Stopping...");
    // Abort the manager-wide controller first so every stream loop exits.
    this.abortController.abort();
    // Also abort each per-stream controller to unblock any sleeping loops.
    for (const state of this.streams.values()) {
      state.abortController.abort();
    }

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }

    for (const exchange of this.exchanges.values()) {
      try {
        await exchange.close();
      } catch {
        // ignore close errors during shutdown
      }
    }

    console.log("[Stream] Stopped.");
  }

  private startTickerStream(exchangeId: ExchangeId, exchange: any, pair: TradingPair): void {
    const symbol = getSymbol(exchangeId, pair);
    const key = `${exchangeId}:${pair}`;

    // Capture the per-stream signal at start time so the while-loop guard
    // remains bound to THIS invocation's abort controller even if the watchdog
    // replaces state.abortController for a future restart.
    const streamSignal = this.streams.get(key)?.abortController.signal;

    const run = async () => {
      while (!this.abortController.signal.aborted && !streamSignal?.aborted) {
        try {
          const ticker = await exchange.watchTicker(symbol);
          const state = this.streams.get(key);
          if (state) state.lastDataAt = Date.now();

          const snapshot: PriceSnapshot = {
            exchange: exchangeId,
            pair,
            symbol,
            price: ticker.last ?? 0,
            bid: ticker.bid ?? 0,
            ask: ticker.ask ?? 0,
            volume24h: ticker.quoteVolume ?? ticker.baseVolume ?? 0,
            timestamp: new Date(ticker.timestamp ?? Date.now()).toISOString(),
            stale: false,
          };

          await storePriceSnapshots([snapshot]);
        } catch (err) {
          if (this.abortController.signal.aborted || streamSignal?.aborted) break;
          console.error(`[Stream] Ticker error ${key}: ${(err as Error).message}`);
          await sleep(5000);
        }
      }
    };

    run().catch((err) => {
      if (!this.abortController.signal.aborted) {
        console.error(`[Stream] Ticker loop fatal ${key}: ${(err as Error).message}`);
      }
    });
  }

  private startOHLCVStream(exchangeId: ExchangeId, exchange: any, pair: TradingPair): void {
    const symbol = getSymbol(exchangeId, pair);
    const key = `${exchangeId}:${pair}`;
    const timeframe: Timeframe = "1m";

    // Capture signal at invocation time — same reasoning as startTickerStream.
    const streamSignal = this.streams.get(key)?.abortController.signal;

    const run = async () => {
      while (!this.abortController.signal.aborted && !streamSignal?.aborted) {
        try {
          const ohlcv = await exchange.watchOHLCV(symbol, timeframe);

          for (const [ts, open, high, low, close, volume] of ohlcv) {
            if (ts == null) continue;

            const candle: Candle = {
              exchange: exchangeId,
              symbol,
              pair,
              timeframe,
              openTime: ts,
              closeTime: ts + 60_000,
              open: Number(open ?? 0),
              high: Number(high ?? 0),
              low: Number(low ?? 0),
              close: Number(close ?? 0),
              volume: Number(volume ?? 0),
              isClosed: ts + 60_000 < Date.now(),
              source: "live",
            };

            if (candle.isClosed) {
              await storeCandles([candle]);
            }
          }

          const state = this.streams.get(key);
          if (state) state.lastDataAt = Date.now();
        } catch (err) {
          if (this.abortController.signal.aborted || streamSignal?.aborted) break;
          console.error(`[Stream] OHLCV error ${key}: ${(err as Error).message}`);
          await sleep(5000);
        }
      }
    };

    run().catch((err) => {
      if (!this.abortController.signal.aborted) {
        console.error(`[Stream] OHLCV loop fatal ${key}: ${(err as Error).message}`);
      }
    });
  }

  /**
   * Polls Coinbase REST every 30s for the most-recently-closed 1m bar per pair.
   * Coinbase's CCXT Pro adapter does not support watchOHLCV, so this loop fills
   * the gap needed for close-quorum (≥2/3 exchanges).
   *
   * Bar selection: ccxt returns OHLCV chronologically (oldest → newest), and
   * Coinbase's fetchOHLCV may include the still-open current bar at the end
   * of the array. We walk from the newest bar backwards to find the most
   * recent fully-closed bar (one whose `openTime + 60_000 <= now`).
   *
   * Idempotency: a per-pair in-memory `closeTime` map prevents duplicate
   * writes within a single Fargate task lifetime. After a task restart the
   * map is empty, so the first poll will re-write the latest closed bar
   * once per pair — DDB Put is a PK+SK overwrite so this is harmless beyond
   * one log line + one write capacity unit per pair.
   */
  private startCoinbaseBackfillLoop(exchange: any, pair: TradingPair): void {
    const exchangeId: ExchangeId = "coinbase";
    const symbol = getSymbol(exchangeId, pair);
    const timeframe: Timeframe = "1m";
    const key = `${exchangeId}:${pair}`;

    // Capture signal at invocation time — same reasoning as startTickerStream.
    // The watchdog can swap out state.abortController for a fresh one on
    // restart; this local stays bound to the controller that was active
    // when THIS loop started, so it exits cleanly when its controller fires.
    const streamSignal = this.streams.get(key)?.abortController.signal;

    const run = async () => {
      while (!this.abortController.signal.aborted && !streamSignal?.aborted) {
        try {
          const ohlcv: OhlcvRow[] = await exchange.fetchOHLCV(symbol, timeframe, undefined, 2);

          // Walk newest → oldest and pick the first fully-closed bar.
          // A bar is closed if its open-timestamp + 60_000 <= now.
          const closedBar = pickClosedBar(ohlcv, Date.now());
          if (!closedBar) {
            await abortableSleep(COINBASE_BACKFILL_INTERVAL_MS, this.abortController.signal);
            continue;
          }

          const [ts, open, high, low, close, volume] = closedBar;
          const closeTime = ts + 60_000;

          // Idempotent skip: if we already wrote this bar, do nothing.
          const lastCloseTime = this.coinbaseLastCloseTime.get(pair);
          if (lastCloseTime === closeTime) {
            await abortableSleep(COINBASE_BACKFILL_INTERVAL_MS, this.abortController.signal);
            continue;
          }

          const candle: Candle = {
            exchange: exchangeId,
            symbol,
            pair,
            timeframe,
            openTime: ts,
            closeTime,
            open: Number(open ?? 0),
            high: Number(high ?? 0),
            low: Number(low ?? 0),
            close: Number(close ?? 0),
            volume: Number(volume ?? 0),
            isClosed: true,
            source: "live",
          };

          await storeCandles([candle]);
          this.coinbaseLastCloseTime.set(pair, closeTime);

          console.log(`[CoinbaseBackfill] wrote ${pair}@${new Date(closeTime).toISOString()}`);

          // Update stream freshness so the watchdog sees coinbase as alive.
          const state = this.streams.get(key);
          if (state) state.lastDataAt = Date.now();
        } catch (err) {
          if (this.abortController.signal.aborted || streamSignal?.aborted) break;
          console.error(`[CoinbaseBackfill] error for ${pair}: ${(err as Error).message}`);
          // Do not rethrow — one pair's failure must not kill other pairs.
        }

        await abortableSleep(COINBASE_BACKFILL_INTERVAL_MS, this.abortController.signal);
      }
    };

    run().catch((err) => {
      if (!this.abortController.signal.aborted) {
        console.error(`[CoinbaseBackfill] loop fatal for ${pair}: ${(err as Error).message}`);
      }
    });
  }

  private watchdog(): void {
    const now = Date.now();

    // Build a per-pair staleness map: exchange -> boolean.
    // A stream is stale if it has never received data, or hasn't received data
    // within STALE_THRESHOLD_MS.
    const pairStaleness: Map<TradingPair, Record<ExchangeId, boolean>> = new Map();
    for (const pair of PAIRS) {
      pairStaleness.set(pair, {} as Record<ExchangeId, boolean>);
    }

    for (const [key, state] of this.streams) {
      const ageMs = state.lastDataAt ? now - state.lastDataAt : Infinity;
      const isStale = !state.lastDataAt || ageMs > STALE_THRESHOLD_MS;

      if (isStale) {
        const ageDesc = state.lastDataAt ? `${Math.round(ageMs / 1000)}s ago` : "never";
        console.warn(`[Watchdog] Stream ${key} stale (last data ${ageDesc})`);
      }

      // Restart streams that have been stale long enough to warrant action.
      if (!state.lastDataAt || ageMs > RECONNECT_THRESHOLD_MS) {
        if (!this.abortController.signal.aborted) {
          const ageDesc = state.lastDataAt ? `${Math.round(ageMs / 1000)}s` : "never";
          console.warn(`[Watchdog] Restarting stream ${key} (no data for ${ageDesc})`);

          // Abort just this stream's loop; other streams are unaffected.
          state.abortController.abort();

          // Reset state for the new loop.
          state.lastDataAt = 0;
          state.abortController = new AbortController();

          const exchange = this.exchanges.get(state.exchange);
          if (exchange) {
            // Always restart the ticker stream (all exchanges support watchTicker).
            this.startTickerStream(state.exchange, exchange, state.pair);

            const supportsOHLCV = !!exchange.has?.watchOHLCV;
            if (supportsOHLCV) {
              this.startOHLCVStream(state.exchange, exchange, state.pair);
            } else if (state.exchange === "coinbase") {
              // Coinbase uses REST polling instead of watchOHLCV.
              this.startCoinbaseBackfillLoop(exchange, state.pair);
            }
          }
        }
      }

      const map = pairStaleness.get(state.pair);
      if (map) map[state.exchange] = isStale;
    }

    // Persist staleness to ingestion-metadata so the indicator handler's gateStale
    // check has a live producer (P2 #1 fix).
    for (const [pair, stalenessMap] of pairStaleness) {
      try {
        this.ddbClient
          .send(
            new PutCommand({
              TableName: METADATA_TABLE,
              Item: {
                metaKey: `exchange-staleness#${pair}`,
                staleness: stalenessMap,
                updatedAt: new Date().toISOString(),
              },
            }),
          )
          .catch((err: Error) => {
            console.error(`[Watchdog] Failed to persist staleness for ${pair}: ${err.message}`);
          });
      } catch (err) {
        console.error(
          `[Watchdog] Failed to persist staleness for ${pair}: ${(err as Error).message}`,
        );
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abort-aware sleep — wakes immediately if the signal aborts so loops can
 * exit promptly when `stop()` runs (otherwise shutdown waits up to 30s for
 * each pending Coinbase backfill timer to fire).
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Pick the most-recently-closed 1m bar from a chronological (oldest→newest)
 * OHLCV array. Walks from the newest bar backwards and returns the first one
 * whose `openTime + 60_000 <= now`. Returns null if no closed bar is present
 * (empty array, all timestamps null, or every bar is still open).
 *
 * Defensive against ccxt variations: some adapters include the still-open
 * current bar at the end of the array; others return only closed bars.
 */
export function pickClosedBar(ohlcv: OhlcvRow[], now: number): OhlcvRow | null {
  for (let i = ohlcv.length - 1; i >= 0; i--) {
    const ts = ohlcv[i]?.[0];
    if (ts == null) continue;
    if (ts + 60_000 <= now) return ohlcv[i];
  }
  return null;
}
