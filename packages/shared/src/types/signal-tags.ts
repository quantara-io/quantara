/**
 * Signal tag type definitions — Signals v2 Phase 2 (#253).
 *
 * Extracted into a standalone module to avoid circular dependency between
 * types/signals.ts (which imports from rules.ts) and types/rules.ts (which
 * needs SignalTag for TimeframeVote.tags).
 */

export const SIGNAL_TAGS = [
  "bull-div",
  "bear-div",
  "rsi-oversold-watch",
  "rsi-overbought-watch",
  "breakout-up",
  "breakout-down",
  "volume-spike-bull",
  "volume-spike-bear",
] as const;

export type SignalTag = (typeof SIGNAL_TAGS)[number];
