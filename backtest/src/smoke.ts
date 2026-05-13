/**
 * Smoke runner — Phase 1.
 *
 * Runs a backtest against the dev candles table for BTC/USDT 1h, last 30 days,
 * and writes the JSON output to ./backtest-results/smoke.json.
 *
 * Usage:
 *   AWS_PROFILE=quantara-dev AWS_REGION=us-west-2 npm run smoke --workspace=backtest
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BacktestEngine } from "./engine.js";
import { DdbCandleStore } from "./store/ddb-candle-store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

async function main(): Promise<void> {
  const store = new DdbCandleStore({ tableName: "quantara-dev-candles" });
  const engine = new BacktestEngine(store);

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);

  console.log(
    `[smoke] Running BTC/USDT 1h backtest from ${from.toISOString()} to ${to.toISOString()}`,
  );

  const result = await engine.run({
    pair: "BTC/USDT",
    exchange: "binance",
    timeframe: "1h",
    from,
    to,
  });

  const outDir = resolve(__dirname, "../../backtest-results");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, "smoke.json");

  await fs.writeFile(outPath, JSON.stringify(result, null, 2));

  const { metrics } = result;
  console.log(`[smoke] Done: ${result.signals.length} signals emitted`);
  console.log(`[smoke] Candles fetched: ${result.meta.candleCount}`);
  console.log(
    `[smoke] By outcome: correct=${metrics.byOutcome.correct} incorrect=${metrics.byOutcome.incorrect} neutral=${metrics.byOutcome.neutral} unresolved=${metrics.byOutcome.unresolved}`,
  );
  console.log(
    `[smoke] Brier score: ${metrics.brierScore !== null ? metrics.brierScore.toFixed(4) : "n/a"}, win rate: ${metrics.winRate !== null ? (metrics.winRate * 100).toFixed(1) + "%" : "n/a"}`,
  );
  console.log(`[smoke] Output: ${outPath}`);
}

main().catch((err: unknown) => {
  console.error("[smoke] Fatal error:", err);
  process.exit(1);
});
