/**
 * confluence-gated strategy — Phase 9, Track A item 1.
 *
 * Finding from the 1-year 360-degree backtest review (results/y1-360-degree-review/REPORT.md,
 * Test 3): every individual rule has TP < 50% over 1y BTC/USDT, but pair-level
 * co-fires show real positive edge. This strategy emits a signal only when at
 * least one synergy pair co-fires, and suppresses emission entirely when any
 * anti-synergy pair co-fires (even if other synergy pairs also fired).
 *
 * Synergy pairs (from the analysis table):
 *   rsi-oversold + rsi-oversold-strong           175 joint fires, 65.4% TP, +11.4pp lift
 *   macd-cross-bull + rsi-overbought             217 joint fires, 50.7% TP, +6.0pp lift
 *   bollinger-touch-lower + rsi-oversold-strong  231 joint fires, 58.5% TP, +4.5pp lift
 *   macd-cross-bear + rsi-oversold               196 joint fires, 45.9% TP, +3.0pp lift
 *   bollinger-touch-lower + volume-spike-bull    843 joint fires, 50.5% TP, +2.1pp lift
 *
 * Anti-synergy pairs (suppress to avoid noise):
 *   macd-cross-bear + macd-cross-bull   23.0% TP, −20.3pp anti-lift
 *   ema-stack-bear + rsi-oversold-strong  28.2% TP, −25.8pp anti-lift
 *   ema-stack-bear + rsi-overbought      34.6% TP, −10.1pp anti-lift
 */

import type { Strategy, RuleId } from "../src/strategy/types.js";

const SYNERGY_PAIRS: ReadonlyArray<readonly [RuleId, RuleId]> = [
  ["rsi-oversold", "rsi-oversold-strong"],
  ["macd-cross-bull", "rsi-overbought"],
  ["bollinger-touch-lower", "rsi-oversold-strong"],
  ["macd-cross-bear", "rsi-oversold"],
  ["bollinger-touch-lower", "volume-spike-bull"],
];

const ANTI_SYNERGIES: ReadonlyArray<readonly [RuleId, RuleId]> = [
  ["macd-cross-bear", "macd-cross-bull"],
  ["ema-stack-bear", "rsi-oversold-strong"],
  ["ema-stack-bear", "rsi-overbought"],
];

const strategy: Strategy = {
  name: "confluence-gated",
  description:
    "Emit only when a synergy pair co-fires (rsi-oversold+strong, macd-cross-bull+rsi-overbought, " +
    "bollinger-touch-lower+rsi-oversold-strong, macd-cross-bear+rsi-oversold, " +
    "bollinger-touch-lower+volume-spike-bull). " +
    "Suppress when any anti-synergy pair co-fires (macd-cross-bear+bull, ema-stack-bear+rsi-oversold-strong, " +
    "ema-stack-bear+rsi-overbought). " +
    "Derived from 1-year 360-degree backtest review (Phase 9 Track A). " +
    "All rules enabled; default TF weights (15m/1h/4h/1d = 0.15/0.20/0.30/0.35).",
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
  emissionGate: (rulesFired: Set<RuleId>): "emit" | "suppress" => {
    // Anti-synergy check takes precedence: suppress even if a synergy pair also co-fired.
    if (ANTI_SYNERGIES.some(([a, b]) => rulesFired.has(a) && rulesFired.has(b))) {
      return "suppress";
    }
    // Require at least one synergy pair to co-fire.
    if (SYNERGY_PAIRS.some(([a, b]) => rulesFired.has(a) && rulesFired.has(b))) {
      return "emit";
    }
    return "suppress";
  },
};

export default strategy;
