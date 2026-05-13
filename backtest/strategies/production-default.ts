/**
 * production-default strategy — Phase 2.
 *
 * Mirrors the current production defaults exactly:
 *   - All rules enabled (no enabledRules override)
 *   - Per-TF weights from DEFAULT_TIMEFRAME_WEIGHTS in blend.ts:
 *       15m=0.15, 1h=0.20, 4h=0.30, 1d=0.35
 *   - Default ratification threshold (50% confidence floor)
 *   - 4-bar exit (matches EXPIRY_BARS in engine.ts)
 *   - Fixed 1% position sizing (placeholder — backtest doesn't size positions in Phase 2)
 *
 * Use this as the canonical --baseline when comparing experimental strategies.
 */

import type { Strategy } from "../src/strategy/types.js";

const strategy: Strategy = {
  name: "production-default",
  description:
    "Mirrors the live production pipeline: all rules enabled, default 15m/1h/4h/1d weights " +
    "(0.15/0.20/0.30/0.35), 4-bar n-bars exit, 1% fixed sizing. " +
    "Use as the baseline for A/B strategy comparisons.",
  // enabledRules: undefined → all rules active
  // timeframeWeights: undefined → uses DEFAULT_TIMEFRAME_WEIGHTS from blend.ts
  exitPolicy: {
    kind: "n-bars",
    nBars: 4,
  },
  sizing: {
    kind: "fixed-pct",
    pct: 0.01,
  },
};

export default strategy;
