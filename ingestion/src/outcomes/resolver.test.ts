/**
 * resolver.test.ts — Phase 8.
 *
 * Golden-fixture tests for resolveOutcome (§10.3).
 *
 * Covers:
 *   - buy / sell / hold scoring against threshold and 2×threshold
 *   - gate-driven hold always neutral
 *   - invalidated signals excluded (outcome="neutral", invalidatedExcluded=true)
 *   - no mutation of input signal
 */

import { describe, it, expect } from "vitest";
import { resolveOutcome } from "./resolver.js";
import type { BlendedSignalRecord } from "./resolver.js";

const NOW_ISO = "2026-01-01T12:00:00.000Z";

function makeSignal(overrides: Partial<BlendedSignalRecord> = {}): BlendedSignalRecord {
  return {
    signalId: "sig-001",
    pair: "BTC",
    type: "buy",
    confidence: 0.75,
    createdAt: "2026-01-01T11:00:00.000Z",
    expiresAt: "2026-01-01T12:00:00.000Z",
    priceAtSignal: 100_000,
    atrPctAtSignal: 0.04, // 4% ATR → threshold = 0.02 (2%)
    gateReason: null,
    rulesFired: ["rsi_oversold", "macd_cross"],
    emittingTimeframe: "1h",
    invalidatedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Buy signal scoring
// ---------------------------------------------------------------------------

describe("resolveOutcome — buy", () => {
  // atrPct=0.04 → threshold=0.02

  it("buy: priceMove > threshold → correct", () => {
    const signal = makeSignal({ type: "buy" });
    // price up 3% (> 2%)
    const result = resolveOutcome(signal, 103_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("correct");
    expect(result.priceMovePct).toBeCloseTo(0.03);
    expect(result.thresholdUsed).toBeCloseTo(0.02);
  });

  it("buy: priceMove < -threshold → incorrect", () => {
    const signal = makeSignal({ type: "buy" });
    // price down 3%
    const result = resolveOutcome(signal, 97_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("incorrect");
  });

  it("buy: priceMove between -threshold and +threshold → neutral", () => {
    const signal = makeSignal({ type: "buy" });
    // price up 1% (< 2%)
    const result = resolveOutcome(signal, 101_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// Sell signal scoring
// ---------------------------------------------------------------------------

describe("resolveOutcome — sell", () => {
  it("sell: priceMove < -threshold → correct", () => {
    const signal = makeSignal({ type: "sell" });
    // price down 3%
    const result = resolveOutcome(signal, 97_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("correct");
  });

  it("sell: priceMove > threshold → incorrect", () => {
    const signal = makeSignal({ type: "sell" });
    // price up 3%
    const result = resolveOutcome(signal, 103_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("incorrect");
  });

  it("sell: priceMove between -threshold and +threshold → neutral", () => {
    const signal = makeSignal({ type: "sell" });
    // price down 1%
    const result = resolveOutcome(signal, 99_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// Hold signal scoring
// ---------------------------------------------------------------------------

describe("resolveOutcome — hold (no gate)", () => {
  // atrPct=0.04 → threshold=0.02 → 2×threshold=0.04

  it("hold: |priceMove| < threshold → correct", () => {
    const signal = makeSignal({ type: "hold", gateReason: null });
    // price up 1% (< 2%)
    const result = resolveOutcome(signal, 101_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("correct");
  });

  it("hold: |priceMove| > 2×threshold → incorrect", () => {
    const signal = makeSignal({ type: "hold", gateReason: null });
    // price up 5% (> 4%)
    const result = resolveOutcome(signal, 105_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("incorrect");
  });

  it("hold: |priceMove| between threshold and 2×threshold → neutral", () => {
    const signal = makeSignal({ type: "hold", gateReason: null });
    // price up 3% (between 2% and 4%)
    const result = resolveOutcome(signal, 103_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("neutral");
  });

  it("hold: negative move — |priceMove| < threshold → correct", () => {
    const signal = makeSignal({ type: "hold", gateReason: null });
    // price down 1%
    const result = resolveOutcome(signal, 99_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("correct");
  });

  it("hold: negative move — |priceMove| > 2×threshold → incorrect", () => {
    const signal = makeSignal({ type: "hold", gateReason: null });
    // price down 5%
    const result = resolveOutcome(signal, 95_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("incorrect");
  });
});

// ---------------------------------------------------------------------------
// Gate-driven hold — always neutral
// ---------------------------------------------------------------------------

describe("resolveOutcome — gate-driven hold", () => {
  it("vol gate: always neutral regardless of price move", () => {
    const signal = makeSignal({ type: "hold", gateReason: "vol" });
    // price up 10% (would be incorrect for hold without gate)
    const result = resolveOutcome(signal, 110_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("neutral");
    expect(result.gateReason).toBe("vol");
  });

  it("dispersion gate: always neutral", () => {
    const signal = makeSignal({ type: "hold", gateReason: "dispersion" });
    const result = resolveOutcome(signal, 95_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("neutral");
  });

  it("stale gate: always neutral", () => {
    const signal = makeSignal({ type: "hold", gateReason: "stale" });
    const result = resolveOutcome(signal, 95_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("neutral");
  });

  it("gate on buy signal: always neutral (gate overrides direction)", () => {
    const signal = makeSignal({ type: "buy", gateReason: "vol" });
    // price up 10% — would be correct for buy, but gate forces neutral
    const result = resolveOutcome(signal, 110_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// Invalidated signals — excluded
// ---------------------------------------------------------------------------

describe("resolveOutcome — invalidated", () => {
  it("invalidated signal: excluded, outcome=neutral, invalidatedExcluded=true", () => {
    const signal = makeSignal({ invalidatedAt: "2026-01-01T11:30:00.000Z" });
    const result = resolveOutcome(signal, 110_000, 0.04, NOW_ISO);
    expect(result.outcome).toBe("neutral");
    expect(result.invalidatedExcluded).toBe(true);
    expect(result.priceMovePct).toBe(0); // not computed for excluded
  });
});

// ---------------------------------------------------------------------------
// Immutability — no mutation of input
// ---------------------------------------------------------------------------

describe("resolveOutcome — immutability", () => {
  it("does not mutate the input signal", () => {
    const signal = makeSignal();
    const frozen = Object.freeze({ ...signal });
    // Should not throw (no mutation attempted).
    expect(() => resolveOutcome(signal, 103_000, 0.04, NOW_ISO)).not.toThrow();
    // Original signal unchanged.
    expect(signal.signalId).toBe("sig-001");
    expect(signal.confidence).toBe(0.75);
    void frozen; // used
  });
});

// ---------------------------------------------------------------------------
// Output fields validation
// ---------------------------------------------------------------------------

describe("resolveOutcome — output fields", () => {
  it("populates all required fields correctly", () => {
    const signal = makeSignal({ type: "buy" });
    const result = resolveOutcome(signal, 103_000, 0.04, NOW_ISO);

    expect(result.signalId).toBe("sig-001");
    expect(result.pair).toBe("BTC");
    expect(result.type).toBe("buy");
    expect(result.confidence).toBe(0.75);
    expect(result.resolvedAt).toBe(NOW_ISO);
    expect(result.priceAtSignal).toBe(100_000);
    expect(result.priceAtResolution).toBe(103_000);
    expect(result.atrPctAtSignal).toBe(0.04);
    expect(result.thresholdUsed).toBeCloseTo(0.02);
    expect(result.rulesFired).toEqual(["rsi_oversold", "macd_cross"]);
    expect(result.invalidatedExcluded).toBe(false);
    expect(typeof result.ttl).toBe("number");
    expect(result.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
