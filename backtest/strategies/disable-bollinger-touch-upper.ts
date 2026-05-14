/**
 * disable-bollinger-touch-upper strategy.
 *
 * Production data analysis (5/13/2026): bollinger-touch-upper fired 527 times
 * with 0.0% TP rate. Every co-firing pair containing it is 0% (e.g.,
 * +ema-stack-bull: 526 → 0%, +rsi-overbought: 280 → 0%). It's pure noise
 * contamination dragging down the directional accuracy.
 *
 * This strategy disables JUST that one rule by whitelisting the remaining 13.
 * Compares to production-default to measure the lift from removing a single
 * 0%-edge rule.
 */

import type { Strategy } from "../src/strategy/types.js";

const strategy: Strategy = {
  name: "disable-bollinger-touch-upper",
  description:
    "Production baseline minus bollinger-touch-upper (0% TP over 527 fires). " +
    "Tests whether dropping a single zero-edge rule improves the overall signal mix.",
  enabledRules: [
    "rsi-oversold-strong",
    "rsi-oversold",
    "rsi-overbought-strong",
    "rsi-overbought",
    "ema-stack-bull",
    "ema-stack-bear",
    "macd-cross-bull",
    "macd-cross-bear",
    "bollinger-touch-lower",
    // bollinger-touch-upper INTENTIONALLY OMITTED
    "volume-spike-bull",
    "volume-spike-bear",
    "fng-extreme-greed",
    "fng-extreme-fear",
  ],
  exitPolicy: { kind: "n-bars", nBars: 4 },
  sizing: { kind: "fixed-pct", pct: 0.01 },
};

export default strategy;
