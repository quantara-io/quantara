/**
 * attribution.test.ts — Phase 8.
 *
 * Tests for buildRuleAttribution and getAffectedAttributionKeys.
 */

import { describe, it, expect } from "vitest";
import { buildRuleAttribution, getAffectedAttributionKeys } from "./attribution.js";
import type { OutcomeRecord } from "./resolver.js";

const NOW_ISO = "2026-01-01T12:00:00.000Z";

function makeOutcome(
  overrides: Partial<OutcomeRecord> = {},
  resolvedAt = NOW_ISO,
): OutcomeRecord {
  return {
    pair: "BTC",
    signalId: `sig-${Math.random().toString(36).slice(2, 8)}`,
    type: "buy",
    confidence: 0.7,
    createdAt: "2026-01-01T11:00:00.000Z",
    expiresAt: NOW_ISO,
    resolvedAt,
    priceAtSignal: 100_000,
    priceAtResolution: 103_000,
    priceMovePct: 0.03,
    atrPctAtSignal: 0.04,
    thresholdUsed: 0.02,
    outcome: "correct",
    rulesFired: ["rsi_oversold"],
    gateReason: null,
    emittingTimeframe: "1h",
    invalidatedExcluded: false,
    ttl: 9999999999,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildRuleAttribution
// ---------------------------------------------------------------------------

describe("buildRuleAttribution", () => {
  it("returns zeros when no outcomes match rule", () => {
    const outcomes = [makeOutcome({ rulesFired: ["other_rule"] })];
    const attr = buildRuleAttribution("rsi_oversold", "BTC", "1h", "30d", outcomes, NOW_ISO);
    expect(attr.fireCount).toBe(0);
    expect(attr.correctCount).toBe(0);
    expect(attr.contribution).toBeNull();
  });

  it("counts correct / incorrect / neutral for matching rule", () => {
    const outcomes = [
      makeOutcome({ outcome: "correct", rulesFired: ["rsi_oversold"] }),
      makeOutcome({ outcome: "correct", rulesFired: ["rsi_oversold"] }),
      makeOutcome({ outcome: "incorrect", rulesFired: ["rsi_oversold"] }),
      makeOutcome({ outcome: "neutral", rulesFired: ["rsi_oversold"] }),
    ];
    const attr = buildRuleAttribution("rsi_oversold", "BTC", "1h", "30d", outcomes, NOW_ISO);
    expect(attr.fireCount).toBe(4);
    expect(attr.correctCount).toBe(2);
    expect(attr.incorrectCount).toBe(1);
    expect(attr.neutralCount).toBe(1);
    expect(attr.contribution).toBeCloseTo(2 / 3); // 2 correct / (2+1) directional
  });

  it("contribution is null when all outcomes are neutral", () => {
    const outcomes = [
      makeOutcome({ outcome: "neutral", rulesFired: ["rsi_oversold"] }),
    ];
    const attr = buildRuleAttribution("rsi_oversold", "BTC", "1h", "30d", outcomes, NOW_ISO);
    expect(attr.contribution).toBeNull();
  });

  it("excludes invalidated outcomes", () => {
    const outcomes = [
      makeOutcome({ outcome: "correct", rulesFired: ["rsi_oversold"] }),
      makeOutcome({
        outcome: "neutral",
        rulesFired: ["rsi_oversold"],
        invalidatedExcluded: true,
      }),
    ];
    const attr = buildRuleAttribution("rsi_oversold", "BTC", "1h", "30d", outcomes, NOW_ISO);
    expect(attr.fireCount).toBe(1); // only the non-invalidated
  });

  it("filters by window — outcomes outside window not counted", () => {
    const oldIso = new Date(new Date(NOW_ISO).getTime() - 86400 * 100 * 1000).toISOString();
    const outcomes = [
      makeOutcome({ outcome: "correct", rulesFired: ["rsi_oversold"] }, oldIso),
      makeOutcome({ outcome: "correct", rulesFired: ["rsi_oversold"] }), // in 30d window
    ];
    const attr = buildRuleAttribution("rsi_oversold", "BTC", "1h", "30d", outcomes, NOW_ISO);
    expect(attr.fireCount).toBe(1);
    expect(attr.correctCount).toBe(1);
  });

  it("pk is formatted as 'rule#pair#timeframe'", () => {
    const attr = buildRuleAttribution("rsi_oversold", "ETH", "4h", "90d", [], NOW_ISO);
    expect(attr.pk).toBe("rsi_oversold#ETH#4h");
  });

  it("ttl is 7 days from computedAt", () => {
    const attr = buildRuleAttribution("rsi_oversold", "BTC", "1h", "30d", [], NOW_ISO);
    const expectedTtl = Math.floor(new Date(NOW_ISO).getTime() / 1000) + 86400 * 7;
    expect(attr.ttl).toBe(expectedTtl);
  });

  it("only counts outcomes where rule is in rulesFired", () => {
    const outcomes = [
      makeOutcome({ outcome: "correct", rulesFired: ["rsi_oversold", "macd_cross"] }),
      makeOutcome({ outcome: "incorrect", rulesFired: ["macd_cross"] }), // rsi_oversold not fired
    ];
    const attr = buildRuleAttribution("rsi_oversold", "BTC", "1h", "30d", outcomes, NOW_ISO);
    expect(attr.fireCount).toBe(1);
    expect(attr.correctCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getAffectedAttributionKeys
// ---------------------------------------------------------------------------

describe("getAffectedAttributionKeys", () => {
  it("returns empty set for no outcomes", () => {
    expect(getAffectedAttributionKeys([])).toEqual(new Set());
  });

  it("returns one key per unique rule#pair#timeframe", () => {
    const outcomes = [
      makeOutcome({ rulesFired: ["rsi_oversold"], pair: "BTC", emittingTimeframe: "1h" }),
      makeOutcome({ rulesFired: ["macd_cross"], pair: "BTC", emittingTimeframe: "1h" }),
    ];
    const keys = getAffectedAttributionKeys(outcomes);
    expect(keys).toContain("rsi_oversold#BTC#1h");
    expect(keys).toContain("macd_cross#BTC#1h");
  });

  it("deduplicates the same key across multiple outcomes", () => {
    const outcomes = [
      makeOutcome({ rulesFired: ["rsi_oversold"], pair: "BTC", emittingTimeframe: "1h" }),
      makeOutcome({ rulesFired: ["rsi_oversold"], pair: "BTC", emittingTimeframe: "1h" }),
    ];
    const keys = getAffectedAttributionKeys(outcomes);
    expect(keys.size).toBe(1);
    expect(keys).toContain("rsi_oversold#BTC#1h");
  });

  it("handles multiple rules per outcome", () => {
    const outcomes = [
      makeOutcome({
        rulesFired: ["rule_a", "rule_b"],
        pair: "ETH",
        emittingTimeframe: "4h",
      }),
    ];
    const keys = getAffectedAttributionKeys(outcomes);
    expect(keys).toContain("rule_a#ETH#4h");
    expect(keys).toContain("rule_b#ETH#4h");
    expect(keys.size).toBe(2);
  });
});
