/**
 * attribution/compute.ts — Phase 3 per-rule attribution breakdown.
 *
 * For each rule that fired in at least MIN_RULE_FIRES signals, compute:
 *   - fireCount / correct / incorrect / neutral counts
 *   - winRate (correct / directional)
 *   - meanReturnPct (average signed return when the rule fired)
 *   - contributionToEquity — counterfactual equity delta (rule disabled)
 *
 * Counterfactual reruns are capped at the top MAX_COUNTERFACTUAL_RULES rules
 * by fire count to keep compute reasonable.
 */

import type { BacktestSignal } from "../engine.js";
import type { Strategy } from "../strategy/types.js";
import { simulateEquityCurve } from "../equity/simulator.js";
import type { RuleAttribution } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum number of signal fires for a rule to appear in the attribution table. */
export const MIN_RULE_FIRES = 30;

/** Maximum number of rules for which the counterfactual rerun is performed. */
export const MAX_COUNTERFACTUAL_RULES = 20;

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute per-rule attribution for all rules that fired >= MIN_RULE_FIRES times.
 *
 * @param signals   Full signal list from the backtest run.
 * @param sizing    Strategy sizing policy (used for the counterfactual reruns).
 * @param baselineEquity   Final equity from the base run (passed in to avoid recomputing).
 */
export function computeRuleAttribution(
  signals: BacktestSignal[],
  sizing: Strategy["sizing"],
  baselineEquity: number,
): RuleAttribution[] {
  // Phase 1: collect per-rule statistics.
  const stats = new Map<
    string,
    {
      fireCount: number;
      correctCount: number;
      incorrectCount: number;
      neutralCount: number;
      returnSum: number;
      returnCount: number;
    }
  >();

  for (const sig of signals) {
    for (const rule of sig.rulesFired) {
      if (!stats.has(rule)) {
        stats.set(rule, {
          fireCount: 0,
          correctCount: 0,
          incorrectCount: 0,
          neutralCount: 0,
          returnSum: 0,
          returnCount: 0,
        });
      }
      const s = stats.get(rule)!;
      s.fireCount += 1;

      if (sig.outcome === "correct") {
        s.correctCount += 1;
      } else if (sig.outcome === "incorrect") {
        s.incorrectCount += 1;
      } else if (sig.outcome === "neutral") {
        s.neutralCount += 1;
      }

      // Signed return: positive for buy-direction wins, negative for losses.
      if (sig.outcome !== null && sig.priceMovePct !== null) {
        const isShort = sig.type === "sell" || sig.type === "strong-sell";
        const signedReturn = isShort ? -sig.priceMovePct : sig.priceMovePct;
        s.returnSum += signedReturn;
        s.returnCount += 1;
      }
    }
  }

  // Phase 2: filter to rules with MIN_RULE_FIRES fires.
  const eligible = [...stats.entries()]
    .filter(([, s]) => s.fireCount >= MIN_RULE_FIRES)
    .sort((a, b) => b[1].fireCount - a[1].fireCount);

  // Phase 3: counterfactual reruns for top-MAX_COUNTERFACTUAL_RULES rules.
  const counterfactualRules = new Set(eligible.slice(0, MAX_COUNTERFACTUAL_RULES).map(([r]) => r));

  const counterfactualEquity = new Map<string, number>();
  for (const [rule] of eligible) {
    if (!counterfactualRules.has(rule)) break;

    // Remove this rule from every signal's rulesFired list.
    // A signal whose rulesFired becomes empty is dropped (no signal would have fired).
    const disabledSignals = signals.map((sig) => {
      const filtered = sig.rulesFired.filter((r) => r !== rule);
      if (filtered.length === sig.rulesFired.length) return sig; // rule wasn't present
      if (filtered.length === 0) {
        // No rules left — this signal wouldn't have emitted; treat as unresolved neutral.
        return { ...sig, rulesFired: filtered, outcome: null as typeof sig.outcome };
      }
      return { ...sig, rulesFired: filtered };
    });

    const cfCurve = simulateEquityCurve(disabledSignals, sizing);
    counterfactualEquity.set(rule, cfCurve.finalEquity);
  }

  // Phase 4: assemble output.
  return eligible.map(([rule, s]) => {
    const directional = s.correctCount + s.incorrectCount;
    const winRate = directional > 0 ? s.correctCount / directional : null;
    const meanReturnPct = s.returnCount > 0 ? s.returnSum / s.returnCount : null;

    let contributionToEquity: number | null = null;
    const cfEquity = counterfactualEquity.get(rule);
    if (cfEquity !== undefined) {
      contributionToEquity = baselineEquity - cfEquity;
    }

    return {
      rule,
      fireCount: s.fireCount,
      correctCount: s.correctCount,
      incorrectCount: s.incorrectCount,
      neutralCount: s.neutralCount,
      winRate,
      meanReturnPct,
      contributionToEquity,
    };
  });
}
