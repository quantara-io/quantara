/**
 * Unit tests for the risk recommendation engine (Phase 7).
 *
 * Covers:
 *   - hold signal → null
 *   - conservative × buy/sell: fixed sizing, stop math, TPs [1,2,3]R
 *   - moderate × buy/sell: vol-targeted sizing, TPs [1,2,5]R
 *   - aggressive × buy/sell (no Kelly): vol-targeted sizing, TPs [1,3,8]R
 *   - aggressive × buy + Kelly unlocked: kelly sizing, capped at 25% × RISK_PCT
 *   - isKellyUnlocked: boundary conditions
 *   - Null ATR → null
 *   - No mutation of input state or signal
 *   - TP closePct sums to 1.0 for each profile
 *   - Trailing stop multiplier = 2 for all profiles
 */

import { describe, it, expect } from "vitest";
import {
  computeRiskRecommendation,
  isKellyUnlocked,
  type KellyStats,
} from "./recommend.js";
import type { BlendedSignal, IndicatorState } from "@quantara/shared";
import {
  RISK_PCT,
  STOP_MULTIPLIER_ATR,
  TP_R_MULTIPLES,
  TP_CLOSE_PCT,
  TRAILING_STOP_ATR_MULTIPLIER,
  KELLY_UNLOCK,
} from "@quantara/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<BlendedSignal> = {}): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "buy",
    confidence: 0.7,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: ["rsi-oversold"],
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
      "15m": 0,
      "1h": 0,
      "4h": 0,
      "1d": 0,
    },
    asOf: 1_700_000_000_000,
    emittingTimeframe: "1h",
    ...overrides,
  };
}

/**
 * Minimal IndicatorState with specific entry price and ATR.
 */
function makeState(entryPrice: number, atr14: number): IndicatorState {
  return {
    pair: "BTC/USDT",
    exchange: "consensus",
    timeframe: "1h",
    asOf: 1_700_000_000_000,
    barsSinceStart: 200,
    rsi14: 55,
    ema20: entryPrice * 0.99,
    ema50: entryPrice * 0.97,
    ema200: entryPrice * 0.90,
    macdLine: 0.5,
    macdSignal: 0.3,
    macdHist: 0.2,
    atr14,
    bbUpper: entryPrice * 1.02,
    bbMid: entryPrice,
    bbLower: entryPrice * 0.98,
    bbWidth: entryPrice * 0.04,
    obv: 1_000_000,
    obvSlope: 100,
    vwap: entryPrice,
    volZ: 1.2,
    realizedVolAnnualized: 0.8,
    fearGreed: 50,
    dispersion: 0.001,
    history: {
      rsi14: [55, 52, 50],
      macdHist: [0.2, 0.1, -0.1],
      ema20: [entryPrice * 0.99, entryPrice * 0.98],
      ema50: [entryPrice * 0.97, entryPrice * 0.96],
      close: [entryPrice, entryPrice * 0.995],
      volume: [1_000, 950],
    },
  };
}

// Golden values for BTC at $80,000 with ATR = 1,000.
const ENTRY = 80_000;
const ATR = 1_000;

// ---------------------------------------------------------------------------
// hold signal
// ---------------------------------------------------------------------------

describe("hold signal → null", () => {
  it("returns null for type='hold'", () => {
    const signal = makeSignal({ type: "hold" });
    const state = makeState(ENTRY, ATR);
    const result = computeRiskRecommendation(signal, state, "moderate");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Conservative × buy
// ---------------------------------------------------------------------------

describe("conservative × buy", () => {
  const profile = "conservative" as const;
  const signal = makeSignal({ type: "buy" });
  const state = makeState(ENTRY, ATR);
  const rec = computeRiskRecommendation(signal, state, profile)!;

  it("is not null", () => expect(rec).not.toBeNull());

  it("positionSizeModel = 'fixed'", () => {
    expect(rec.positionSizeModel).toBe("fixed");
  });

  it("positionSizePct = RISK_PCT.conservative", () => {
    expect(rec.positionSizePct).toBeCloseTo(RISK_PCT["conservative"], 6);
  });

  it("stopLoss = entry − ATR × 1.5 (buy)", () => {
    const expected = ENTRY - ATR * STOP_MULTIPLIER_ATR["conservative"];
    expect(rec.stopLoss).toBeCloseTo(expected, 6);
  });

  it("stopDistanceR = ATR × 1.5", () => {
    expect(rec.stopDistanceR).toBeCloseTo(ATR * STOP_MULTIPLIER_ATR["conservative"], 6);
  });

  it("takeProfit has 3 levels with R-multiples [1,2,3]", () => {
    expect(rec.takeProfit).toHaveLength(3);
    const rMultiples = TP_R_MULTIPLES["conservative"];
    rec.takeProfit.forEach((tp, i) => {
      expect(tp.rMultiple).toBe(rMultiples[i]);
    });
  });

  it("TP prices = entry + stopDistance × R (buy direction)", () => {
    const stopDist = ATR * STOP_MULTIPLIER_ATR["conservative"];
    const rMultiples = TP_R_MULTIPLES["conservative"];
    rec.takeProfit.forEach((tp, i) => {
      expect(tp.price).toBeCloseTo(ENTRY + stopDist * rMultiples[i], 6);
    });
  });

  it("TP closePct sums to 1.0", () => {
    const sum = rec.takeProfit.reduce((acc, tp) => acc + tp.closePct, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it("TP closePct matches TP_CLOSE_PCT fixture", () => {
    rec.takeProfit.forEach((tp, i) => {
      expect(tp.closePct).toBe(TP_CLOSE_PCT[i]);
    });
  });

  it("trailingStopAfterTP2.multiplier = 2", () => {
    expect(rec.trailingStopAfterTP2.multiplier).toBe(TRAILING_STOP_ATR_MULTIPLIER);
  });

  it("trailingStopAfterTP2.reference = 'ATR'", () => {
    expect(rec.trailingStopAfterTP2.reference).toBe("ATR");
  });

  it("pair matches signal.pair", () => {
    expect(rec.pair).toBe("BTC/USDT");
  });

  it("profile = 'conservative'", () => {
    expect(rec.profile).toBe("conservative");
  });

  it("invalidationCondition contains 'Stop hit' for buy", () => {
    expect(rec.invalidationCondition).toMatch(/Stop hit/i);
  });
});

// ---------------------------------------------------------------------------
// Conservative × sell
// ---------------------------------------------------------------------------

describe("conservative × sell", () => {
  const profile = "conservative" as const;
  const signal = makeSignal({ type: "sell" });
  const state = makeState(ENTRY, ATR);
  const rec = computeRiskRecommendation(signal, state, profile)!;

  it("stopLoss = entry + ATR × 1.5 (sell — above entry)", () => {
    const expected = ENTRY + ATR * STOP_MULTIPLIER_ATR["conservative"];
    expect(rec.stopLoss).toBeCloseTo(expected, 6);
  });

  it("TP prices = entry − stopDistance × R (sell direction)", () => {
    const stopDist = ATR * STOP_MULTIPLIER_ATR["conservative"];
    const rMultiples = TP_R_MULTIPLES["conservative"];
    rec.takeProfit.forEach((tp, i) => {
      expect(tp.price).toBeCloseTo(ENTRY - stopDist * rMultiples[i], 6);
    });
  });

  it("invalidationCondition contains 'closes above' for sell", () => {
    expect(rec.invalidationCondition).toMatch(/closes above/i);
  });
});

// ---------------------------------------------------------------------------
// Moderate × buy (vol-targeted)
// ---------------------------------------------------------------------------

describe("moderate × buy (vol-targeted)", () => {
  const profile = "moderate" as const;
  const signal = makeSignal({ type: "buy" });
  const state = makeState(ENTRY, ATR);
  const rec = computeRiskRecommendation(signal, state, profile)!;

  it("positionSizeModel = 'vol-targeted'", () => {
    expect(rec.positionSizeModel).toBe("vol-targeted");
  });

  it("positionSizePct is clamped to [0, RISK_PCT.moderate × 2]", () => {
    expect(rec.positionSizePct).toBeGreaterThanOrEqual(0);
    expect(rec.positionSizePct).toBeLessThanOrEqual(RISK_PCT["moderate"] * 2);
  });

  it("TP R-multiples = [1, 2, 5]", () => {
    const rMultiples = TP_R_MULTIPLES["moderate"];
    expect(rMultiples).toEqual([1, 2, 5]);
    rec.takeProfit.forEach((tp, i) => {
      expect(tp.rMultiple).toBe(rMultiples[i]);
    });
  });

  it("stopLoss = entry − ATR × 2.0 (moderate multiplier)", () => {
    const expected = ENTRY - ATR * STOP_MULTIPLIER_ATR["moderate"];
    expect(rec.stopLoss).toBeCloseTo(expected, 6);
  });
});

// ---------------------------------------------------------------------------
// Moderate × sell (vol-targeted)
// ---------------------------------------------------------------------------

describe("moderate × sell (vol-targeted)", () => {
  const profile = "moderate" as const;
  const signal = makeSignal({ type: "sell" });
  const state = makeState(ENTRY, ATR);
  const rec = computeRiskRecommendation(signal, state, profile)!;

  it("stopLoss = entry + ATR × 2.0 (sell direction)", () => {
    const expected = ENTRY + ATR * STOP_MULTIPLIER_ATR["moderate"];
    expect(rec.stopLoss).toBeCloseTo(expected, 6);
  });

  it("TP prices are below entry for sell", () => {
    rec.takeProfit.forEach((tp) => {
      expect(tp.price).toBeLessThan(ENTRY);
    });
  });
});

// ---------------------------------------------------------------------------
// Aggressive × buy (no Kelly — vol-targeted fallback)
// ---------------------------------------------------------------------------

describe("aggressive × buy (no Kelly — vol-targeted fallback)", () => {
  const profile = "aggressive" as const;
  const signal = makeSignal({ type: "buy" });
  const state = makeState(ENTRY, ATR);
  const rec = computeRiskRecommendation(signal, state, profile)!;

  it("positionSizeModel = 'vol-targeted' when Kelly not unlocked", () => {
    expect(rec.positionSizeModel).toBe("vol-targeted");
  });

  it("TP R-multiples = [1, 3, 8]", () => {
    const rMultiples = TP_R_MULTIPLES["aggressive"];
    expect(rMultiples).toEqual([1, 3, 8]);
    rec.takeProfit.forEach((tp, i) => {
      expect(tp.rMultiple).toBe(rMultiples[i]);
    });
  });

  it("stopLoss = entry − ATR × 3.0 (aggressive multiplier)", () => {
    const expected = ENTRY - ATR * STOP_MULTIPLIER_ATR["aggressive"];
    expect(rec.stopLoss).toBeCloseTo(expected, 6);
  });

  it("positionSizePct ≤ RISK_PCT.aggressive × 2", () => {
    expect(rec.positionSizePct).toBeLessThanOrEqual(RISK_PCT["aggressive"] * 2);
  });
});

// ---------------------------------------------------------------------------
// Aggressive × buy (Kelly unlocked)
// ---------------------------------------------------------------------------

describe("aggressive × buy (Kelly unlocked)", () => {
  const profile = "aggressive" as const;
  const signal = makeSignal({ type: "buy" });
  const state = makeState(ENTRY, ATR);
  // Stats that satisfy all Kelly unlock conditions.
  const kellyStats: KellyStats = {
    resolved: 60, // ≥ 50
    p: 0.55,      // ∈ [0.45, 0.65]
    b: 1.5,       // ∈ [0.5, 3.0]
  };
  const rec = computeRiskRecommendation(signal, state, profile, kellyStats)!;

  it("positionSizeModel = 'kelly'", () => {
    expect(rec.positionSizeModel).toBe("kelly");
  });

  it("positionSizePct ≤ KELLY_UNLOCK.fractionalCap × RISK_PCT.aggressive", () => {
    // kelly fraction capped at 25%; then scaled by RISK_PCT.aggressive
    const maxKellySize = KELLY_UNLOCK.fractionalCap * RISK_PCT["aggressive"];
    expect(rec.positionSizePct).toBeLessThanOrEqual(maxKellySize + 1e-12);
  });

  it("positionSizePct ≤ RISK_PCT.aggressive × 2 (safety cap)", () => {
    expect(rec.positionSizePct).toBeLessThanOrEqual(RISK_PCT["aggressive"] * 2);
  });

  it("positionSizePct > 0", () => {
    expect(rec.positionSizePct).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Aggressive × sell (Kelly unlocked) — direction check
// ---------------------------------------------------------------------------

describe("aggressive × sell (Kelly unlocked)", () => {
  const profile = "aggressive" as const;
  const signal = makeSignal({ type: "sell" });
  const state = makeState(ENTRY, ATR);
  const kellyStats: KellyStats = {
    resolved: 55,
    p: 0.58,
    b: 2.0,
  };
  const rec = computeRiskRecommendation(signal, state, profile, kellyStats)!;

  it("positionSizeModel = 'kelly'", () => {
    expect(rec.positionSizeModel).toBe("kelly");
  });

  it("stopLoss = entry + ATR × 3.0 (sell direction)", () => {
    const expected = ENTRY + ATR * STOP_MULTIPLIER_ATR["aggressive"];
    expect(rec.stopLoss).toBeCloseTo(expected, 6);
  });

  it("TP prices are all below entry for sell", () => {
    rec.takeProfit.forEach((tp) => {
      expect(tp.price).toBeLessThan(ENTRY);
    });
  });
});

// ---------------------------------------------------------------------------
// isKellyUnlocked boundary conditions
// ---------------------------------------------------------------------------

describe("isKellyUnlocked", () => {
  it("returns false for undefined stats", () => {
    expect(isKellyUnlocked(undefined)).toBe(false);
  });

  it("returns false when resolved < minResolved (50)", () => {
    const stats: KellyStats = { resolved: 49, p: 0.55, b: 1.5 };
    expect(isKellyUnlocked(stats)).toBe(false);
  });

  it("returns true when resolved = minResolved (50)", () => {
    const stats: KellyStats = { resolved: 50, p: 0.55, b: 1.5 };
    expect(isKellyUnlocked(stats)).toBe(true);
  });

  it("returns false when p < pMin (0.45)", () => {
    const stats: KellyStats = { resolved: 60, p: 0.44, b: 1.5 };
    expect(isKellyUnlocked(stats)).toBe(false);
  });

  it("returns false when p > pMax (0.65)", () => {
    const stats: KellyStats = { resolved: 60, p: 0.66, b: 1.5 };
    expect(isKellyUnlocked(stats)).toBe(false);
  });

  it("returns true for p = pMin (0.45)", () => {
    const stats: KellyStats = { resolved: 60, p: 0.45, b: 1.5 };
    expect(isKellyUnlocked(stats)).toBe(true);
  });

  it("returns true for p = pMax (0.65)", () => {
    const stats: KellyStats = { resolved: 60, p: 0.65, b: 1.5 };
    expect(isKellyUnlocked(stats)).toBe(true);
  });

  it("returns false when b < bMin (0.5)", () => {
    const stats: KellyStats = { resolved: 60, p: 0.55, b: 0.49 };
    expect(isKellyUnlocked(stats)).toBe(false);
  });

  it("returns false when b > bMax (3.0)", () => {
    const stats: KellyStats = { resolved: 60, p: 0.55, b: 3.01 };
    expect(isKellyUnlocked(stats)).toBe(false);
  });

  it("returns true for b = bMin (0.5)", () => {
    const stats: KellyStats = { resolved: 60, p: 0.55, b: 0.5 };
    expect(isKellyUnlocked(stats)).toBe(true);
  });

  it("returns true for b = bMax (3.0)", () => {
    const stats: KellyStats = { resolved: 60, p: 0.55, b: 3.0 };
    expect(isKellyUnlocked(stats)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge: null ATR → null
// ---------------------------------------------------------------------------

describe("null ATR → null", () => {
  it("returns null when atr14 is null", () => {
    const signal = makeSignal({ type: "buy" });
    const state = makeState(ENTRY, ATR);
    const stateNullAtr = { ...state, atr14: null };
    const result = computeRiskRecommendation(signal, stateNullAtr, "moderate");
    expect(result).toBeNull();
  });

  it("returns null when entry price (history.close[0]) is null", () => {
    const signal = makeSignal({ type: "buy" });
    const state = makeState(ENTRY, ATR);
    const stateNullClose = {
      ...state,
      history: { ...state.history, close: [null, ENTRY * 0.995] },
    };
    const result = computeRiskRecommendation(signal, stateNullClose, "moderate");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No mutation of inputs
// ---------------------------------------------------------------------------

describe("no mutation of inputs", () => {
  it("does not mutate the signal", () => {
    const signal = makeSignal({ type: "buy" });
    const originalSignal = JSON.parse(JSON.stringify(signal)) as BlendedSignal;
    const state = makeState(ENTRY, ATR);
    computeRiskRecommendation(signal, state, "moderate");
    expect(signal).toEqual(originalSignal);
  });

  it("does not mutate the state", () => {
    const signal = makeSignal({ type: "buy" });
    const state = makeState(ENTRY, ATR);
    const originalState = JSON.parse(JSON.stringify(state)) as IndicatorState;
    computeRiskRecommendation(signal, state, "moderate");
    expect(state).toEqual(originalState);
  });
});

// ---------------------------------------------------------------------------
// Vol-targeted sizing formula verification (moderate × buy)
// ---------------------------------------------------------------------------

describe("vol-targeted sizing formula (moderate × buy)", () => {
  it("applies RISK_PCT[profile] / (atrPct × multiplier) when result is within bounds", () => {
    // With ENTRY=80000, ATR=1000:
    // atrPct = 1000/80000 = 0.0125
    // multiplier = 2.0 (moderate)
    // rawSize = 0.010 / (0.0125 * 2.0) = 0.010 / 0.025 = 0.4 → clamped to 0.020
    const state = makeState(ENTRY, ATR);
    const signal = makeSignal({ type: "buy" });
    const rec = computeRiskRecommendation(signal, state, "moderate")!;
    const atrPct = ATR / ENTRY;
    const multiplier = STOP_MULTIPLIER_ATR["moderate"];
    const rawSize = RISK_PCT["moderate"] / (atrPct * multiplier);
    const expectedClamped = Math.min(rawSize, RISK_PCT["moderate"] * 2);
    expect(rec.positionSizePct).toBeCloseTo(expectedClamped, 10);
  });

  it("uses a small ATR scenario where vol-targeted is not clamped", () => {
    // With ENTRY=80000, ATR=50 (tiny):
    // atrPct = 50/80000 = 0.000625
    // rawSize = 0.010 / (0.000625 * 2.0) = 0.010 / 0.00125 = 8.0 → clamped to 0.020
    const state = makeState(ENTRY, 50);
    const signal = makeSignal({ type: "buy" });
    const rec = computeRiskRecommendation(signal, state, "moderate")!;
    // Still clamped
    expect(rec.positionSizePct).toBeCloseTo(RISK_PCT["moderate"] * 2, 10);
  });

  it("uses a large ATR scenario producing small size below cap", () => {
    // With ENTRY=80000, ATR=4000 (large):
    // atrPct = 4000/80000 = 0.05
    // rawSize = 0.010 / (0.05 * 2.0) = 0.010 / 0.10 = 0.10 → clamped to 0.020
    // rawSize still exceeds cap, so still 0.020
    // Let's try a scenario where rawSize < cap:
    // We want: RISK_PCT / (atrPct * mult) < RISK_PCT * 2
    // i.e. 1 / (atrPct * mult) < 2
    // i.e. atrPct > 1 / (2 * mult) = 1/4 = 0.25
    // atrPct = atr/entry, so atr > 0.25 * 80000 = 20000.
    // At ATR=25000: atrPct=0.3125, rawSize = 0.010/(0.3125*2) = 0.010/0.625 = 0.016 < 0.020
    const entry = 80_000;
    const atr = 25_000;
    const state = makeState(entry, atr);
    const signal = makeSignal({ type: "buy" });
    const rec = computeRiskRecommendation(signal, state, "moderate")!;
    const atrPct = atr / entry;
    const multiplier = STOP_MULTIPLIER_ATR["moderate"];
    const rawSize = RISK_PCT["moderate"] / (atrPct * multiplier);
    expect(rawSize).toBeLessThan(RISK_PCT["moderate"] * 2); // raw not clamped
    expect(rec.positionSizePct).toBeCloseTo(rawSize, 10);
  });
});
