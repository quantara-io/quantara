import ccxt from "ccxt";
import type { Candle, Timeframe } from "@quantara/shared";
import { EXCHANGES, PAIRS, getSymbol, type ExchangeId, type TradingPair } from "./config.js";
import { storeCandles } from "../lib/candle-store.js";
import { storePriceSnapshots } from "../lib/store.js";
import type { PriceSnapshot } from "./fetcher.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const WATCHDOG_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 5 * 60_000;

interface StreamState {
  exchange: ExchangeId;
  pair: TradingPair;
  lastDataAt: number;
  running: boolean;
}

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

export class MarketStreamManager {
  private streams: Map<string, StreamState> = new Map();
  private exchanges: Map<ExchangeId, any> = new Map();
  private abortController = new AbortController();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

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
        console.warn(`[Stream] ${exchangeId} does not support watchOHLCV; skipping OHLCV stream`);
      }

      for (const pair of PAIRS) {
        const key = `${exchangeId}:${pair}`;
        this.streams.set(key, {
          exchange: exchangeId,
          pair,
          lastDataAt: 0,
          running: false,
        });

        this.startTickerStream(exchangeId, exchange, pair);
        if (supportsOHLCV) {
          this.startOHLCVStream(exchangeId, exchange, pair);
        }
      }
    }

    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);
    console.log(`[Stream] Started ${this.streams.size} streams across ${this.exchanges.size} exchanges`);
  }

  async stop(): Promise<void> {
    console.log("[Stream] Stopping...");
    this.abortController.abort();

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

    const run = async () => {
      while (!this.abortController.signal.aborted) {
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
          if (this.abortController.signal.aborted) break;
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

    const run = async () => {
      while (!this.abortController.signal.aborted) {
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
            };

            if (candle.isClosed) {
              await storeCandles([candle]);
            }
          }

          const state = this.streams.get(key);
          if (state) state.lastDataAt = Date.now();
        } catch (err) {
          if (this.abortController.signal.aborted) break;
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
      const isStale = !state.lastDataAt || now - state.lastDataAt > STALE_THRESHOLD_MS;
      if (isStale) {
        console.warn(`[Watchdog] Stream ${key} stale (last data ${state.lastDataAt ? Math.round((now - state.lastDataAt) / 1000) + "s ago" : "never"})`);
      }
      const map = pairStaleness.get(state.pair);
      if (map) map[state.exchange] = isStale;
    }

    // Persist staleness to ingestion-metadata so the indicator handler's gateStale
    // check has a live producer (P2 #1 fix).
    for (const [pair, stalenessMap] of pairStaleness) {
      ddbClient.send(
        new PutCommand({
          TableName: METADATA_TABLE,
          Item: {
            metaKey: `exchange-staleness#${pair}`,
            staleness: stalenessMap,
            updatedAt: new Date().toISOString(),
          },
        }),
      ).catch((err: Error) => {
        console.error(`[Watchdog] Failed to persist staleness for ${pair}: ${err.message}`);
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
