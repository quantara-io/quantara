/**
 * Fill the 8 kraken combos that returned 0 in the initial run.
 * Root cause: SYMBOL_OVERRIDES in backfill-archive.ts incorrectly mapped
 * BTC/USDT → XBT/USDT and DOGE/USDT → XDG/USDT. Kraken via ccxt accepts
 * BTC/USDT and DOGE/USDT directly — no override needed.
 *
 * Skips coinbase × 4h (acknowledged API limitation, coinbase doesn't support 4h).
 *
 *   AWS_PROFILE=quantara-dev npx tsx scripts/backfill-gaps.ts
 */

import ccxt from "ccxt";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = "quantara-dev-candles-archive";
const REGION = "us-west-2";
const DAYS = 365;
const FETCH_BATCH = 500;
const WRITE_BATCH = 25;

const TF_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const GAPS: Array<{ exchange: string; pair: string; tf: string }> = [
  { exchange: "kraken", pair: "BTC/USDT", tf: "15m" },
  { exchange: "kraken", pair: "BTC/USDT", tf: "1h" },
  { exchange: "kraken", pair: "BTC/USDT", tf: "4h" },
  { exchange: "kraken", pair: "BTC/USDT", tf: "1d" },
  { exchange: "kraken", pair: "DOGE/USDT", tf: "15m" },
  { exchange: "kraken", pair: "DOGE/USDT", tf: "1h" },
  { exchange: "kraken", pair: "DOGE/USDT", tf: "4h" },
  { exchange: "kraken", pair: "DOGE/USDT", tf: "1d" },
];

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function batchWrite(items: Record<string, unknown>[]) {
  for (let i = 0; i < items.length; i += WRITE_BATCH) {
    const batch = items.slice(i, i + WRITE_BATCH);
    let unprocessed = { [TABLE]: batch.map((Item) => ({ PutRequest: { Item } })) };
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: unprocessed }));
      const left = res.UnprocessedItems?.[TABLE];
      if (!left || left.length === 0) break;
      unprocessed = { [TABLE]: left as typeof unprocessed[typeof TABLE] };
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
}

async function backfillOne(exchangeId: string, pair: string, timeframe: string) {
  const tag = `${exchangeId}/${pair}/${timeframe}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExchangeClass = (ccxt as any)[exchangeId];
  const ex = new ExchangeClass({ enableRateLimit: true, timeout: 30_000 });

  const now = Date.now();
  let since = now - DAYS * 86400_000;
  let total = 0;
  let lastWritten = 0;

  while (since < now) {
    let ohlcv: number[][];
    try {
      ohlcv = await ex.fetchOHLCV(pair, timeframe, since, FETCH_BATCH);
    } catch (err) {
      console.error(`[${tag}] fetchOHLCV error:`, (err as Error).message);
      break;
    }
    if (!ohlcv || ohlcv.length === 0) {
      console.log(`[${tag}] no more data at ${new Date(since).toISOString()}, total=${total}`);
      break;
    }

    const items = ohlcv
      .filter((row) => row[0] != null)
      .map(([ts, o, h, l, c, v]) => ({
        pair,
        sk: `${exchangeId}#${timeframe}#${ts}`,
        exchange: exchangeId,
        symbol: pair,
        timeframe,
        openTime: ts,
        closeTime: ts + TF_MS[timeframe],
        open: Number(o ?? 0),
        high: Number(h ?? 0),
        low: Number(l ?? 0),
        close: Number(c ?? 0),
        volume: Number(v ?? 0),
        isClosed: ts + TF_MS[timeframe] < now,
        source: "backfill",
      }));

    await batchWrite(items);
    total += items.length;

    const lastTs = ohlcv[ohlcv.length - 1][0];
    // Kraken's 720-candle cap: if we got the same last timestamp twice in a row, break (no progress).
    if (lastTs === lastWritten) {
      console.log(`[${tag}] no advance (kraken 720 cap?), stopping at ${total}`);
      break;
    }
    lastWritten = lastTs;
    since = lastTs + TF_MS[timeframe];
    process.stdout.write(`[${tag}] ${total} candles, up to ${new Date(since).toISOString()}\r`);
  }
  console.log(`\n[${tag}] DONE: ${total} candles`);
  return total;
}

async function main() {
  console.log(`Filling ${GAPS.length} gap combos with corrected kraken symbols\n`);
  let grandTotal = 0;
  for (const { exchange, pair, tf } of GAPS) {
    grandTotal += await backfillOne(exchange, pair, tf);
  }
  console.log(`\nGRAND TOTAL: ${grandTotal} candles filled into ${TABLE}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
