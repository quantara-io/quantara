import type { SignalType } from "../types/signals.js";
import type { Rule } from "../types/rules.js";

export const SIGNAL_COLORS: Record<SignalType, { themeA: string; themeB: string }> = {
  "strong-buy": { themeA: "#00C97A", themeB: "#1DBF7D" },
  buy: { themeA: "#2EE6A8", themeB: "#7FD494" },
  hold: { themeA: "#FFB547", themeB: "#F0B94A" },
  sell: { themeA: "#FF5C7A", themeB: "#E56B5F" },
  "strong-sell": { themeA: "#C4003C", themeB: "#B0003A" },
};

export const ADVISORY_DISCLAIMER =
  "Signals are for educational and advisory purposes only. Quantara does not execute trades on your behalf.";

export const VOLATILITY_BANNER =
  "High market volatility detected. All signals set to HOLD. Exercise caution.";

/**
 * Minimum directional score required to emit a buy/sell signal.
 * Shared across all scoring engines — importers must NOT redeclare this locally.
 * Design: §4.3 of docs/SIGNALS_AND_RISK.md
 */
export const MIN_CONFLUENCE = 1.5;

/**
 * Directional score required to emit a strong-buy or strong-sell signal.
 * Added in v2 Phase 2 (#253).
 */
export const STRONG_CONFLUENCE = 3.0;

/**
 * Minimum net margin (bull - bear for strong-buy; bear - bull for strong-sell)
 * required alongside STRONG_CONFLUENCE to reach the strong tier.
 * Prevents noisy strong-* signals when opposing evidence is high.
 * Added in v2 Phase 2 (#253).
 */
export const STRONG_NET_MARGIN = 2.0;

/**
 * Appendix A — full rule library (14 rules).
 *
 * Aggregator convention (confirmed in aggregator.test.ts:147-148):
 *   history.X[0] = current bar (most recent)
 *   history.X[1] = previous bar (t-1)
 *   history.X[2] = t-2, etc.
 *
 * All `when` predicates guard null values before comparison.
 * Design: Appendix A + §4.7 appliesTo table of docs/SIGNALS_AND_RISK.md
 */
export const RULES: Rule[] = [
  // -------------------------------------------------------------------------
  // Momentum — RSI tiers
  // Group: rsi-oversold-tier (bullish, pick highest-strength that fires)
  // -------------------------------------------------------------------------
  {
    name: "rsi-oversold-strong",
    direction: "bullish",
    strength: 1.5,
    when: (s) => s.rsi14 !== null && s.rsi14 < 20,
    appliesTo: ["15m", "1h", "4h", "1d"],
    group: "rsi-oversold-tier",
    cooldownBars: 0,
    requiresPrior: 20,
  },
  {
    name: "rsi-oversold",
    direction: "bullish",
    strength: 1.0,
    when: (s) => s.rsi14 !== null && s.rsi14 >= 20 && s.rsi14 < 30,
    appliesTo: ["15m", "1h", "4h", "1d"],
    group: "rsi-oversold-tier",
    cooldownBars: 0,
    requiresPrior: 20,
  },
  // Group: rsi-overbought-tier (bearish, pick highest-strength that fires)
  {
    name: "rsi-overbought-strong",
    direction: "bearish",
    strength: 1.5,
    when: (s) => s.rsi14 !== null && s.rsi14 > 80,
    appliesTo: ["15m", "1h", "4h", "1d"],
    group: "rsi-overbought-tier",
    cooldownBars: 0,
    requiresPrior: 20,
  },
  {
    name: "rsi-overbought",
    direction: "bearish",
    strength: 1.0,
    when: (s) => s.rsi14 !== null && s.rsi14 > 70 && s.rsi14 <= 80,
    appliesTo: ["15m", "1h", "4h", "1d"],
    group: "rsi-overbought-tier",
    cooldownBars: 0,
    requiresPrior: 20,
  },

  // -------------------------------------------------------------------------
  // Trend — EMA stack
  // §4.7: appliesTo 4h, 1d only (noisy on shorter TFs)
  // -------------------------------------------------------------------------
  {
    name: "ema-stack-bull",
    direction: "bullish",
    strength: 1.0,
    when: (s) =>
      s.ema20 !== null &&
      s.ema50 !== null &&
      s.ema200 !== null &&
      s.ema20 > s.ema50 &&
      s.ema50 > s.ema200,
    appliesTo: ["4h", "1d"],
    cooldownBars: 0,
    requiresPrior: 200,
  },
  {
    name: "ema-stack-bear",
    direction: "bearish",
    strength: 1.0,
    when: (s) =>
      s.ema20 !== null &&
      s.ema50 !== null &&
      s.ema200 !== null &&
      s.ema20 < s.ema50 &&
      s.ema50 < s.ema200,
    appliesTo: ["4h", "1d"],
    cooldownBars: 0,
    requiresPrior: 200,
  },

  // -------------------------------------------------------------------------
  // Trend — MACD histogram cross
  // §4.7: appliesTo 1h, 4h, 1d
  // history.macdHist[0] = current bar, history.macdHist[1] = previous bar
  // (aggregator convention: most-recent-first)
  // -------------------------------------------------------------------------
  {
    name: "macd-cross-bull",
    direction: "bullish",
    strength: 1.0,
    when: (s) => {
      const cur = s.macdHist;
      const prev = s.history.macdHist[1] ?? null; // index 1 = previous bar (t-1)
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
      const prev = s.history.macdHist[1] ?? null; // index 1 = previous bar (t-1)
      return cur !== null && prev !== null && cur < 0 && prev >= 0;
    },
    appliesTo: ["1h", "4h", "1d"],
    cooldownBars: 3,
    requiresPrior: 26,
  },

  // -------------------------------------------------------------------------
  // Mean reversion — Bollinger Band touches
  // §4.7: appliesTo 4h, 1d (noisy on 15m/1h)
  // -------------------------------------------------------------------------
  {
    name: "bollinger-touch-lower",
    direction: "bullish",
    strength: 0.5,
    when: (s) =>
      s.history.close[0] !== null &&
      s.bbLower !== null &&
      (s.history.close[0] as number) <= s.bbLower,
    appliesTo: ["4h", "1d"],
    cooldownBars: 0,
    requiresPrior: 20,
  },
  {
    name: "bollinger-touch-upper",
    direction: "bearish",
    strength: 0.5,
    when: (s) =>
      s.history.close[0] !== null &&
      s.bbUpper !== null &&
      (s.history.close[0] as number) >= s.bbUpper,
    appliesTo: ["4h", "1d"],
    cooldownBars: 0,
    requiresPrior: 20,
  },

  // -------------------------------------------------------------------------
  // Volume confirmation — volume spike with directional bar
  // history.close[0] = current close, history.close[1] = previous close
  // volume-spike uses close[0] vs close[1] (current vs prev) to determine
  // bullish/bearish bar direction (close > prev_close = bullish bar)
  // §4.7: appliesTo 15m, 1h, 4h, 1d
  // -------------------------------------------------------------------------
  {
    name: "volume-spike-bull",
    direction: "bullish",
    strength: 0.5,
    when: (s) => {
      const close = s.history.close[0];
      const prevClose = s.history.close[1] ?? null;
      return (
        s.volZ !== null &&
        s.volZ > 2 &&
        close !== null &&
        prevClose !== null &&
        (close as number) > (prevClose as number)
      );
    },
    appliesTo: ["15m", "1h", "4h", "1d"],
    cooldownBars: 0,
    requiresPrior: 20,
  },
  {
    name: "volume-spike-bear",
    direction: "bearish",
    strength: 0.5,
    when: (s) => {
      const close = s.history.close[0];
      const prevClose = s.history.close[1] ?? null;
      return (
        s.volZ !== null &&
        s.volZ > 2 &&
        close !== null &&
        prevClose !== null &&
        (close as number) < (prevClose as number)
      );
    },
    appliesTo: ["15m", "1h", "4h", "1d"],
    cooldownBars: 0,
    requiresPrior: 20,
  },

  // -------------------------------------------------------------------------
  // Sentiment overlay — Fear & Greed extremes
  // §4.7: appliesTo 15m, 1h, 4h, 1d
  // -------------------------------------------------------------------------
  {
    name: "fng-extreme-greed",
    direction: "bearish",
    strength: 0.3,
    when: (s) => s.fearGreed !== null && s.fearGreed > 75,
    appliesTo: ["15m", "1h", "4h", "1d"],
    cooldownBars: 0,
    requiresPrior: 0,
  },
  {
    name: "fng-extreme-fear",
    direction: "bullish",
    strength: 0.3,
    when: (s) => s.fearGreed !== null && s.fearGreed < 25,
    appliesTo: ["15m", "1h", "4h", "1d"],
    cooldownBars: 0,
    requiresPrior: 0,
  },
];
