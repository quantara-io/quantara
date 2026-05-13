/**
 * Backtest CLI — Phase 2.
 *
 * Usage:
 *   bun run backtest [flags]
 *   bun run backtest:estimate [flags]
 *
 * Exit codes:
 *   0 — success (or dry-run estimate)
 *   1 — runtime error
 *   2 — cost gate rejected (period too long, estimate too high)
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { BacktestEngine } from "./engine.js";
import { DdbCandleStore } from "./store/ddb-candle-store.js";
import { loadStrategy } from "./strategy/types.js";
import { estimateRatificationCost, DdbRatificationsStore } from "./cost/estimator.js";
import { generateMarkdownReport } from "./report/markdown.js";
import type { BacktestResult } from "./engine.js";
import type { RatificationModel } from "./cost/estimator.js";

// ---------------------------------------------------------------------------
// CLI flag parser
// ---------------------------------------------------------------------------

interface CliFlags {
  pair: string;
  tf: string;
  from: string;
  to: string;
  strategy: string | undefined;
  baseline: string | undefined;
  ratification: "skip" | "cache-only" | "replay-bedrock";
  model: RatificationModel;
  maxPeriodDays: number;
  forceRatification: boolean;
  confirmCost: number | undefined;
  maxCost: number | undefined;
  output: string;
  estimateOnly: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`
Usage: bun run backtest [options]
       bun run backtest:estimate [options]

Options:
  --pair <symbol>           Trading pair, e.g. BTC/USDT (required)
  --tf <timeframe>          Emitting timeframe (default: 15m)
  --from <ISO date>         Start date, e.g. 2025-11-13 (required)
  --to <ISO date>           End date, e.g. 2026-05-12 (required)
  --strategy <path>         Path to strategy module (enables multi-TF blend)
  --baseline <path>         Path to baseline strategy (default: built-in production-default)
  --ratification <mode>     Ratification mode: skip | cache-only | replay-bedrock (default: skip)
  --model <model>           LLM model: haiku | sonnet (default: haiku)
  --max-period-days <N>     Auto-disable replay-bedrock beyond N days (default: 180)
  --force-ratification      Bypass period gate for replay-bedrock (still requires cost confirm)
  --confirm-cost <$N>       Non-interactive: auto-confirm if estimate <= $N
  --max-cost <$N>           Hard ceiling — abort mid-run if exceeded (default: 2× estimate)
  --output <dir>            Output directory for results (default: ./backtest-results/<run-id>/)
  --help                    Show this help
`);
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    pair: "",
    tf: "15m",
    from: "",
    to: "",
    strategy: undefined,
    baseline: undefined,
    ratification: "skip",
    model: "haiku",
    maxPeriodDays: 180,
    forceRatification: false,
    confirmCost: undefined,
    maxCost: undefined,
    output: "",
    estimateOnly: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    switch (arg) {
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--pair":
        flags.pair = next ?? "";
        i++;
        break;
      case "--tf":
        flags.tf = next ?? "15m";
        i++;
        break;
      case "--from":
        flags.from = next ?? "";
        i++;
        break;
      case "--to":
        flags.to = next ?? "";
        i++;
        break;
      case "--strategy":
        flags.strategy = next;
        i++;
        break;
      case "--baseline":
        flags.baseline = next;
        i++;
        break;
      case "--ratification":
        if (next === "skip" || next === "cache-only" || next === "replay-bedrock") {
          flags.ratification = next;
        }
        i++;
        break;
      case "--model":
        if (next === "haiku" || next === "sonnet") {
          flags.model = next;
        }
        i++;
        break;
      case "--max-period-days":
        flags.maxPeriodDays = parseInt(next ?? "180", 10);
        i++;
        break;
      case "--force-ratification":
        flags.forceRatification = true;
        break;
      case "--confirm-cost": {
        const val = next?.replace("$", "");
        flags.confirmCost = val !== undefined ? parseFloat(val) : undefined;
        i++;
        break;
      }
      case "--max-cost": {
        const val = next?.replace("$", "");
        flags.maxCost = val !== undefined ? parseFloat(val) : undefined;
        i++;
        break;
      }
      case "--output":
        flags.output = next ?? "";
        i++;
        break;
      case "--estimate":
        flags.estimateOnly = true;
        break;
    }
  }

  return flags;
}

function validateFlags(flags: CliFlags): string[] {
  const errors: string[] = [];
  if (!flags.pair) errors.push("--pair is required");
  if (!flags.from) errors.push("--from is required");
  if (!flags.to) errors.push("--to is required");
  if (flags.from && isNaN(Date.parse(flags.from))) errors.push("--from must be a valid date");
  if (flags.to && isNaN(Date.parse(flags.to))) errors.push("--to must be a valid date");
  return errors;
}

// ---------------------------------------------------------------------------
// Interactive confirmation prompt
// ---------------------------------------------------------------------------

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

// ---------------------------------------------------------------------------
// Pre-run plan table
// ---------------------------------------------------------------------------

function renderPlanTable(flags: CliFlags, periodDays: number): void {
  const fromStr = flags.from.substring(0, 10);
  const toStr = flags.to.substring(0, 10);

  console.log("");
  console.log("Backtest plan");
  console.log("─".repeat(65));
  console.log(`  Period:        ${fromStr} → ${toStr} (${periodDays} days)`);
  console.log(`  Pairs:         ${flags.pair}`);
  console.log(`  Timeframes:    15m, 1h, 4h, 1d (blended)`);
  if (flags.strategy) console.log(`  Strategy:      ${flags.strategy}`);
  if (flags.baseline) console.log(`  Baseline:      ${flags.baseline}`);
}

function renderCostTable(
  flags: CliFlags,
  estimate: Awaited<ReturnType<typeof estimateRatificationCost>>,
): void {
  const modelLabel =
    flags.model === "haiku"
      ? "Claude Haiku 4.5 ($0.25 / $1.25 per 1M tok)"
      : "Claude Sonnet 4.6 ($3 / $15 per 1M tok)";

  console.log("");
  console.log("  Bedrock ratification enabled");
  console.log("─".repeat(65));
  console.log(`  Model:         ${modelLabel}`);
  console.log(`  Closes:        ${estimate.closes.toLocaleString()}`);
  console.log(
    `  Gate rate:     ${(estimate.gatedRate * 100).toFixed(2)}% (from last 30d of production)`,
  );
  console.log(`  Est. calls:    ${estimate.estimatedCalls} ratifications`);
  console.log(
    `  Est. tokens:   ${(estimate.estimatedTokens.input / 1000).toFixed(1)}k input / ` +
      `${(estimate.estimatedTokens.output / 1000).toFixed(1)}k output`,
  );
  console.log(
    `  Est. cost:     $${estimate.estimatedCostUsd.toFixed(4)} USD ± 30%` +
      (flags.strategy && flags.baseline
        ? `   (×2 strategies = $${(estimate.estimatedCostUsd * 2).toFixed(4)})`
        : ""),
  );
  const secs = Math.round(estimate.estimatedLatencyMs / 1000);
  console.log(`  Est. duration: ~${secs} seconds`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  // Detect estimate-only mode via argv[0] being "estimate" (bun run backtest:estimate).
  if (argv[0] === "estimate" || flags.estimateOnly) {
    flags.estimateOnly = true;
  }

  const errors = validateFlags(flags);
  if (errors.length > 0) {
    for (const e of errors) console.error(`Error: ${e}`);
    printHelp();
    process.exit(1);
  }

  const from = new Date(flags.from);
  const to = new Date(flags.to);
  const periodMs = to.getTime() - from.getTime();
  const periodDays = Math.floor(periodMs / 86_400_000);

  // ---------------------------------------------------------------------------
  // Period gate for replay-bedrock
  // ---------------------------------------------------------------------------
  if (
    flags.ratification === "replay-bedrock" &&
    periodDays > flags.maxPeriodDays &&
    !flags.forceRatification
  ) {
    console.error(
      `Error: Period is ${periodDays} days which exceeds --max-period-days=${flags.maxPeriodDays}.\n` +
        `Use --force-ratification to override, or choose a shorter window.\n` +
        `Auto-disable protects against runaway Bedrock costs on long backtests.`,
    );
    process.exit(2);
  }

  // ---------------------------------------------------------------------------
  // Load strategies
  // ---------------------------------------------------------------------------
  const candleStore = new DdbCandleStore();
  const ratStore = new DdbRatificationsStore();

  let testStrategy = undefined;
  let baselineStrategy = undefined;

  if (flags.strategy) {
    const stratPath = resolve(flags.strategy);
    testStrategy = await loadStrategy(stratPath);
    console.log(`Loaded strategy: ${testStrategy.name}`);
  }

  if (flags.baseline) {
    const basePath = resolve(flags.baseline);
    baselineStrategy = await loadStrategy(basePath);
    console.log(`Loaded baseline: ${baselineStrategy.name}`);
  }

  // ---------------------------------------------------------------------------
  // Cost estimation + pre-run plan
  // ---------------------------------------------------------------------------
  const testInput = {
    pair: flags.pair,
    timeframe: flags.tf as import("@quantara/shared").Timeframe,
    from,
    to,
    strategy: testStrategy,
  };

  renderPlanTable(flags, periodDays);

  let maxCostCeiling: number | undefined;

  if (flags.ratification === "replay-bedrock") {
    const estimate = await estimateRatificationCost(testInput, flags.model, candleStore, ratStore);
    renderCostTable(flags, estimate);

    // Determine max cost ceiling (default: 2× estimate).
    const defaultMaxCost = estimate.estimatedCostUsd * 2;
    maxCostCeiling = flags.maxCost ?? defaultMaxCost;

    // Estimate-only mode: just print the table and exit.
    if (flags.estimateOnly) {
      console.log("Estimate-only mode — exiting without running the backtest.");
      process.exit(0);
    }

    // Non-interactive confirmation: --confirm-cost covers the estimate.
    if (flags.confirmCost !== undefined) {
      if (estimate.estimatedCostUsd > flags.confirmCost) {
        console.error(
          `Error: Estimated cost $${estimate.estimatedCostUsd.toFixed(4)} exceeds ` +
            `--confirm-cost=$${flags.confirmCost.toFixed(2)}. Exiting.`,
        );
        process.exit(2);
      }
      console.log(
        `Auto-confirmed: estimate $${estimate.estimatedCostUsd.toFixed(4)} <= ` +
          `--confirm-cost=$${flags.confirmCost.toFixed(2)}`,
      );
    } else {
      // Interactive prompt.
      const confirmed = await askYesNo("Continue?");
      if (!confirmed) {
        console.log("Aborted by user.");
        process.exit(0);
      }
    }
  } else if (flags.estimateOnly) {
    // Estimate only for non-bedrock mode (zero cost).
    console.log("");
    console.log(`  Ratification mode: ${flags.ratification} (no Bedrock calls)`);
    console.log(`  Estimated cost:    $0.00 USD`);
    console.log("");
    console.log("Estimate-only mode — exiting without running the backtest.");
    process.exit(0);
  } else {
    console.log("");
    console.log(`  Ratification mode: ${flags.ratification} (no Bedrock calls)`);
    console.log("");
  }

  // ---------------------------------------------------------------------------
  // Run the backtest(s)
  // ---------------------------------------------------------------------------
  const engine = new BacktestEngine(candleStore);

  // Determine output directory.
  const runId = `${flags.pair.replace("/", "-")}-${from.toISOString().substring(0, 10)}-${Date.now()}`;
  const outputDir = flags.output ? resolve(flags.output) : resolve(`./backtest-results/${runId}`);
  await fs.mkdir(outputDir, { recursive: true });

  console.log(`Running test backtest for ${flags.pair}...`);
  let testResult: BacktestResult = await engine.run(testInput);

  // Hard runtime cost ceiling (Phase 2 — wire-up when replay-bedrock lands).
  if (maxCostCeiling !== undefined) {
    const runningCost = 0; // Placeholder: actual cost tracking lands with replay-bedrock
    if (runningCost > maxCostCeiling) {
      testResult = {
        ...testResult,
        meta: {
          ...testResult.meta,
          aborted: true,
          abortReason: "cost-ceiling",
        },
      };
      console.warn(
        `[backtest] Run aborted: actual cost exceeded max-cost ceiling $${maxCostCeiling.toFixed(4)}`,
      );
    }
  }

  // Write test result JSON.
  const testMetricsPath = resolve(outputDir, "test-metrics.json");
  await fs.writeFile(testMetricsPath, JSON.stringify(testResult, null, 2));
  console.log(`Test metrics: ${testMetricsPath}`);

  // Run baseline if provided.
  let baselineResult: BacktestResult | undefined;
  if (flags.baseline && baselineStrategy !== undefined) {
    console.log(`Running baseline backtest for ${flags.pair}...`);
    const baselineInput = {
      pair: flags.pair,
      timeframe: flags.tf as import("@quantara/shared").Timeframe,
      from,
      to,
      strategy: baselineStrategy,
    };
    baselineResult = await engine.run(baselineInput);

    const baseMetricsPath = resolve(outputDir, "baseline-metrics.json");
    await fs.writeFile(baseMetricsPath, JSON.stringify(baselineResult, null, 2));
    console.log(`Baseline metrics: ${baseMetricsPath}`);
  } else if (!flags.baseline) {
    // No baseline specified — run with no strategy (single-TF Phase 1 mode) as baseline.
    const baselineInput = {
      pair: flags.pair,
      timeframe: flags.tf as import("@quantara/shared").Timeframe,
      from,
      to,
    };
    baselineResult = await engine.run(baselineInput);
  }

  // Generate markdown report.
  if (baselineResult !== undefined) {
    const report = generateMarkdownReport({
      test: testResult,
      baseline: baselineResult,
      period: `${flags.from.substring(0, 10)} → ${flags.to.substring(0, 10)} (${periodDays} days)`,
      tradesCsvPath: resolve(outputDir, "trades.csv"),
      metricsJsonPath: testMetricsPath,
    });

    const summaryPath = resolve(outputDir, "summary.md");
    await fs.writeFile(summaryPath, report);
    console.log(`Report: ${summaryPath}`);
  }

  // Summary to console.
  const { metrics } = testResult;
  console.log(`\nTest run complete: ${metrics.totalSignals} signals emitted`);
  console.log(
    `  Win rate: ${metrics.winRate !== null ? (metrics.winRate * 100).toFixed(1) + "%" : "n/a"}` +
      `  Brier: ${metrics.brierScore !== null ? metrics.brierScore.toFixed(4) : "n/a"}`,
  );
  console.log(`Output: ${outputDir}`);
}

// ---------------------------------------------------------------------------
// Estimate-only entrypoint (bun run backtest:estimate)
// ---------------------------------------------------------------------------

export async function runEstimate(): Promise<void> {
  // Inject --estimate flag and delegate to main.
  process.argv.push("--estimate");
  await main();
}

// Direct invocation.
main().catch((err: unknown) => {
  console.error("[backtest/cli] Fatal error:", err);
  process.exit(1);
});

// Export for programmatic use.
export { main };
