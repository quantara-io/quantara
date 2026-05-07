import type { SignalType } from "../types/signals.js";
import type { Rule } from "../types/rules.js";

export const SIGNAL_COLORS: Record<SignalType, { themeA: string; themeB: string }> = {
  buy:  { themeA: "#2EE6A8", themeB: "#7FD494" },
  sell: { themeA: "#FF5C7A", themeB: "#E56B5F" },
  hold: { themeA: "#FFB547", themeB: "#F0B94A" },
};

export const ADVISORY_DISCLAIMER =
  "Signals are for educational and advisory purposes only. Quantara does not execute trades on your behalf.";

export const VOLATILITY_BANNER =
  "High market volatility detected. All signals set to HOLD. Exercise caution.";

// ---------------------------------------------------------------------------
// v1 Rule library — Appendix A (docs/SIGNALS_AND_RISK.md)
// ---------------------------------------------------------------------------

/**
 * Minimum directional score (sum of fired rule strengths) required before
 * scoreTimeframe emits a buy or sell signal. Rules below this threshold
 * collapse to hold.
 */
export const MIN_CONFLUENCE = 1.5;

/**
 * Canonical v1 rule set. Rules are pure predicates over IndicatorState.
 *
 * Design: §4.7 + Appendix A of docs/SIGNALS_AND_RISK.md
 *
 * Groups:
 *   rsi-oversold-tier  — mutual exclusion between rsi-oversold and rsi-oversold-strong
 *   rsi-overbought-tier — mutual exclusion between rsi-overbought and rsi-overbought-strong
 *   (EMA, MACD, Bollinger, volume, F&G rules have no group — each is standalone)
 */
export const RULES: Rule[] = [
  // === Momentum: RSI tiers (group: rsi-oversold-tier / rsi-overbought-tier) ===
  {
    name: "rsi-oversold-strong",
    direction: "bullish",
    strength: 1.5,
    when: (s) => s.rsi14 !== null && s.rsi14 < 20,
    appliesTo: ["15m", "1h", "4h", "1d"],
    group: "rsi-oversold-tier",
    requiresPrior: 14,
  },
  {
    name: "rsi-oversold",
    direction: "bullish",
    strength: 1.0,
    when: (s) => s.rsi14 !== null && s.rsi14 >= 20 && s.rsi14 < 30,
    appliesTo: ["15m", "1h", "4h", "1d"],
    group: "rsi-oversold-tier",
    requiresPrior: 14,
  },
  {
    name: "rsi-overbought-strong",
    direction: "bearish",
    strength: 1.5,
    when: (s) => s.rsi14 !== null && s.rsi14 > 80,
    appliesTo: ["15m", "1h", "4h", "1d"],
    group: "rsi-overbought-tier",
    requiresPrior: 14,
  },
  {
    name: "rsi-overbought",
    direction: "bearish",
    strength: 1.0,
    when: (s) => s.rsi14 !== null && s.rsi14 > 70 && s.rsi14 <= 80,
    appliesTo: ["15m", "1h", "4h", "1d"],
    group: "rsi-overbought-tier",
    requiresPrior: 14,
  },

  // === Trend: EMA stack (regime — only longer TFs) ===
  {
    name: "ema-stack-bull",
    direction: "bullish",
    strength: 0.8,
    when: (s) =>
      s.ema20 !== null && s.ema50 !== null && s.ema200 !== null &&
      s.ema20 > s.ema50 && s.ema50 > s.ema200,
    appliesTo: ["4h", "1d"],
    requiresPrior: 600,
  },
  {
    name: "ema-stack-bear",
    direction: "bearish",
    strength: 0.8,
    when: (s) =>
      s.ema20 !== null && s.ema50 !== null && s.ema200 !== null &&
      s.ema20 < s.ema50 && s.ema50 < s.ema200,
    appliesTo: ["4h", "1d"],
    requiresPrior: 600,
  },

  // === Trend: MACD cross (1h+ — noisy on 15m) ===
  {
    name: "macd-cross-bull",
    direction: "bullish",
    strength: 1.0,
    when: (s) => {
      const cur = s.macdHist;
      const prev = s.history.macdHist[0] ?? null;
      return cur !== null && prev !== null && cur > 0 && prev <= 0;
    },
    appliesTo: ["1h", "4h", "1d"],
    cooldownBars: 3,
    requiresPrior: 26,
  },
  {
    name: "macd-cross-bear",
    direction: "bearish",
    strength: 1.0,
    when: (s) => {
      const cur = s.macdHist;
      const prev = s.history.macdHist[0] ?? null;
      return cur !== null && prev !== null && cur < 0 && prev >= 0;
    },
    appliesTo: ["1h", "4h", "1d"],
    cooldownBars: 3,
    requiresPrior: 26,
  },

  // === Mean reversion: Bollinger touches (4h+ only — noisy on shorter TFs) ===
  {
    name: "bollinger-touch-lower",
    direction: "bullish",
    strength: 0.5,
    when: (s) => {
      if (s.history.close.length === 0 || s.bbLower === null || s.bbWidth === null) return false;
      const close = s.history.close[0];
      // Require non-trivial band width — avoids constant fires during calm periods
      return close !== null && close <= s.bbLower && s.bbWidth > 0.005;
    },
    appliesTo: ["4h", "1d"],
    requiresPrior: 20,
  },
  {
    name: "bollinger-touch-upper",
    direction: "bearish",
    strength: 0.5,
    when: (s) => {
      if (s.history.close.length === 0 || s.bbUpper === null || s.bbWidth === null) return false;
      const close = s.history.close[0];
      return close !== null && close >= s.bbUpper && s.bbWidth > 0.005;
    },
    appliesTo: ["4h", "1d"],
    requiresPrior: 20,
  },

  // === Volume confirmation ===
  {
    name: "volume-spike-bull",
    direction: "bullish",
    strength: 0.7,
    when: (s) => {
      if (s.volZ === null || s.history.close.length < 2) return false;
      const close = s.history.close[0];
      const prevClose = s.history.close[1];
      return s.volZ > 2 && close !== null && prevClose !== null && close > prevClose;
    },
    appliesTo: ["15m", "1h", "4h", "1d"],
    requiresPrior: 20,
  },
  {
    name: "volume-spike-bear",
    direction: "bearish",
    strength: 0.7,
    when: (s) => {
      if (s.volZ === null || s.history.close.length < 2) return false;
      const close = s.history.close[0];
      const prevClose = s.history.close[1];
      return s.volZ > 2 && close !== null && prevClose !== null && close < prevClose;
    },
    appliesTo: ["15m", "1h", "4h", "1d"],
    requiresPrior: 20,
  },

  // === Sentiment overlay (Fear & Greed only — news lives in LLM ratification) ===
  {
    name: "fng-extreme-greed",
    direction: "bearish",
    strength: 0.3,
    when: (s) => s.fearGreed !== null && s.fearGreed > 75,
    appliesTo: ["15m", "1h", "4h", "1d"],
    requiresPrior: 0,
  },
  {
    name: "fng-extreme-fear",
    direction: "bullish",
    strength: 0.3,
    when: (s) => s.fearGreed !== null && s.fearGreed < 25,
    appliesTo: ["15m", "1h", "4h", "1d"],
    requiresPrior: 0,
  },
];
