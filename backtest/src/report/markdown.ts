/**
 * Markdown report generator — Phase 3.
 *
 * Phase 3 additions on top of Phase 2:
 *   - Equity curve summary (peak, max drawdown, final, Sharpe)
 *   - Drawdown periods (top 3 worst with dates)
 *   - Calibration bins table + ASCII bar chart
 *   - Per-rule attribution table (top 10 best/worst)
 *   - Side-by-side equity curve ASCII sparklines (test vs baseline)
 *
 * Phase 2: Generates a `summary.md` comparing two BacktestResult runs
 * (test strategy vs baseline strategy) side-by-side.
 */

import type { BacktestResult, BacktestSignal } from "../engine.js";
import type { EquityCurve, DrawdownPeriod } from "../equity/types.js";
import type { RuleAttribution } from "../attribution/types.js";
import type { CalibrationBin } from "../calibration/bins.js";

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

  // Phase 3 additions:

  /** Equity curve for the test strategy (Phase 3). */
  testEquityCurve?: EquityCurve;
  /** Equity curve for the baseline strategy (Phase 3). */
  baselineEquityCurve?: EquityCurve;
  /** Top-3 drawdown periods for the test strategy (Phase 3). */
  testDrawdownPeriods?: DrawdownPeriod[];
  /** Per-rule attribution for the test strategy (Phase 3). */
  testRuleAttribution?: RuleAttribution[];
  /** Calibration bins for the test strategy (Phase 3). */
  testCalibrationBins?: CalibrationBin[];
  /** Path to equity-curve.csv output file. */
  equityCurveCsvPath?: string;
  /** Path to per-rule-attribution.csv output file. */
  ruleAttributionCsvPath?: string;
  /** Path to calibration-by-bin.csv output file. */
  calibrationBinsCsvPath?: string;
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
// Top-5 winning / losing rules (Phase 2 helper, kept for Phase 3 compat)
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
// Phase 3: ASCII sparkline for equity curves
// ---------------------------------------------------------------------------

/**
 * Render a one-line ASCII sparkline from a sequence of equity values.
 * Uses ▁▂▃▄▅▆▇█ (8 levels).
 */
function sparkline(points: { equity: number }[], width = 40): string {
  if (points.length === 0) return "(no data)";
  const CHARS = "▁▂▃▄▅▆▇█";
  const N = CHARS.length;

  // Downsample to `width` buckets.
  const step = Math.max(1, Math.floor(points.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < points.length; i += step) {
    sampled.push(points[i]!.equity);
  }

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min;

  return sampled
    .map((v) => {
      if (range === 0) return CHARS[N - 1]!;
      const idx = Math.min(N - 1, Math.floor(((v - min) / range) * N));
      return CHARS[idx]!;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Phase 3: Calibration bins ASCII chart
// ---------------------------------------------------------------------------

/**
 * Render a two-row ASCII bar chart comparing stated confidence vs realized win rate per bin.
 */
function calibrationChart(bins: CalibrationBin[]): string {
  if (bins.length === 0) return "  (no bins — insufficient data)\n";

  const lines: string[] = [];
  lines.push("  Bin         Count  ConfMean  WinRate  Calibration");
  lines.push("  " + "─".repeat(52));

  for (const b of bins) {
    const label = `${(b.binMin * 100).toFixed(0)}-${(b.binMax * 100).toFixed(0)}%`;
    const confBar = asciiBar(b.meanConfidence, 10, "·", " ");
    const winBar = asciiBar(b.realizedWinRate, 10, "█", "░");
    const drift = b.realizedWinRate - b.meanConfidence;
    const driftLabel =
      drift >= 0 ? `+${(drift * 100).toFixed(1)}pp` : `${(drift * 100).toFixed(1)}pp`;
    lines.push(
      `  ${label.padEnd(8)} ${String(b.count).padStart(5)}  ${confBar}  ${winBar}  ${driftLabel}`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 3: Per-rule attribution table
// ---------------------------------------------------------------------------

function ruleAttributionTable(
  attributions: RuleAttribution[],
  direction: "best" | "worst",
  n = 10,
): string {
  if (attributions.length === 0) return "  (insufficient data — no rules fired ≥30 times)\n";

  const sorted = [...attributions].sort((a, b) => {
    const ac = a.contributionToEquity ?? 0;
    const bc = b.contributionToEquity ?? 0;
    return direction === "best" ? bc - ac : ac - bc;
  });

  const top = sorted.slice(0, n);

  const lines: string[] = [];
  lines.push("  Rule                           Fires  WinRate  MeanRet  ContribEquity");
  lines.push("  " + "─".repeat(70));

  for (const r of top) {
    const wr = r.winRate !== null ? `${(r.winRate * 100).toFixed(1)}%` : " n/a ";
    const mr = r.meanReturnPct !== null ? `${(r.meanReturnPct * 100).toFixed(2)}%` : "  n/a ";
    const ce =
      r.contributionToEquity !== null
        ? `${r.contributionToEquity >= 0 ? "+" : ""}${(r.contributionToEquity * 100).toFixed(2)}%`
        : "  n/a ";
    lines.push(
      `  ${r.rule.padEnd(32)} ${String(r.fireCount).padStart(5)}  ${wr.padStart(7)}  ${mr.padStart(7)}  ${ce.padStart(12)}`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 3: Equity curve summary
// ---------------------------------------------------------------------------

function equityCurveSummary(curve: EquityCurve, label: string): string[] {
  const lines: string[] = [];
  lines.push(`### Equity Curve — ${label}`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Final equity | ${curve.finalEquity.toFixed(4)}× |`);
  lines.push(`| Peak equity | ${curve.peakEquity.toFixed(4)}× |`);
  lines.push(`| Max drawdown | ${fmtPct(curve.maxDrawdownPct)} |`);
  lines.push(
    `| Trough | ${curve.trough.equity.toFixed(4)}× @ ${curve.trough.ts.substring(0, 10)} |`,
  );
  lines.push(
    `| Sharpe (annualized) | ${curve.sharpeAnnualized !== null ? curve.sharpeAnnualized.toFixed(3) : "n/a (< 30 signals)"} |`,
  );
  lines.push(``);
  return lines;
}

// ---------------------------------------------------------------------------
// Phase 3: Drawdown periods table
// ---------------------------------------------------------------------------

function drawdownPeriodsTable(periods: DrawdownPeriod[]): string[] {
  const lines: string[] = [];
  if (periods.length === 0) {
    lines.push("*(no drawdown periods detected)*");
    lines.push(``);
    return lines;
  }

  lines.push(`| # | Start | Trough | Recovery | Drawdown |`);
  lines.push(`|---|-------|--------|----------|----------|`);
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]!;
    lines.push(
      `| ${i + 1} | ${p.startTs.substring(0, 10)} | ${p.troughTs.substring(0, 10)} | ${p.recoveryTs?.substring(0, 10) ?? "ongoing"} | ${fmtPct(p.drawdownPct)} |`,
    );
  }
  lines.push(``);
  return lines;
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

  // ---------------------------------------------------------------------------
  // Phase 3: Equity curve summaries
  // ---------------------------------------------------------------------------

  if (opts.testEquityCurve || opts.baselineEquityCurve) {
    lines.push(`## Equity Curves`);
    lines.push(``);

    if (opts.testEquityCurve && opts.baselineEquityCurve) {
      // Side-by-side sparklines.
      lines.push(`### Side-by-Side Sparklines`);
      lines.push(``);
      lines.push("```");
      lines.push(`${testName.padEnd(20)} ${sparkline(opts.testEquityCurve.points, 40)}`);
      lines.push(`${baseName.padEnd(20)} ${sparkline(opts.baselineEquityCurve.points, 40)}`);
      lines.push("```");
      lines.push(``);
    }

    if (opts.testEquityCurve) {
      lines.push(...equityCurveSummary(opts.testEquityCurve, testName));
    }

    if (opts.baselineEquityCurve) {
      lines.push(...equityCurveSummary(opts.baselineEquityCurve, baseName));
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Drawdown periods
  // ---------------------------------------------------------------------------

  if (opts.testDrawdownPeriods) {
    lines.push(`## Top Drawdown Periods — ${testName}`);
    lines.push(``);
    lines.push(...drawdownPeriodsTable(opts.testDrawdownPeriods));
  }

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

  // Phase 3: equity curve metrics if available.
  if (opts.testEquityCurve && opts.baselineEquityCurve) {
    const te = opts.testEquityCurve;
    const be = opts.baselineEquityCurve;
    lines.push(
      `| Final equity | ${te.finalEquity.toFixed(4)}× | ${be.finalEquity.toFixed(4)}× | ${fmtDelta(te.finalEquity, be.finalEquity)} |`,
    );
    lines.push(
      `| Max drawdown | ${fmtPct(te.maxDrawdownPct)} | ${fmtPct(be.maxDrawdownPct)} | ${fmtPctDelta(te.maxDrawdownPct, be.maxDrawdownPct, false)} |`,
    );
    lines.push(
      `| Sharpe | ${fmtNum(te.sharpeAnnualized, 3)} | ${fmtNum(be.sharpeAnnualized, 3)} | ${fmtDelta(te.sharpeAnnualized, be.sharpeAnnualized)} |`,
    );
  }

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

  // Top winning / losing rules (Phase 2)
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

  // ---------------------------------------------------------------------------
  // Phase 3: Calibration bins
  // ---------------------------------------------------------------------------

  if (opts.testCalibrationBins) {
    lines.push(`## Calibration by Confidence Bin — ${testName}`);
    lines.push(``);
    lines.push("```");
    lines.push(calibrationChart(opts.testCalibrationBins));
    lines.push("```");
    lines.push(``);

    // Calibration bins markdown table
    if (opts.testCalibrationBins.length > 0) {
      lines.push(`| Bin | Count | Mean Conf | Win Rate |`);
      lines.push(`|-----|-------|-----------|----------|`);
      for (const b of opts.testCalibrationBins) {
        lines.push(
          `| ${(b.binMin * 100).toFixed(0)}–${(b.binMax * 100).toFixed(0)}% | ${b.count} | ${fmtPct(b.meanConfidence)} | ${fmtPct(b.realizedWinRate)} |`,
        );
      }
      lines.push(``);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Per-rule attribution tables
  // ---------------------------------------------------------------------------

  if (opts.testRuleAttribution && opts.testRuleAttribution.length > 0) {
    lines.push(`## Per-Rule Attribution — Top 10 Best Contributors (${testName})`);
    lines.push(``);
    lines.push("```");
    lines.push(ruleAttributionTable(opts.testRuleAttribution, "best", 10));
    lines.push("```");
    lines.push(``);

    lines.push(`## Per-Rule Attribution — Top 10 Worst Contributors (${testName})`);
    lines.push(``);
    lines.push("```");
    lines.push(ruleAttributionTable(opts.testRuleAttribution, "worst", 10));
    lines.push("```");
    lines.push(``);
  }

  // File pointers
  const csvPaths = [
    opts.tradesCsvPath && `- Trades CSV: \`${opts.tradesCsvPath}\``,
    opts.metricsJsonPath && `- Metrics JSON: \`${opts.metricsJsonPath}\``,
    opts.equityCurveCsvPath && `- Equity curve CSV: \`${opts.equityCurveCsvPath}\``,
    opts.ruleAttributionCsvPath && `- Per-rule attribution CSV: \`${opts.ruleAttributionCsvPath}\``,
    opts.calibrationBinsCsvPath && `- Calibration bins CSV: \`${opts.calibrationBinsCsvPath}\``,
  ].filter(Boolean);

  if (csvPaths.length > 0) {
    lines.push(`## Output Files`);
    lines.push(``);
    for (const p of csvPaths) {
      lines.push(p as string);
    }
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
