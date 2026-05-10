/**
 * Unit tests for the templated reasoning function (v2 Phase 2 #253).
 *
 * Covers:
 *   - 0 rules fired → "No rules fired"
 *   - 0 rules fired with scores (below threshold) → "Below threshold — bull X / bear Y"
 *   - 1 rule fired → SHORT_LABEL or fallback to rule name
 *   - 2 rules fired → "A + B"
 *   - 3+ rules fired → "Confluence: N rules (A, B, C…)"
 *   - Gate reason → "Gated: <reason>"
 *   - Unknown rule names → use rule name directly
 */

import { describe, it, expect } from "vitest";
import { explainRules } from "@quantara/shared";

describe("explainRules — Phase 2 (#253)", () => {
  // ---------------------------------------------------------------------------
  // Gate path
  // ---------------------------------------------------------------------------

  it("gateReason overrides everything — returns 'Gated: <reason>'", () => {
    expect(explainRules([], "vol")).toBe("Gated: vol");
    expect(explainRules(["rsi-oversold"], "dispersion")).toBe("Gated: dispersion");
    expect(explainRules(["rsi-oversold", "macd-cross-bull"], "stale")).toBe("Gated: stale");
  });

  // ---------------------------------------------------------------------------
  // 0 rules fired
  // ---------------------------------------------------------------------------

  it("0 rules, no scores → 'No rules fired'", () => {
    expect(explainRules([], null)).toBe("No rules fired");
  });

  it("0 rules, scores both zero → 'No rules fired' (not 'Below threshold')", () => {
    expect(explainRules([], null, { bullishScore: 0, bearishScore: 0 })).toBe("No rules fired");
  });

  it("0 rules, positive bull score → below-threshold text with bull/bear numbers", () => {
    const result = explainRules([], null, { bullishScore: 1.4, bearishScore: 0.0 });
    expect(result).toContain("Below threshold");
    expect(result).toContain("1.4");
    expect(result).toContain("0.0");
  });

  it("0 rules, positive bear score → below-threshold text", () => {
    const result = explainRules([], null, { bullishScore: 0.0, bearishScore: 1.3 });
    expect(result).toContain("Below threshold");
    expect(result).toContain("0.0");
    expect(result).toContain("1.3");
  });

  // ---------------------------------------------------------------------------
  // 1 rule fired
  // ---------------------------------------------------------------------------

  it("1 rule → SHORT_LABEL for known rules", () => {
    expect(explainRules(["rsi-oversold"], null)).toBe("RSI oversold");
    expect(explainRules(["rsi-oversold-strong"], null)).toBe("RSI extreme oversold");
    expect(explainRules(["rsi-overbought"], null)).toBe("RSI overbought");
    expect(explainRules(["rsi-overbought-strong"], null)).toBe("RSI extreme overbought");
    expect(explainRules(["ema-stack-bull"], null)).toBe("EMA stack bullish");
    expect(explainRules(["ema-stack-bear"], null)).toBe("EMA stack bearish");
    expect(explainRules(["macd-cross-bull"], null)).toBe("MACD cross up");
    expect(explainRules(["macd-cross-bear"], null)).toBe("MACD cross down");
    expect(explainRules(["bollinger-touch-lower"], null)).toBe("BB lower band");
    expect(explainRules(["bollinger-touch-upper"], null)).toBe("BB upper band");
    expect(explainRules(["volume-spike-bull"], null)).toBe("volume spike (up)");
    expect(explainRules(["volume-spike-bear"], null)).toBe("volume spike (down)");
    expect(explainRules(["fng-extreme-fear"], null)).toBe("extreme fear");
    expect(explainRules(["fng-extreme-greed"], null)).toBe("extreme greed");
  });

  it("1 rule → unknown rule name falls back to rule name itself", () => {
    expect(explainRules(["unknown-custom-rule"], null)).toBe("unknown-custom-rule");
  });

  // ---------------------------------------------------------------------------
  // 2 rules fired
  // ---------------------------------------------------------------------------

  it("2 rules → 'A + B' format", () => {
    expect(explainRules(["rsi-oversold", "macd-cross-bull"], null)).toBe(
      "RSI oversold + MACD cross up",
    );
    expect(explainRules(["ema-stack-bull", "volume-spike-bull"], null)).toBe(
      "EMA stack bullish + volume spike (up)",
    );
  });

  it("2 rules, one unknown → uses unknown name directly", () => {
    expect(explainRules(["rsi-oversold", "custom-alpha-rule"], null)).toBe(
      "RSI oversold + custom-alpha-rule",
    );
  });

  // ---------------------------------------------------------------------------
  // 3+ rules fired → Confluence format
  // ---------------------------------------------------------------------------

  it("3 rules → 'Confluence: 3 rules (A, B, C…)'", () => {
    const result = explainRules(["rsi-oversold", "macd-cross-bull", "ema-stack-bull"], null);
    expect(result).toMatch(/^Confluence: 3 rules/);
    expect(result).toContain("RSI oversold");
    expect(result).toContain("MACD cross up");
    expect(result).toContain("EMA stack bullish");
    expect(result).toContain("…");
  });

  it("4 rules → 'Confluence: 4 rules (A, B, C…)' — only first 3 labels shown", () => {
    const result = explainRules(
      ["rsi-oversold", "macd-cross-bull", "ema-stack-bull", "volume-spike-bull"],
      null,
    );
    expect(result).toMatch(/^Confluence: 4 rules/);
    expect(result).toContain("RSI oversold");
    expect(result).toContain("MACD cross up");
    expect(result).toContain("EMA stack bullish");
    // 4th rule (volume spike) is truncated
    expect(result).not.toContain("volume spike (up)");
  });

  it("3 rules — hold context (scores passed) still uses confluence format for directional signal", () => {
    // When scores are NOT passed (no options), 3 rules → confluence format
    const result = explainRules(["rsi-oversold", "macd-cross-bull", "ema-stack-bull"], null);
    expect(result).toMatch(/^Confluence: 3 rules/);
  });

  // ---------------------------------------------------------------------------
  // Gated hold — reasoning for different gate reasons
  // ---------------------------------------------------------------------------

  it("gated hold with 'vol' reason → 'Gated: vol'", () => {
    expect(explainRules([], "vol")).toBe("Gated: vol");
  });

  it("gated hold with 'dispersion' reason → 'Gated: dispersion'", () => {
    expect(explainRules([], "dispersion")).toBe("Gated: dispersion");
  });

  it("gated hold with 'stale' reason → 'Gated: stale'", () => {
    expect(explainRules([], "stale")).toBe("Gated: stale");
  });
});
