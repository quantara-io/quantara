/**
 * Tests for validate.ts — every row of the §7.4 transformation table.
 *
 * Pure functions only — no mocks needed.
 */

import { describe, it, expect } from "vitest";
import { validateRatification } from "./validate.js";
import type { BlendedSignal } from "@quantara/shared";
import type { RatificationResponse } from "./prompt.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<BlendedSignal> = {}): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "buy",
    confidence: 0.8,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: [],
    perTimeframe: {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
    },
    weightsUsed: {
      "1m": 0,
      "5m": 0,
      "15m": 0.15,
      "1h": 0.2,
      "4h": 0.3,
      "1d": 0.35,
    },
    asOf: 1700000000000,
    emittingTimeframe: "4h",
    risk: null,
    ...overrides,
  };
}

function makeLlmResponse(overrides: Partial<RatificationResponse> = {}): RatificationResponse {
  return {
    type: "buy",
    confidence: 0.7,
    reasoning: "Bullish momentum confirmed by EMA cross and RSI recovery above 30.",
    downgraded: true,
    downgradeReason: "slight confidence reduction",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("validateRatification — happy paths", () => {
  it("buy → buy with lower confidence: ok", () => {
    const result = validateRatification(
      makeCandidate({ type: "buy", confidence: 0.8 }),
      makeLlmResponse({ type: "buy", confidence: 0.7 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ratified.confidence).toBe(0.7);
  });

  it("buy → hold: ok (widening to hold)", () => {
    const result = validateRatification(
      makeCandidate({ type: "buy" }),
      makeLlmResponse({ type: "hold", confidence: 0.5 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ratified.type).toBe("hold");
  });

  it("sell → hold: ok (widening to hold)", () => {
    const result = validateRatification(
      makeCandidate({ type: "sell" }),
      makeLlmResponse({ type: "hold", confidence: 0.5 }),
    );
    expect(result.ok).toBe(true);
  });

  it("hold → hold: ok (no change)", () => {
    const result = validateRatification(
      makeCandidate({ type: "hold", confidence: 0.5 }),
      makeLlmResponse({ type: "hold", confidence: 0.5 }),
    );
    expect(result.ok).toBe(true);
  });

  it("sell → sell with lower confidence: ok", () => {
    const result = validateRatification(
      makeCandidate({ type: "sell", confidence: 0.9 }),
      makeLlmResponse({ type: "sell", confidence: 0.6 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ratified.type).toBe("sell");
  });

  it("preserves other candidate fields on ratified signal", () => {
    const candidate = makeCandidate({ type: "buy", confidence: 0.8, rulesFired: ["ema_cross"] });
    const result = validateRatification(
      candidate,
      makeLlmResponse({ type: "buy", confidence: 0.6 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ratified.rulesFired).toEqual(["ema_cross"]);
      expect(result.ratified.pair).toBe("BTC/USDT");
    }
  });

  it("exact same confidence as candidate: ok", () => {
    const result = validateRatification(
      makeCandidate({ confidence: 0.75 }),
      makeLlmResponse({ confidence: 0.75 }),
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Forbidden transformations (§7.4 table)
// ---------------------------------------------------------------------------

describe("validateRatification — forbidden type transformations", () => {
  it("hold → buy: forbidden", () => {
    const result = validateRatification(
      makeCandidate({ type: "hold" }),
      makeLlmResponse({ type: "buy" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/hold.*non-hold/);
  });

  it("hold → sell: forbidden", () => {
    const result = validateRatification(
      makeCandidate({ type: "hold" }),
      makeLlmResponse({ type: "sell" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/hold.*non-hold/);
  });

  it("buy → sell: forbidden (sign flip)", () => {
    const result = validateRatification(
      makeCandidate({ type: "buy" }),
      makeLlmResponse({ type: "sell" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/sign flip/);
  });

  it("sell → buy: forbidden (sign flip)", () => {
    const result = validateRatification(
      makeCandidate({ type: "sell" }),
      makeLlmResponse({ type: "buy" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/sign flip/);
  });
});

// ---------------------------------------------------------------------------
// Confidence increase forbidden
// ---------------------------------------------------------------------------

describe("validateRatification — confidence increase forbidden", () => {
  it("confidence increase rejected (exact over)", () => {
    const result = validateRatification(
      makeCandidate({ confidence: 0.7 }),
      makeLlmResponse({ confidence: 0.8 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/confidence increase/);
  });

  it("confidence increase by tiny epsilon rejected", () => {
    const result = validateRatification(
      makeCandidate({ confidence: 0.7 }),
      makeLlmResponse({ confidence: 0.7 + 1e-5 }),
    );
    expect(result.ok).toBe(false);
  });

  it("confidence within epsilon (1e-7 over): ok — floating point tolerance", () => {
    // 1e-7 is within the 1e-6 tolerance
    const result = validateRatification(
      makeCandidate({ confidence: 0.7 }),
      makeLlmResponse({ confidence: 0.7 + 1e-7 }),
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema bounds
// ---------------------------------------------------------------------------

describe("validateRatification — schema bounds", () => {
  it("confidence < 0: rejected", () => {
    const result = validateRatification(
      makeCandidate({ confidence: 0 }),
      makeLlmResponse({ confidence: -0.01 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/\[0,1\]/);
  });

  it("confidence > 1: rejected (and would be increase)", () => {
    const result = validateRatification(
      makeCandidate({ confidence: 1.0 }),
      makeLlmResponse({ confidence: 1.01 }),
    );
    expect(result.ok).toBe(false);
  });

  it("reasoning too short: rejected", () => {
    const result = validateRatification(makeCandidate(), makeLlmResponse({ reasoning: "short" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/reasoning/);
  });

  it("reasoning too long: rejected", () => {
    const result = validateRatification(
      makeCandidate(),
      makeLlmResponse({ reasoning: "x".repeat(601) }),
    );
    expect(result.ok).toBe(false);
  });

  it("reasoning at exactly 20 chars: ok", () => {
    const result = validateRatification(
      makeCandidate(),
      makeLlmResponse({ reasoning: "x".repeat(20) }),
    );
    expect(result.ok).toBe(true);
  });

  it("reasoning at exactly 600 chars: ok", () => {
    const result = validateRatification(
      makeCandidate(),
      makeLlmResponse({ reasoning: "x".repeat(600) }),
    );
    expect(result.ok).toBe(true);
  });
});
