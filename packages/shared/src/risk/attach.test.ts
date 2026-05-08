/**
 * Tests for attachRiskRecommendation — Phase 7 (revised) #77
 *
 * Covers:
 *   - Hold signals get risk: null without calling computeRiskRecommendation
 *   - Buy/sell signals get risk computed and attached
 *   - Input BlendedSignal is not mutated
 *   - Profile looked up from riskProfiles map
 *   - KellyStats passed through correctly
 */

import { describe, it, expect, vi } from "vitest";
import type { BlendedSignal, IndicatorState, RiskProfileMap, KellyStats } from "@quantara/shared";

// Mock computeRiskRecommendation so we can assert call arguments without
// depending on indicator math in the attach unit tests.
vi.mock("./recommend.js", () => ({
  computeRiskRecommendation: vi.fn(),
}));

// Import after mock setup
import { attachRiskRecommendation } from "./attach.js";
import { computeRiskRecommendation } from "./recommend.js";

const computeMock = vi.mocked(computeRiskRecommendation);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<BlendedSignal> = {}): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "buy",
    confidence: 0.72,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: ["ema_cross_bullish"],
    perTimeframe: {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
    },
    weightsUsed: { "1m": 0, "5m": 0, "15m": 0.15, "1h": 0.2, "4h": 0.3, "1d": 0.35 },
    asOf: 1700000000000,
    emittingTimeframe: "1h",
    risk: null,
    ...overrides,
  };
}

function makeState(pair = "BTC/USDT"): IndicatorState {
  return {
    pair,
    exchange: "consensus",
    timeframe: "1h",
    asOf: 1700000000000,
    barsSinceStart: 200,
    rsi14: 55,
    ema20: 46000,
    ema50: 45000,
    ema200: 44000,
    macdLine: 100,
    macdSignal: 80,
    macdHist: 20,
    atr14: 500,
    bbUpper: 47500,
    bbMid: 46000,
    bbLower: 44500,
    bbWidth: 0.065,
    obv: 100000,
    obvSlope: 500,
    vwap: 46000,
    volZ: 1.2,
    realizedVolAnnualized: 0.6,
    fearGreed: 55,
    dispersion: 0.001,
    history: {
      rsi14: [52, 53, 54, 55, 55],
      macdHist: [15, 17, 19, 20, 20],
      ema20: [45800, 45900, 46000, 46000, 46000],
      ema50: [44900, 45000, 45000, 45000, 45000],
      close: [45800, 45900, 46000, 46100, 46200],
      volume: [1000, 1100, 1050, 1200, 1150],
    },
  };
}

const defaultProfiles: RiskProfileMap = {
  "BTC/USDT": "moderate",
  "ETH/USDT": "conservative",
  "SOL/USDT": "aggressive",
  "XRP/USDT": "moderate",
  "DOGE/USDT": "conservative",
};

// ---------------------------------------------------------------------------
// Hold signals
// ---------------------------------------------------------------------------

describe("attachRiskRecommendation — hold signals", () => {
  it("sets risk: null for hold signals without calling computeRiskRecommendation", () => {
    computeMock.mockReset();
    const signal = makeSignal({ type: "hold" });
    const state = makeState();
    const result = attachRiskRecommendation(signal, state, defaultProfiles);
    expect(result.risk).toBeNull();
    expect(computeMock).not.toHaveBeenCalled();
  });

  it("returns a new object (does not mutate the input) for hold signals", () => {
    const signal = makeSignal({ type: "hold" });
    const state = makeState();
    const result = attachRiskRecommendation(signal, state, defaultProfiles);
    expect(result).not.toBe(signal);
    expect(signal.risk).toBeNull(); // original unchanged
  });
});

// ---------------------------------------------------------------------------
// Buy/sell signals
// ---------------------------------------------------------------------------

describe("attachRiskRecommendation — buy/sell signals", () => {
  it("calls computeRiskRecommendation with the correct profile from riskProfiles", () => {
    computeMock.mockReset();
    const fakeRec = {
      pair: "BTC/USDT",
      profile: "moderate" as const,
      positionSizePct: 0.5,
      positionSizeModel: "vol-targeted" as const,
      stopLoss: 45000,
      stopDistance: 1000,
      takeProfit: [],
      invalidationCondition: "Setup invalid if BTC/USDT crosses below $45000.00",
      trailingStopAfterTP2: { multiplier: 2, reference: "ATR" as const },
    };
    computeMock.mockReturnValue(fakeRec);

    const signal = makeSignal({ type: "buy", pair: "BTC/USDT" });
    const state = makeState("BTC/USDT");
    const result = attachRiskRecommendation(signal, state, defaultProfiles);

    expect(computeMock).toHaveBeenCalledOnce();
    const [calledSignal, calledState, calledProfile, calledKelly] = computeMock.mock.calls[0];
    expect(calledSignal.pair).toBe("BTC/USDT");
    expect(calledState.pair).toBe("BTC/USDT");
    expect(calledProfile).toBe("moderate"); // from defaultProfiles["BTC/USDT"]
    expect(calledKelly).toBeUndefined();
    expect(result.risk).toEqual(fakeRec);
  });

  it("passes the correct Kelly stats when provided", () => {
    computeMock.mockReset();
    computeMock.mockReturnValue(null);

    const signal = makeSignal({ type: "sell", pair: "ETH/USDT" });
    const state = makeState("ETH/USDT");
    const kellyStats: KellyStats = {
      pair: "ETH/USDT",
      timeframe: "1h",
      direction: "sell",
      resolved: 55,
      p: 0.52,
      b: 1.2,
    };
    const kellyByPair = { "ETH/USDT": kellyStats };
    attachRiskRecommendation(signal, state, defaultProfiles, kellyByPair);

    const [, , , calledKelly] = computeMock.mock.calls[0];
    expect(calledKelly).toEqual(kellyStats);
  });

  it("passes undefined Kelly when pair not present in kellyByPair", () => {
    computeMock.mockReset();
    computeMock.mockReturnValue(null);

    const signal = makeSignal({ type: "buy", pair: "SOL/USDT" });
    const state = makeState("SOL/USDT");
    attachRiskRecommendation(signal, state, defaultProfiles, {});

    const [, , , calledKelly] = computeMock.mock.calls[0];
    expect(calledKelly).toBeUndefined();
  });

  it("sets risk: null when computeRiskRecommendation returns null (zero-size suppression)", () => {
    computeMock.mockReset();
    computeMock.mockReturnValue(null);

    const signal = makeSignal({ type: "buy" });
    const state = makeState();
    const result = attachRiskRecommendation(signal, state, defaultProfiles);
    expect(result.risk).toBeNull();
  });

  it("does not mutate the original signal", () => {
    computeMock.mockReset();
    computeMock.mockReturnValue(null);

    const signal = makeSignal({ type: "buy", risk: null });
    const originalPair = signal.pair;
    const state = makeState();
    const result = attachRiskRecommendation(signal, state, defaultProfiles);

    expect(result).not.toBe(signal);
    expect(signal.pair).toBe(originalPair);
    // Original risk field is unchanged
    expect(signal.risk).toBeNull();
  });

  it("looks up correct per-pair profile (ETH/USDT → conservative)", () => {
    computeMock.mockReset();
    computeMock.mockReturnValue(null);

    const signal = makeSignal({ type: "buy", pair: "ETH/USDT" });
    const state = makeState("ETH/USDT");
    attachRiskRecommendation(signal, state, defaultProfiles);

    const [, , calledProfile] = computeMock.mock.calls[0];
    expect(calledProfile).toBe("conservative");
  });
});
