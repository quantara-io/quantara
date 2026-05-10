/**
 * Templated reasoning generator for Signals v2 Phase 2 (#253).
 *
 * Produces a human-readable `reasoning` string from a list of fired rule names
 * and an optional gate reason. Populated on every emission — including holds.
 *
 * Design: §4 of SIGNALS_AND_RISK.md — RFC open question #1 (holds get text too).
 */

/** Short human-readable label for each known rule name. */
const SHORT_LABEL: Record<string, string> = {
  "rsi-oversold-strong": "RSI extreme oversold",
  "rsi-oversold": "RSI oversold",
  "rsi-overbought-strong": "RSI extreme overbought",
  "rsi-overbought": "RSI overbought",
  "ema-stack-bull": "EMA stack bullish",
  "ema-stack-bear": "EMA stack bearish",
  "macd-cross-bull": "MACD cross up",
  "macd-cross-bear": "MACD cross down",
  "bollinger-touch-lower": "BB lower band",
  "bollinger-touch-upper": "BB upper band",
  "volume-spike-bull": "volume spike (up)",
  "volume-spike-bear": "volume spike (down)",
  "fng-extreme-fear": "extreme fear",
  "fng-extreme-greed": "extreme greed",
};

/**
 * Generate a templated `reasoning` string.
 *
 * @param rulesFired  - Names of the rules that fired (after group-max selection).
 * @param gateReason  - Gate reason from evaluateGates, or null if no gate fired.
 * @param options     - Optional fields for below-threshold hold context.
 * @param options.bullishScore - Raw bullish score (for below-threshold hold text).
 * @param options.bearishScore - Raw bearish score (for below-threshold hold text).
 * @returns Human-readable reasoning string, never empty.
 */
export function explainRules(
  rulesFired: string[],
  gateReason: string | null,
  options?: { bullishScore?: number; bearishScore?: number },
): string {
  // Gate takes priority: signal was suppressed, not directional.
  if (gateReason) return `Gated: ${gateReason}`;

  // No rules fired at all.
  if (rulesFired.length === 0) {
    // If scores are provided but below threshold, give the numeric context.
    if (options?.bullishScore !== undefined && options?.bearishScore !== undefined) {
      const bull = options.bullishScore.toFixed(1);
      const bear = options.bearishScore.toFixed(1);
      if (options.bullishScore > 0 || options.bearishScore > 0) {
        return `Below threshold — bull ${bull} / bear ${bear}`;
      }
    }
    return "No rules fired";
  }

  // Below-threshold hold with rules: use the score context.
  if (
    options?.bullishScore !== undefined &&
    options?.bearishScore !== undefined &&
    rulesFired.length > 0
  ) {
    const bull = options.bullishScore.toFixed(1);
    const bear = options.bearishScore.toFixed(1);
    // Only show the "below threshold" prefix when scores don't reach MIN_CONFLUENCE
    // The caller decides whether to pass scores — if scores are passed, assume hold context.
    const firstLabel = SHORT_LABEL[rulesFired[0]] ?? rulesFired[0];
    if (rulesFired.length === 1) {
      return `Below threshold — bull ${bull} / bear ${bear} (${firstLabel})`;
    }
    return `Below threshold — bull ${bull} / bear ${bear}`;
  }

  // Directional signal: format based on rule count.
  if (rulesFired.length === 1) {
    return SHORT_LABEL[rulesFired[0]] ?? rulesFired[0];
  }

  if (rulesFired.length === 2) {
    const a = SHORT_LABEL[rulesFired[0]] ?? rulesFired[0];
    const b = SHORT_LABEL[rulesFired[1]] ?? rulesFired[1];
    return `${a} + ${b}`;
  }

  // 3+ rules: confluence format.
  const count = rulesFired.length;
  const labels = rulesFired
    .slice(0, 3)
    .map((r) => SHORT_LABEL[r] ?? r)
    .join(", ");
  return `Confluence: ${count} rules (${labels}…)`;
}
