import ccxt from "ccxt";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Candle, Timeframe } from "@quantara/shared";

import { storeCandlesConditional } from "../lib/candle-store.js";
import { archiveCandles } from "../lib/s3-archive.js";
import { getCursor, saveCursor } from "../lib/metadata-store.js";

import { getSymbol, type ExchangeId, type TradingPair } from "./config.js";

const BATCH_SIZE = 500;

interface BackfillOptions {
  exchangeId: ExchangeId;
  pair: TradingPair;
  timeframe: Timeframe;
  days: number;
  force?: boolean;
  archiveToS3?: boolean;
  /**
   * When set, writes candles to this DynamoDB table name instead of the
   * default production candles table. Writes use plain BatchWrite (no
   * conditional expression, no TTL) — the archive table has no TTL.
   */
  targetTable?: string;
}

function buildSortKey(exchange: string, timeframe: string, timestamp: string): string {
  return `${exchange}#${timeframe}#${timestamp}`;
}

async function storeCandlesToTable(candles: Candle[], tableName: string): Promise<void> {
  const archiveClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const batches: Candle[][] = [];
  for (let i = 0; i < candles.length; i += 25) {
    batches.push(candles.slice(i, i + 25));
  }
  for (const batch of batches) {
    await archiveClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: batch.map((c) => ({
            PutRequest: {
              Item: {
                pair: c.pair,
                sk: buildSortKey(c.exchange, c.timeframe, new Date(c.openTime).toISOString()),
                exchange: c.exchange,
                symbol: c.symbol,
                timeframe: c.timeframe,
                openTime: c.openTime,
                closeTime: c.closeTime,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
                isClosed: c.isClosed,
                source: c.source,
                ...(c.aggregatedFrom !== undefined && { aggregatedFrom: c.aggregatedFrom }),
                // No TTL — archive table retains data indefinitely.
              },
            },
          })),
        },
      }),
    );
  }
  console.log(`[Backfill] Wrote ${candles.length} candles to archive table ${tableName}`);
}

export async function backfillCandles(options: BackfillOptions): Promise<number> {
  const {
    exchangeId,
    pair,
    timeframe,
    days,
    force = false,
    archiveToS3 = true,
    targetTable,
  } = options;

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

  if (force && cursor) {
    console.log(`[Backfill] force=true: ignoring saved cursor`);
  }

  const since =
    !force && cursor ? new Date(cursor.lastTimestamp).getTime() : now - days * 86400 * 1000;

  let fetchSince = since;
  let totalFetched = 0;

  console.log(
    `[Backfill] Starting ${exchangeId} ${pair} ${timeframe} from ${new Date(fetchSince).toISOString()}`,
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
        open: Number(open ?? 0),
        high: Number(high ?? 0),
        low: Number(low ?? 0),
        close: Number(close ?? 0),
        volume: Number(volume ?? 0),
        isClosed: ts! + timeframeToMs(timeframe) < now,
        source: "backfill" as const,
      }));

    if (targetTable) {
      await storeCandlesToTable(candles, targetTable);
    } else {
      await storeCandlesConditional(candles);
    }
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
      `[Backfill] ${totalFetched} candles so far, up to ${new Date(fetchSince).toISOString()}`,
    );
  }

  await saveCursor({
    metaKey,
    lastTimestamp: new Date(fetchSince).toISOString(),
    status: "complete",
    updatedAt: new Date().toISOString(),
    metadata: { totalFetched, pair, timeframe },
  });

  console.log(
    `[Backfill] Complete: ${totalFetched} candles for ${exchangeId} ${pair} ${timeframe}`,
  );
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
