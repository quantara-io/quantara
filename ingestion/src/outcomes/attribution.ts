/**
 * Rule attribution — Phase 8 (§10).
 *
 * Per-(rule, pair, timeframe) attribution: how accurate is a rule when it fires?
 * Used by Phase 8 follow-ups (auto-disable / pruning) and Kelly calibration.
 *
 * Windows: "30d" | "90d" (no 7d — not enough data per rule to be meaningful).
 */

import type { OutcomeRecord } from "./resolver.js";

export type AttributionWindow = "30d" | "90d";

export interface RuleAttribution {
  /** Composite PK: "rule#pair#timeframe". */
  pk: string;
  rule: string;
  pair: string;
  timeframe: string;
  window: AttributionWindow;
  fireCount: number;
  correctCount: number;
  incorrectCount: number;
  neutralCount: number;
  /**
   * Directional accuracy when this rule fired:
   * correctCount / (correctCount + incorrectCount).
   * null if no directional outcomes.
   */
  contribution: number | null;
  computedAt: string;
  /** computedAt + 7 days (Unix seconds). */
  ttl: number;
}

const TTL_SECONDS = 86400 * 7;

const WINDOW_MS: Record<AttributionWindow, number> = {
  "30d": 86400 * 30 * 1000,
  "90d": 86400 * 90 * 1000,
};

/**
 * Build a RuleAttribution aggregate from a set of outcome records in which
 * the given rule was among rulesFired.
 *
 * The caller is responsible for:
 *   1. Pre-filtering outcomes to those where rule is in rulesFired.
 *   2. Passing all outcomes (not just the window) — this function filters by window.
 *
 * @param rule        Rule identifier (e.g. "rsi_oversold").
 * @param pair        Trading pair.
 * @param timeframe   Emitting timeframe.
 * @param window      Rolling window size.
 * @param outcomes    All outcome records where this rule fired.
 * @param nowIso      Current time (ISO8601); defaults to now.
 */
export function buildRuleAttribution(
  rule: string,
  pair: string,
  timeframe: string,
  window: AttributionWindow,
  outcomes: OutcomeRecord[],
  nowIso: string = new Date().toISOString(),
): RuleAttribution {
  const nowMs = new Date(nowIso).getTime();
  const windowStart = new Date(nowMs - WINDOW_MS[window]).toISOString();

  // Filter to non-invalidated outcomes in window where this rule fired.
  const inWindow = outcomes.filter(
    (o) =>
      !o.invalidatedExcluded &&
      o.resolvedAt >= windowStart &&
      o.rulesFired.includes(rule),
  );

  const correctCount = inWindow.filter((o) => o.outcome === "correct").length;
  const incorrectCount = inWindow.filter((o) => o.outcome === "incorrect").length;
  const neutralCount = inWindow.filter((o) => o.outcome === "neutral").length;
  const fireCount = inWindow.length;

  const directional = correctCount + incorrectCount;
  const contribution = directional > 0 ? correctCount / directional : null;

  const ttl = Math.floor(new Date(nowIso).getTime() / 1000) + TTL_SECONDS;

  return {
    pk: `${rule}#${pair}#${timeframe}`,
    rule,
    pair,
    timeframe,
    window,
    fireCount,
    correctCount,
    incorrectCount,
    neutralCount,
    contribution,
    computedAt: nowIso,
    ttl,
  };
}

/**
 * Collect all unique rule#pair#timeframe keys from a set of outcome records.
 * Used by the handler to enumerate which attribution buckets to recompute.
 */
export function getAffectedAttributionKeys(outcomes: OutcomeRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const o of outcomes) {
    for (const rule of o.rulesFired) {
      keys.add(`${rule}#${o.pair}#${o.emittingTimeframe}`);
    }
  }
  return keys;
}
