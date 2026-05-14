/**
 * longer-hold strategy.
 *
 * Production-default exits after 4 bars of the emitting timeframe. For a 1h
 * signal that's a 4-hour holding period — too short to capture multi-day moves
 * but long enough to be whipsawed by intraday noise.
 *
 * This strategy keeps the production rule set but extends the exit to 16 bars
 * (e.g., 1h → 16h, 4h → 64h ≈ 2.5 days, 1d → 16 days). Tests whether longer
 * holding periods improve directional accuracy at the cost of fewer resolved
 * outcomes.
 */

import type { Strategy } from "../src/strategy/types.js";

const strategy: Strategy = {
  name: "longer-hold",
  description:
    "Production rules with a 16-bar exit instead of 4. Tests whether longer " +
    "holding periods filter out noise and improve directional win rate.",
  exitPolicy: { kind: "n-bars", nBars: 16 },
  sizing: { kind: "fixed-pct", pct: 0.01 },
};

export default strategy;
