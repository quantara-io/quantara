/**
 * attribution/types.ts — Phase 3 per-rule attribution types.
 */

export interface RuleAttribution {
  /** Rule name (matches entries in BacktestSignal.rulesFired). */
  rule: string;
  /** Total signals where this rule fired. */
  fireCount: number;
  /** Number of those signals that resolved as correct. */
  correctCount: number;
  /** Number of those signals that resolved as incorrect. */
  incorrectCount: number;
  /** Number of those signals that resolved as neutral. */
  neutralCount: number;
  /** correct / (correct + incorrect) — null if no directional signals. */
  winRate: number | null;
  /** Average priceMovePct (signed, directional) when this rule fired. null if none. */
  meanReturnPct: number | null;
  /**
   * Delta final equity vs a counterfactual run that disabled this rule.
   * Positive = this rule helped equity; negative = it hurt equity.
   * null if counterfactual was not computed (rule outside top-20 cap).
   */
  contributionToEquity: number | null;
}
