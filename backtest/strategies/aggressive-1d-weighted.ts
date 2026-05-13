/**
 * aggressive-1d-weighted strategy — Phase 2.
 *
 * Experimental strategy: boosts 1d weight to 0.50 (vs production's 0.35),
 * reduces 15m to 0.05, keeps 1h/4h the same. This biases signal generation
 * toward longer time-horizon consensus at the cost of missing fast short-TF moves.
 *
 * Also sets a lower ratification confidence threshold (0.40 vs default 0.50)
 * to allow more borderline signals through for LLM ratification — useful for
 * measuring whether LLM ratification helps at lower algo-confidence levels.
 *
 * Intended as an experimental candidate against production-default.ts.
 */

import type { Strategy } from "../src/strategy/types.js";

const strategy: Strategy = {
  name: "aggressive-1d-weighted",
  description:
    "Heavier 1d weight (0.50) at the expense of 15m (0.05). " +
    "Lower ratification floor (0.40) to widen the LLM gate window. " +
    "Experimental: test whether 1d-dominant blending improves win-rate on slow macro moves.",
  // All rules enabled — we want to see the full rule contribution at skewed weights.
  timeframeWeights: {
    "1m": 0,
    "5m": 0,
    "15m": 0.05,
    "1h": 0.2,
    "4h": 0.25,
    "1d": 0.5,
  },
  ratificationThreshold: 0.4,
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
