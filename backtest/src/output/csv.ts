/**
 * output/csv.ts — Phase 3 CSV writers for backtest output files.
 *
 * Writes three CSV files:
 *   - equity-curve.csv    — one row per EquityPoint
 *   - per-rule-attribution.csv — one row per RuleAttribution
 *   - calibration-by-bin.csv  — one row per CalibrationBin
 *
 * All functions return the CSV string (for testability); callers write to disk.
 */

import type { EquityPoint } from "../equity/types.js";
import type { RuleAttribution } from "../attribution/types.js";
import type { CalibrationBin } from "../calibration/bins.js";

// ---------------------------------------------------------------------------
// Equity curve CSV
// ---------------------------------------------------------------------------

/**
 * Schema: ts, equity, drawdownPct, signalsToDate, winsToDate
 */
export function equityCurveToCsv(points: EquityPoint[]): string {
  const header = "ts,equity,drawdownPct,signalsToDate,winsToDate";
  const rows = points.map(
    (p) =>
      `${p.ts},${p.equity.toFixed(6)},${p.drawdownPct.toFixed(6)},${p.signalsToDate},${p.winsToDate}`,
  );
  return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Per-rule attribution CSV
// ---------------------------------------------------------------------------

/**
 * Schema: rule, fireCount, correctCount, incorrectCount, neutralCount, winRate, meanReturnPct, contributionToEquity
 */
export function ruleAttributionToCsv(attributions: RuleAttribution[]): string {
  const header =
    "rule,fireCount,correctCount,incorrectCount,neutralCount,winRate,meanReturnPct,contributionToEquity";
  const rows = attributions.map((a) => {
    const winRate = a.winRate !== null ? a.winRate.toFixed(6) : "";
    const meanReturn = a.meanReturnPct !== null ? a.meanReturnPct.toFixed(6) : "";
    const contrib = a.contributionToEquity !== null ? a.contributionToEquity.toFixed(6) : "";
    return `${a.rule},${a.fireCount},${a.correctCount},${a.incorrectCount},${a.neutralCount},${winRate},${meanReturn},${contrib}`;
  });
  return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Calibration-by-bin CSV
// ---------------------------------------------------------------------------

/**
 * Schema: bin_min, bin_max, count, mean_confidence, realized_win_rate
 */
export function calibrationBinsToCsv(bins: CalibrationBin[]): string {
  const header = "bin_min,bin_max,count,mean_confidence,realized_win_rate";
  const rows = bins.map(
    (b) =>
      `${b.binMin.toFixed(1)},${b.binMax.toFixed(1)},${b.count},${b.meanConfidence.toFixed(6)},${b.realizedWinRate.toFixed(6)}`,
  );
  return [header, ...rows].join("\n");
}
