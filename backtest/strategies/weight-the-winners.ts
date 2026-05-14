/**
 * weight-the-winners strategy.
 *
 * Production data analysis (5/13/2026) identified 3 rules with real edge:
 *   - rsi-overbought:        64.3% TP over 393 fires
 *   - bollinger-touch-lower: 82.4% TP over 148 fires
 *   - macd-cross-bull:      100.0% TP over 20 fires
 *
 * Plus their mirror-direction counterparts (assuming structural symmetry to
 * be tested) to give the strategy both bullish and bearish opinions:
 *   - rsi-oversold (53.6% / 174) — mirror of rsi-overbought
 *   - macd-cross-bear (20% / 29) — mirror of macd-cross-bull (low TP — risky inclusion)
 *
 * Excludes the 8 mediocre/bad rules:
 *   - volume-spike-bull/bear (49-53%, noise-on-direction)
 *   - ema-stack-bull/bear (49-50%, no edge in isolation but heavily co-fire)
 *   - bollinger-touch-upper (0% — confirmed contaminating)
 *   - rsi-oversold-strong / rsi-overbought-strong (small n, mixed)
 *   - fng-* (no data observed in attribution panel)
 *
 * Tests the "confluence of curated rules only" hypothesis.
 */

import type { Strategy } from "../src/strategy/types.js";

const strategy: Strategy = {
  name: "weight-the-winners",
  description:
    "Whitelist of 5 rules with measured edge (rsi-overbought/oversold, " +
    "bollinger-touch-lower, macd-cross-bull/bear). Excludes all 9 mediocre " +
    "or zero-edge rules. Tests the curated-rule hypothesis.",
  enabledRules: [
    "rsi-overbought",
    "rsi-oversold",
    "bollinger-touch-lower",
    "macd-cross-bull",
    "macd-cross-bear",
  ],
  exitPolicy: { kind: "n-bars", nBars: 4 },
  sizing: { kind: "fixed-pct", pct: 0.01 },
};

export default strategy;
