/**
 * backtest-strategies.ts — Phase 4 (issue #371).
 *
 * Option B: strategies are version-controlled in backtest/strategies/*.ts
 * and exposed via a static registry. No user uploads, no dynamic import at
 * request time — just a curated list that the admin dropdown is populated from.
 *
 * To add a new strategy: add a file to backtest/strategies/ and add an entry
 * to BACKTEST_STRATEGIES below.
 */

export interface StrategyMeta {
  /** Filename (without .ts extension). Used as the strategy identifier in API calls. */
  name: string;
  /** Human-readable description shown in the admin UI dropdown. */
  description: string;
}

/**
 * Curated list of available strategies.
 * Source of truth: backtest/strategies/*.ts
 */
export const BACKTEST_STRATEGIES: StrategyMeta[] = [
  {
    name: "production-default",
    description:
      "Mirrors the live production pipeline: all rules enabled, default 15m/1h/4h/1d weights " +
      "(0.15/0.20/0.30/0.35), 4-bar n-bars exit, 1% fixed sizing. " +
      "Use as the baseline for A/B strategy comparisons.",
  },
  {
    name: "aggressive-1d-weighted",
    description:
      "Heavier 1d weight (0.50) at the expense of 15m (0.05). " +
      "Lower ratification confidence threshold (0.40 vs production 0.50). " +
      "Experimental candidate for longer time-horizon bias.",
  },
];
