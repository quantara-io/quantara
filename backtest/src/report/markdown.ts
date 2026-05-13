/**
 * Markdown report generator — Phase 2.
 *
 * Generates a `summary.md` comparing two BacktestResult runs
 * (test strategy vs baseline strategy) side-by-side.
 *
 * Design: Phase 2 issue #369 §7.
 */

import type { BacktestResult, BacktestSignal } from "../engine.js";

// ---------------------------------------------------------------------------
// Report input / output types
// ---------------------------------------------------------------------------

export interface ReportOptions {
  /** Result from the experimental strategy. */
  test: BacktestResult;
  /** Result from the baseline strategy (e.g. production-default). */
  baseline: BacktestResult;
  /** ISO period label, e.g. "2025-11-13 → 2026-05-12". */
  period?: string;
  /** Path to the trades CSV (relative or absolute, for the pointer). */
  tradesCsvPath?: string;
  /** Path to the metrics JSON (relative or absolute, for the pointer). */
  metricsJsonPath?: string;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function fmtPct(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtNum(value: number | null, decimals = 4): string {
  if (value === null) return "n/a";
  return value.toFixed(decimals);
}

function fmtDelta(test: number | null, base: number | null, isPositiveBetter = true): string {
  if (test === null || base === null) return "—";
  const delta = test - base;
  const sign = delta >= 0 ? "+" : "";
  const arrow =
    delta > 0 ? (isPositiveBetter ? "▲" : "▼") : delta < 0 ? (isPositiveBetter ? "▼" : "▲") : "–";
  return `${arrow} ${sign}${delta.toFixed(4)}`;
}

function fmtPctDelta(test: number | null, base: number | null, isPositiveBetter = true): string {
  if (test === null || base === null) return "—";
  const delta = (test - base) * 100;
  const sign = delta >= 0 ? "+" : "";
  const arrow =
    delta > 0 ? (isPositiveBetter ? "▲" : "▼") : delta < 0 ? (isPositiveBetter ? "▼" : "▲") : "–";
  return `${arrow} ${sign}${delta.toFixed(1)} pp`;
}

/**
 * Render an ASCII bar chart (0–width chars) for a numeric ratio [0, 1].
 */
function asciiBar(ratio: number, width = 20, fill = "█", empty = "░"): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return fill.repeat(filled) + empty.repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Signal type distribution
// ---------------------------------------------------------------------------

function outcomeBar(result: BacktestResult): string {
  const { byOutcome, totalSignals } = result.metrics;
  if (totalSignals === 0) return "(no signals)";

  const lines: string[] = [];
  const entries: Array<[string, number]> = [
    ["correct  ", byOutcome.correct],
    ["incorrect", byOutcome.incorrect],
    ["neutral  ", byOutcome.neutral],
    ["unresolved", byOutcome.unresolved],
  ];

  for (const [label, count] of entries) {
    const ratio = totalSignals > 0 ? count / totalSignals : 0;
    const bar = asciiBar(ratio, 20);
    lines.push(`  ${label} ${bar} ${count} (${(ratio * 100).toFixed(1)}%)`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Top-5 winning / losing rules
// ---------------------------------------------------------------------------

interface RuleStats {
  name: string;
  fires: number;
  correctFires: number;
  winRate: number | null;
}

function computeRuleStats(signals: BacktestSignal[]): Map<string, RuleStats> {
  const stats = new Map<string, RuleStats>();

  for (const sig of signals) {
    for (const rule of sig.rulesFired) {
      if (!stats.has(rule)) {
        stats.set(rule, { name: rule, fires: 0, correctFires: 0, winRate: null });
      }
      const s = stats.get(rule)!;
      s.fires += 1;
      if (sig.outcome === "correct") s.correctFires += 1;
    }
  }

  // Compute win rates.
  for (const s of stats.values()) {
    s.winRate = s.fires > 0 ? s.correctFires / s.fires : null;
  }

  return stats;
}

function topRules(signals: BacktestSignal[], n: number, direction: "winning" | "losing"): string {
  const stats = computeRuleStats(signals);
  const sorted = [...stats.values()]
    .filter((s) => s.winRate !== null && s.fires >= 2)
    .sort((a, b) => {
      const aWr = a.winRate ?? 0;
      const bWr = b.winRate ?? 0;
      return direction === "winning" ? bWr - aWr : aWr - bWr;
    })
    .slice(0, n);

  if (sorted.length === 0) return "  (insufficient data)\n";

  return sorted
    .map((s) => `  ${s.name.padEnd(32)} fires=${s.fires}  win=${fmtPct(s.winRate)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main report generator
// ---------------------------------------------------------------------------

/**
 * Generate a markdown summary comparing test vs baseline backtest runs.
 * Returns the full markdown string; caller is responsible for writing to disk.
 */
export function generateMarkdownReport(opts: ReportOptions): string {
  const { test, baseline } = opts;
  const testName = test.meta.strategyName ?? "test";
  const baseName = baseline.meta.strategyName ?? "baseline";

  const period =
    opts.period ?? `${test.meta.from.substring(0, 10)} → ${test.meta.to.substring(0, 10)}`;

  const lines: string[] = [];

  // Header
  lines.push(`# Backtest Report`);
  lines.push(``);
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Period | ${period} |`);
  lines.push(`| Pairs | ${test.meta.pair} |`);
  lines.push(`| Timeframe | ${test.meta.timeframe} |`);
  lines.push(`| Multi-TF blend | ${test.meta.multiTfBlend ? "yes" : "no"} |`);
  lines.push(`| Started at | ${test.meta.startedAt} |`);
  lines.push(``);

  // Strategy comparison header
  lines.push(`## Strategy Comparison`);
  lines.push(``);
  lines.push(`| Metric | ${testName} | ${baseName} | Δ |`);
  lines.push(`|--------|-----------|-----------|---|`);

  const tm = test.metrics;
  const bm = baseline.metrics;

  lines.push(
    `| Total signals | ${tm.totalSignals} | ${bm.totalSignals} | ${tm.totalSignals - bm.totalSignals >= 0 ? "+" : ""}${tm.totalSignals - bm.totalSignals} |`,
  );
  lines.push(
    `| Win rate | ${fmtPct(tm.winRate)} | ${fmtPct(bm.winRate)} | ${fmtPctDelta(tm.winRate, bm.winRate)} |`,
  );
  lines.push(
    `| Brier score | ${fmtNum(tm.brierScore)} | ${fmtNum(bm.brierScore)} | ${fmtDelta(tm.brierScore, bm.brierScore, false)} |`,
  );
  lines.push(
    `| Mean return % | ${fmtPct(tm.meanReturnPct)} | ${fmtPct(bm.meanReturnPct)} | ${fmtPctDelta(tm.meanReturnPct, bm.meanReturnPct)} |`,
  );
  lines.push(
    `| Correct | ${tm.byOutcome.correct} | ${bm.byOutcome.correct} | ${tm.byOutcome.correct - bm.byOutcome.correct >= 0 ? "+" : ""}${tm.byOutcome.correct - bm.byOutcome.correct} |`,
  );
  lines.push(
    `| Incorrect | ${tm.byOutcome.incorrect} | ${bm.byOutcome.incorrect} | ${tm.byOutcome.incorrect - bm.byOutcome.incorrect >= 0 ? "+" : ""}${tm.byOutcome.incorrect - bm.byOutcome.incorrect} |`,
  );
  lines.push(
    `| Neutral | ${tm.byOutcome.neutral} | ${bm.byOutcome.neutral} | ${tm.byOutcome.neutral - bm.byOutcome.neutral >= 0 ? "+" : ""}${tm.byOutcome.neutral - bm.byOutcome.neutral} |`,
  );
  lines.push(
    `| Unresolved | ${tm.byOutcome.unresolved} | ${bm.byOutcome.unresolved} | ${tm.byOutcome.unresolved - bm.byOutcome.unresolved >= 0 ? "+" : ""}${tm.byOutcome.unresolved - bm.byOutcome.unresolved} |`,
  );
  lines.push(
    `| Skipped (no consensus) | ${test.meta.skippedNoConsensus} | ${baseline.meta.skippedNoConsensus} | — |`,
  );
  lines.push(``);

  // Signal type distribution
  lines.push(`## Signal Type Distribution`);
  lines.push(``);

  const signalTypes = ["strong-buy", "buy", "hold", "sell", "strong-sell"] as const;
  lines.push(`| Type | ${testName} | ${baseName} |`);
  lines.push(`|------|-----------|-----------|`);
  for (const t of signalTypes) {
    const tc = tm.byType[t] ?? 0;
    const bc = bm.byType[t] ?? 0;
    lines.push(`| ${t} | ${tc} | ${bc} |`);
  }
  lines.push(``);

  // Outcome breakdown charts (test strategy)
  lines.push(`## Outcome Breakdown — ${testName}`);
  lines.push(``);
  lines.push("```");
  lines.push(outcomeBar(test));
  lines.push("```");
  lines.push(``);

  // Outcome breakdown charts (baseline)
  lines.push(`## Outcome Breakdown — ${baseName}`);
  lines.push(``);
  lines.push("```");
  lines.push(outcomeBar(baseline));
  lines.push("```");
  lines.push(``);

  // Top winning / losing rules (test strategy)
  lines.push(`## Top 5 Winning Rules — ${testName}`);
  lines.push(``);
  lines.push("```");
  lines.push(topRules(test.signals, 5, "winning"));
  lines.push("```");
  lines.push(``);

  lines.push(`## Top 5 Losing Rules — ${testName}`);
  lines.push(``);
  lines.push("```");
  lines.push(topRules(test.signals, 5, "losing"));
  lines.push("```");
  lines.push(``);

  // File pointers
  if (opts.tradesCsvPath ?? opts.metricsJsonPath) {
    lines.push(`## Output Files`);
    lines.push(``);
    if (opts.tradesCsvPath) lines.push(`- Trades CSV: \`${opts.tradesCsvPath}\``);
    if (opts.metricsJsonPath) lines.push(`- Metrics JSON: \`${opts.metricsJsonPath}\``);
    lines.push(``);
  }

  // Aborted notice
  if (test.meta.aborted) {
    lines.push(
      `> **Warning:** test run was aborted. Reason: ${test.meta.abortReason ?? "unknown"}`,
    );
    lines.push(``);
  }

  return lines.join("\n");
}
