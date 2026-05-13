/**
 * One-shot orchestrator: backfill 1 year of historical OHLCV candles into
 * the candles-archive DynamoDB table for all 60 combinations of:
 *   5 pairs × 3 exchanges × 4 signal timeframes (15m / 1h / 4h / 1d)
 *
 * Usage:
 *   ENV=dev npx tsx backtest/scripts/backfill-historical.ts
 *   ENV=dev npx tsx backtest/scripts/backfill-historical.ts --dry-run
 *
 * Prerequisites:
 *   - AWS credentials for the target environment (quantara-dev SSO role)
 *   - The quantara-{env}-backfill Lambda must already be deployed
 *   - The quantara-{env}-candles-archive DynamoDB table must already exist
 *
 * Concurrency: max 4 invocations run in parallel, but at most 2 per exchange
 * to respect per-exchange ccxt rate limits.
 *
 * Idempotent: re-running overwrites identical (pair, exchange, tf, closeTime)
 * rows with no duplicates (DDB PutItem on the same PK+SK is a replace).
 */

import { LambdaClient, InvokeCommand, InvokeCommandOutput, LogType } from "@aws-sdk/client-lambda";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENV = process.env.ENV ?? "dev";
const REGION = process.env.AWS_REGION ?? "us-west-2";
const DRY_RUN = process.argv.includes("--dry-run");
const DAYS = 365;
const CONCURRENCY = 4; // global cap
const PER_EXCHANGE_CONCURRENCY = 2; // max in-flight per exchange

const LAMBDA_NAME = `quantara-${ENV}-backfill`;
const TARGET_TABLE = `quantara-${ENV}-candles-archive`;

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"] as const;
const EXCHANGES = ["binanceus", "coinbase", "kraken"] as const;
const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;

type Exchange = (typeof EXCHANGES)[number];
type Timeframe = (typeof TIMEFRAMES)[number];
type Pair = (typeof PAIRS)[number];

interface Combo {
  exchange: Exchange;
  pair: Pair;
  timeframe: Timeframe;
}

interface InvokeResult {
  combo: Combo;
  total: number;
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Build the 60-combo cross-product
// ---------------------------------------------------------------------------

function buildCombos(): Combo[] {
  const combos: Combo[] = [];
  for (const exchange of EXCHANGES) {
    for (const pair of PAIRS) {
      for (const timeframe of TIMEFRAMES) {
        combos.push({ exchange, pair, timeframe });
      }
    }
  }
  return combos;
}

// ---------------------------------------------------------------------------
// Lambda invocation
// ---------------------------------------------------------------------------

const lambdaClient = new LambdaClient({ region: REGION });

async function invokeBackfill(combo: Combo): Promise<InvokeResult> {
  const start = Date.now();
  const label = `${combo.exchange}/${combo.pair}/${combo.timeframe}`;

  if (DRY_RUN) {
    console.log(`[dry-run] Would invoke ${LAMBDA_NAME} for ${label}`);
    return { combo, total: 0, durationMs: 0 };
  }

  const payload = JSON.stringify({
    exchange: combo.exchange,
    pair: combo.pair,
    timeframe: combo.timeframe,
    days: DAYS,
    force: true,
    targetTable: TARGET_TABLE,
  });

  let output: InvokeCommandOutput;
  try {
    output = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: LAMBDA_NAME,
        InvocationType: "RequestResponse",
        LogType: LogType.Tail,
        Payload: Buffer.from(payload),
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] ${label}: Lambda invoke failed — ${message}`);
    return { combo, total: 0, durationMs: Date.now() - start, error: message };
  }

  // Lambda-level error (function threw)
  if (output.FunctionError) {
    let errMsg = output.FunctionError;
    if (output.Payload) {
      try {
        const parsed = JSON.parse(Buffer.from(output.Payload).toString()) as {
          errorMessage?: string;
        };
        errMsg = parsed.errorMessage ?? errMsg;
      } catch {
        // ignore parse error
      }
    }
    console.error(`[ERROR] ${label}: Function error — ${errMsg}`);
    return { combo, total: 0, durationMs: Date.now() - start, error: errMsg };
  }

  // Parse { total } from successful response
  let total = 0;
  if (output.Payload) {
    try {
      const result = JSON.parse(Buffer.from(output.Payload).toString()) as { total?: number };
      total = result.total ?? 0;
    } catch {
      // ignore — total stays 0
    }
  }

  const durationMs = Date.now() - start;
  console.log(`[done ] ${label} — ${total} candles in ${(durationMs / 1000).toFixed(1)}s`);
  return { combo, total, durationMs };
}

// ---------------------------------------------------------------------------
// Concurrency scheduler with per-exchange cap
// ---------------------------------------------------------------------------

async function runWithConcurrency(combos: Combo[]): Promise<InvokeResult[]> {
  const results: InvokeResult[] = [];
  const queue = [...combos];
  const inFlightByExchange = new Map<Exchange, number>(EXCHANGES.map((e) => [e, 0]));
  const globalInFlight: Set<Promise<InvokeResult>> = new Set();

  async function tryScheduleNext(): Promise<void> {
    // Find the first combo that can be scheduled under both caps
    const idx = queue.findIndex(
      (c) =>
        globalInFlight.size < CONCURRENCY &&
        (inFlightByExchange.get(c.exchange) ?? 0) < PER_EXCHANGE_CONCURRENCY,
    );
    if (idx === -1) return;

    const combo = queue.splice(idx, 1)[0];
    inFlightByExchange.set(combo.exchange, (inFlightByExchange.get(combo.exchange) ?? 0) + 1);
    console.log(`[start] ${combo.exchange}/${combo.pair}/${combo.timeframe}`);

    const promise = invokeBackfill(combo).then((result) => {
      inFlightByExchange.set(combo.exchange, (inFlightByExchange.get(combo.exchange) ?? 1) - 1);
      globalInFlight.delete(promise);
      results.push(result);
      return result;
    });

    globalInFlight.add(promise);
  }

  // Drain the queue: schedule as many as caps allow, then wait for any
  // in-flight task to complete before trying again.
  while (queue.length > 0 || globalInFlight.size > 0) {
    // Fill up to concurrency caps
    let scheduled = true;
    while (scheduled && queue.length > 0) {
      const before = globalInFlight.size;
      await tryScheduleNext();
      scheduled = globalInFlight.size > before;
    }

    if (globalInFlight.size > 0) {
      // Wait for the next task to finish before re-evaluating
      await Promise.race(globalInFlight);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const combos = buildCombos();

  console.log(`========================================`);
  console.log(`Quantara historical backfill`);
  console.log(`  env:          ${ENV}`);
  console.log(`  lambda:       ${LAMBDA_NAME}`);
  console.log(`  target table: ${TARGET_TABLE}`);
  console.log(
    `  combinations: ${combos.length} (${PAIRS.length} pairs × ${EXCHANGES.length} exchanges × ${TIMEFRAMES.length} timeframes)`,
  );
  console.log(`  days:         ${DAYS}`);
  console.log(`  concurrency:  ${CONCURRENCY} global / ${PER_EXCHANGE_CONCURRENCY} per exchange`);
  console.log(`  dry-run:      ${DRY_RUN}`);
  console.log(`========================================`);

  if (!DRY_RUN) {
    console.log(`\nEach combo invokes the Lambda synchronously (RequestResponse).`);
    console.log(`Expected runtime: ~10-20 minutes for all 60 combos.\n`);
  }

  const wallStart = Date.now();
  const results = await runWithConcurrency(combos);
  const wallMs = Date.now() - wallStart;

  // Summary
  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const totalCandles = succeeded.reduce((sum, r) => sum + r.total, 0);

  console.log(`\n========================================`);
  console.log(`Backfill complete in ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`  succeeded: ${succeeded.length}/${combos.length}`);
  console.log(`  failed:    ${failed.length}/${combos.length}`);
  console.log(`  total candles written: ${totalCandles.toLocaleString()}`);
  console.log(`========================================`);

  if (failed.length > 0) {
    console.error(`\nFailed combinations:`);
    for (const r of failed) {
      console.error(`  ${r.combo.exchange}/${r.combo.pair}/${r.combo.timeframe}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
