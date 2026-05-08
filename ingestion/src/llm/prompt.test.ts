/**
 * Tests for prompt.ts — system prompt, user message builder, response parser.
 *
 * Pure functions only — no AWS or Anthropic SDK mocks needed.
 */

import { describe, it, expect } from "vitest";
import {
  SYSTEM_PROMPT,
  buildUserMessage,
  parseRatificationResponse,
  SYSTEM_HASH,
  hashUserMessage,
} from "./prompt.js";
import type { RatifyContext } from "./ratify.js";
import type { BlendedSignal } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<BlendedSignal> = {}): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "buy",
    confidence: 0.75,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: ["ema_cross_bullish", "rsi_oversold"],
    perTimeframe: {
      "1m": null, "5m": null, "15m": null, "1h": null, "4h": null, "1d": null,
    },
    weightsUsed: {
      "1m": 0, "5m": 0, "15m": 0.15, "1h": 0.2, "4h": 0.3, "1d": 0.35,
    },
    asOf: 1700000000000,
    emittingTimeframe: "4h",
    risk: null,
    ...overrides,
  };
}

function makeContext(candidateOverrides: Partial<BlendedSignal> = {}): RatifyContext {
  const candidate = makeCandidate(candidateOverrides);
  return {
    pair: "BTC/USDT",
    candidate,
    perTimeframe: candidate.perTimeframe,
    sentiment: {
      pair: "BTC/USDT",
      assembledAt: new Date().toISOString(),
      windows: {
        "4h": {
          pair: "BTC/USDT",
          window: "4h",
          computedAt: new Date().toISOString(),
          articleCount: 3,
          meanScore: 0.6,
          meanMagnitude: 0.4,
          fearGreedTrend24h: 5,
          fearGreedLatest: 65,
        },
        "24h": {
          pair: "BTC/USDT",
          window: "24h",
          computedAt: new Date().toISOString(),
          articleCount: 10,
          meanScore: 0.55,
          meanMagnitude: 0.38,
          fearGreedTrend24h: 5,
          fearGreedLatest: 65,
        },
      },
      fearGreed: {
        value: 65,
        classification: "Greed",
        lastTimestamp: new Date().toISOString(),
        history: [],
        trend24h: 5,
      },
    },
    whaleSummary: null,
    pricePoints: [
      { exchange: "binance", price: 42000, volume24h: 12000000, timestamp: new Date().toISOString(), stale: false },
    ],
    fearGreed: { value: 65, trend24h: 5 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SYSTEM_PROMPT", () => {
  it("contains the downgrade-only contract language", () => {
    expect(SYSTEM_PROMPT).toContain("YOU MAY NOT");
    expect(SYSTEM_PROMPT).toContain("YOU MAY:");
    expect(SYSTEM_PROMPT).toContain("hold");
    expect(SYSTEM_PROMPT).toContain("buy");
    expect(SYSTEM_PROMPT).toContain("sell");
  });

  it("SYSTEM_HASH is a 64-char hex string", () => {
    expect(SYSTEM_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildUserMessage", () => {
  it("produces valid JSON", () => {
    const ctx = makeContext();
    const msg = buildUserMessage(ctx);
    expect(() => JSON.parse(msg)).not.toThrow();
  });

  it("includes the pair, candidate type and confidence", () => {
    const ctx = makeContext();
    const parsed = JSON.parse(buildUserMessage(ctx)) as Record<string, unknown>;
    expect(parsed.pair).toBe("BTC/USDT");
    const cand = parsed.candidate as Record<string, unknown>;
    expect(cand.type).toBe("buy");
    expect(cand.confidence).toBe(0.75);
  });

  it("uses null for whaleSummary when absent", () => {
    const ctx = makeContext();
    const parsed = JSON.parse(buildUserMessage(ctx)) as Record<string, unknown>;
    expect(parsed.whaleSummary).toBeNull();
  });
});

describe("parseRatificationResponse", () => {
  const validResponse = {
    type: "hold" as const,
    confidence: 0.5,
    reasoning: "The market is uncertain due to elevated fear and greed index near 65.",
    downgraded: true,
    downgradeReason: "FNG elevated",
  };

  it("accepts a valid response", () => {
    const result = parseRatificationResponse(validResponse);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("hold");
    expect(result?.confidence).toBe(0.5);
  });

  it("rejects invalid type", () => {
    expect(parseRatificationResponse({ ...validResponse, type: "sideways" })).toBeNull();
  });

  it("rejects non-number confidence", () => {
    expect(parseRatificationResponse({ ...validResponse, confidence: "0.5" })).toBeNull();
  });

  it("rejects confidence < 0", () => {
    expect(parseRatificationResponse({ ...validResponse, confidence: -0.1 })).toBeNull();
  });

  it("rejects confidence > 1", () => {
    expect(parseRatificationResponse({ ...validResponse, confidence: 1.1 })).toBeNull();
  });

  it("rejects reasoning too short (< 20 chars)", () => {
    expect(parseRatificationResponse({ ...validResponse, reasoning: "short" })).toBeNull();
  });

  it("rejects reasoning too long (> 600 chars)", () => {
    expect(parseRatificationResponse({ ...validResponse, reasoning: "x".repeat(601) })).toBeNull();
  });

  it("rejects non-boolean downgraded", () => {
    expect(parseRatificationResponse({ ...validResponse, downgraded: "true" })).toBeNull();
  });

  it("accepts null downgradeReason", () => {
    const result = parseRatificationResponse({ ...validResponse, downgradeReason: null });
    expect(result?.downgradeReason).toBeNull();
  });

  it("accepts all three valid types", () => {
    for (const type of ["buy", "sell", "hold"] as const) {
      const r = parseRatificationResponse({ ...validResponse, type });
      expect(r?.type).toBe(type);
    }
  });

  it("returns null for null input", () => {
    expect(parseRatificationResponse(null)).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(parseRatificationResponse("string")).toBeNull();
    expect(parseRatificationResponse(42)).toBeNull();
  });
});

describe("hashUserMessage", () => {
  it("returns a 64-char hex string", () => {
    expect(hashUserMessage("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashUserMessage("abc")).toBe(hashUserMessage("abc"));
  });

  it("differs for different inputs", () => {
    expect(hashUserMessage("abc")).not.toBe(hashUserMessage("xyz"));
  });
});
