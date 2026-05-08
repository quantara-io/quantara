/**
 * Tests for computeRiskRecommendation — Phase 7 (revised) #77
 *
 * Covers:
 *   - Vol-targeted formula (corrected — no upper clamp)
 *   - Fixed-fractional for conservative
 *   - Kelly sizing (aggressive, unlocked)
 *   - Kelly boundary tests at exact unlock threshold values (Fix 9)
 *   - Zero-size suppression returning null (Fix 7)
 *   - stopDistance naming (not stopDistanceR) (Fix 4)
 *   - Sell invalidation wording uses "crosses above" (Fix 5)
 *   - PRICE_PREFIX constant (Fix 8)
 *   - null returns for hold signals / missing ATR / missing close
 */

import { describe, it, expect } from "vitest";
import type { BlendedSignal, IndicatorState, KellyStats } from "@quantara/shared";
import {
  computeRiskRecommendation,
  kellyUnlocked,
  RISK_PCT,
  STOP_MULTIPLIER,
  TP_MULTIPLES,
  PRICE_PREFIX,
  MIN_SIZE_PCT,
} from "./recommend.js";

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
    weightsUsed: { "1m": 0, "5m": 0, "15m": 0.15, "1h": 0.20, "4h": 0.30, "1d": 0.35 },
    asOf: 1700000000000,
    emittingTimeframe: "1h",
    risk: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<IndicatorState> = {}): IndicatorState {
  return {
    pair: "BTC/USDT",
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
    atr14: 500,        // $500 ATR on a ~$46000 BTC → atrPct ≈ 0.01087
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PRICE_PREFIX constant
// ---------------------------------------------------------------------------

describe("PRICE_PREFIX", () => {
  it("is defined and equals '$'", () => {
    expect(PRICE_PREFIX).toBe("$");
  });
});

// ---------------------------------------------------------------------------
// Hold signal → null
// ---------------------------------------------------------------------------

describe("computeRiskRecommendation — hold signals", () => {
  it("returns null for hold signals", () => {
    const signal = makeSignal({ type: "hold" });
    const state = makeState();
    expect(computeRiskRecommendation(signal, state, "moderate")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Missing ATR / close → null
// ---------------------------------------------------------------------------

describe("computeRiskRecommendation — missing inputs", () => {
  it("returns null when atr14 is null", () => {
    const signal = makeSignal();
    const state = makeState({ atr14: null });
    expect(computeRiskRecommendation(signal, state, "moderate")).toBeNull();
  });

  it("returns null when atr14 is 0", () => {
    const signal = makeSignal();
    const state = makeState({ atr14: 0 });
    expect(computeRiskRecommendation(signal, state, "moderate")).toBeNull();
  });

  it("returns null when history.close is all null", () => {
    const signal = makeSignal();
    const state = makeState({
      history: {
        rsi14: [],
        macdHist: [],
        ema20: [],
        ema50: [],
        close: [null, null, null, null, null],
        volume: [],
      },
    });
    expect(computeRiskRecommendation(signal, state, "moderate")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Conservative — fixed-fractional
// ---------------------------------------------------------------------------

describe("computeRiskRecommendation — conservative (fixed-fractional)", () => {
  it("uses fixed-fractional model with RISK_PCT.conservative", () => {
    const signal = makeSignal();
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "conservative");
    expect(rec).not.toBeNull();
    expect(rec!.positionSizeModel).toBe("fixed");
    expect(rec!.positionSizePct).toBe(RISK_PCT.conservative);
    expect(rec!.profile).toBe("conservative");
  });

  it("does not use Kelly even if stats are provided and unlocked", () => {
    const signal = makeSignal();
    const state = makeState();
    const kelly: KellyStats = {
      pair: "BTC/USDT",
      timeframe: "1h",
      direction: "buy",
      resolved: 60,
      p: 0.55,
      b: 1.5,
    };
    const rec = computeRiskRecommendation(signal, state, "conservative", kelly);
    expect(rec!.positionSizeModel).toBe("fixed");
  });
});

// ---------------------------------------------------------------------------
// Vol-targeted formula (Fix 3 — no upper clamp)
// ---------------------------------------------------------------------------

describe("computeRiskRecommendation — vol-targeted (moderate)", () => {
  it("uses vol-targeted formula: sizePct = RISK_PCT / (atrPct × multiplier)", () => {
    // ATR=500, close=46200 (last close), multiplier=2 (moderate)
    // atrPct = 500 / 46200 ≈ 0.010823
    // sizePct = 0.01 / (0.010823 × 2) ≈ 0.462
    const signal = makeSignal();
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec).not.toBeNull();
    expect(rec!.positionSizeModel).toBe("vol-targeted");
    const entryPrice = 46200; // latest non-null close
    const atrPct = 500 / entryPrice;
    const expected = RISK_PCT.moderate / (atrPct * STOP_MULTIPLIER.moderate);
    expect(rec!.positionSizePct).toBeCloseTo(expected, 6);
  });

  it("vol-targeted sizing formula (moderate × buy) — corrected math", () => {
    // Issue spec worked example:
    // moderate profile: RISK_PCT=0.01, multiplier=2
    // ATR=1000, entry=100000 → atrPct = 0.01
    // sizePct = 0.01 / (0.01 × 2) = 0.5  (50% of capital)
    // The OLD clamped formula would have returned 0.02 — this is the P1 fix.
    const signal = makeSignal({ pair: "BTC/USDT" });
    const state = makeState({
      atr14: 1000,
      history: {
        rsi14: [],
        macdHist: [],
        ema20: [],
        ema50: [],
        close: [100000],
        volume: [],
      },
    });
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec).not.toBeNull();
    // atrPct = 1000/100000 = 0.01; sizePct = 0.01 / (0.01 × 2) = 0.5
    expect(rec!.positionSizePct).toBeCloseTo(0.5, 6);
    expect(rec!.positionSizeModel).toBe("vol-targeted");
  });

  it("does not apply an upper clamp to vol-targeted size", () => {
    // Low ATR → large size; this is correct, no upper clamp
    // ATR=10, entry=46200 → atrPct=0.000216, multiplier=2
    // sizePct = 0.01 / (0.000216 × 2) ≈ 23.1
    // Old code would clamp to RISK_PCT×2 = 0.02 — this verifies no clamp
    const signal = makeSignal();
    const state = makeState({
      atr14: 10,
      history: {
        rsi14: [],
        macdHist: [],
        ema20: [],
        ema50: [],
        close: [46200],
        volume: [],
      },
    });
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec).not.toBeNull();
    expect(rec!.positionSizePct).toBeGreaterThan(1); // much larger than RISK_PCT×2=0.02
  });

  it("falls back to vol-targeted for aggressive profile before Kelly unlock", () => {
    const signal = makeSignal();
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "aggressive");
    expect(rec!.positionSizeModel).toBe("vol-targeted");
  });
});

// ---------------------------------------------------------------------------
// Zero-size suppression (Fix 7)
// ---------------------------------------------------------------------------

describe("computeRiskRecommendation — zero-size suppression (Fix 7)", () => {
  it("returns null when sizePct falls below MIN_SIZE_PCT", () => {
    // Very high ATR relative to entry → tiny position
    // ATR=100000, entry=1 → atrPct=100000, moderate: sizePct = 0.01/(100000×2) = 5e-8 → below MIN_SIZE_PCT
    const signal = makeSignal();
    const state = makeState({
      atr14: 100000,
      history: {
        rsi14: [],
        macdHist: [],
        ema20: [],
        ema50: [],
        close: [1],
        volume: [],
      },
    });
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec).toBeNull();
  });

  it("returns a recommendation when sizePct >= MIN_SIZE_PCT", () => {
    const signal = makeSignal();
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "conservative");
    expect(rec).not.toBeNull();
    expect(rec!.positionSizePct).toBeGreaterThanOrEqual(MIN_SIZE_PCT);
  });
});

// ---------------------------------------------------------------------------
// Kelly sizing (aggressive, unlocked)
// ---------------------------------------------------------------------------

describe("computeRiskRecommendation — Kelly sizing", () => {
  it("uses Kelly when aggressive profile and Kelly unlocked", () => {
    const signal = makeSignal();
    const state = makeState();
    const kelly: KellyStats = {
      pair: "BTC/USDT",
      timeframe: "1h",
      direction: "buy",
      resolved: 60,
      p: 0.55,
      b: 1.5,
    };
    const rec = computeRiskRecommendation(signal, state, "aggressive", kelly);
    expect(rec).not.toBeNull();
    expect(rec!.positionSizeModel).toBe("kelly");
    // kelly_f = (0.55×1.5 − 0.45) / 1.5 = (0.825 − 0.45) / 1.5 = 0.375/1.5 = 0.25
    // sizePct = 0.25 × 0.25 = 0.0625
    expect(rec!.positionSizePct).toBeCloseTo(0.0625, 6);
  });

  it("falls back to vol-targeted when Kelly stats present but not unlocked (n < 50)", () => {
    const signal = makeSignal();
    const state = makeState();
    const kelly: KellyStats = {
      pair: "BTC/USDT",
      timeframe: "1h",
      direction: "buy",
      resolved: 30, // < 50
      p: 0.55,
      b: 1.5,
    };
    const rec = computeRiskRecommendation(signal, state, "aggressive", kelly);
    expect(rec!.positionSizeModel).toBe("vol-targeted");
  });

  it("caps Kelly at 25% (0.25 × kelly_f, never higher)", () => {
    // Very favorable stats: p=0.65, b=3.0
    // kelly_f = (0.65×3 − 0.35) / 3 = (1.95−0.35)/3 = 1.6/3 ≈ 0.5333
    // sizePct = 0.25 × 0.5333 ≈ 0.1333 (13.3% — within cap)
    const signal = makeSignal();
    const state = makeState();
    const kelly: KellyStats = {
      pair: "BTC/USDT",
      timeframe: "1h",
      direction: "buy",
      resolved: 60,
      p: 0.65,
      b: 3.0,
    };
    const rec = computeRiskRecommendation(signal, state, "aggressive", kelly);
    expect(rec!.positionSizeModel).toBe("kelly");
    expect(rec!.positionSizePct).toBeLessThanOrEqual(0.25);
  });
});

// ---------------------------------------------------------------------------
// Kelly unlock boundary tests (Fix 9) — inclusive bounds verified
// ---------------------------------------------------------------------------

describe("kellyUnlocked — boundary tests (Fix 9)", () => {
  const base: KellyStats = {
    pair: "BTC/USDT",
    timeframe: "1h",
    direction: "buy",
    resolved: 50,
    p: 0.55,
    b: 1.5,
  };

  it("unlocks at exactly n=50", () => {
    expect(kellyUnlocked({ ...base, resolved: 50 })).toBe(true);
  });

  it("does not unlock at n=49", () => {
    expect(kellyUnlocked({ ...base, resolved: 49 })).toBe(false);
  });

  // p boundary — inclusive [0.45, 0.65]
  it("p=0.45 is within bounds (inclusive lower)", () => {
    expect(kellyUnlocked({ ...base, p: 0.45 })).toBe(true);
  });

  it("p=0.65 is within bounds (inclusive upper)", () => {
    expect(kellyUnlocked({ ...base, p: 0.65 })).toBe(true);
  });

  it("p slightly below 0.45 is out of bounds", () => {
    expect(kellyUnlocked({ ...base, p: 0.45 - Number.EPSILON })).toBe(false);
  });

  it("p slightly above 0.65 is out of bounds", () => {
    expect(kellyUnlocked({ ...base, p: 0.65 + Number.EPSILON })).toBe(false);
  });

  // b boundary — inclusive [0.5, 3.0]
  it("b=0.5 is within bounds (inclusive lower)", () => {
    expect(kellyUnlocked({ ...base, b: 0.5 })).toBe(true);
  });

  it("b=3.0 is within bounds (inclusive upper)", () => {
    expect(kellyUnlocked({ ...base, b: 3.0 })).toBe(true);
  });

  it("b slightly below 0.5 is out of bounds", () => {
    expect(kellyUnlocked({ ...base, b: 0.5 - Number.EPSILON })).toBe(false);
  });

  it("b slightly above 3.0 is out of bounds", () => {
    // Number.EPSILON (2.22e-16) is too small to distinguish from 3.0 in float64.
    // Use a step that produces a representable value above 3.0.
    expect(kellyUnlocked({ ...base, b: 3.0 + 1e-10 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stop / take-profit / invalidation
// ---------------------------------------------------------------------------

describe("computeRiskRecommendation — stop, TP, invalidation", () => {
  it("buy stop is entry − stopDistance", () => {
    const signal = makeSignal({ type: "buy" });
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec).not.toBeNull();
    const entryPrice = 46200;
    const expectedStop = entryPrice - rec!.stopDistance;
    expect(rec!.stopLoss).toBeCloseTo(expectedStop, 4);
  });

  it("sell stop is entry + stopDistance", () => {
    const signal = makeSignal({ type: "sell" });
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec).not.toBeNull();
    const entryPrice = 46200;
    const expectedStop = entryPrice + rec!.stopDistance;
    expect(rec!.stopLoss).toBeCloseTo(expectedStop, 4);
  });

  it("stopDistance = ATR × STOP_MULTIPLIER[profile]", () => {
    const signal = makeSignal();
    const state = makeState(); // atr14=500, moderate multiplier=2
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec!.stopDistance).toBeCloseTo(500 * STOP_MULTIPLIER.moderate, 6);
  });

  it("has no stopDistanceR field (renamed to stopDistance — Fix 4)", () => {
    const signal = makeSignal();
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec).not.toBeNull();
    expect("stopDistanceR" in rec!).toBe(false);
  });

  it("buy has 3 take-profit levels with correct R-multiples (moderate)", () => {
    const signal = makeSignal({ type: "buy" });
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec!.takeProfit).toHaveLength(3);
    const [tp1, tp2, tp3] = rec!.takeProfit;
    expect(tp1.rMultiple).toBe(TP_MULTIPLES.moderate[0]);
    expect(tp2.rMultiple).toBe(TP_MULTIPLES.moderate[1]);
    expect(tp3.rMultiple).toBe(TP_MULTIPLES.moderate[2]);
    expect(tp1.closePct).toBe(0.5);
    expect(tp2.closePct).toBe(0.25);
    expect(tp3.closePct).toBe(0.25);
  });

  // Fix 5: sell invalidation uses "crosses above" not "closes above"
  it("sell invalidation says 'crosses above' (Fix 5)", () => {
    const signal = makeSignal({ type: "sell" });
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec!.invalidationCondition).toContain("crosses above");
    expect(rec!.invalidationCondition).not.toContain("closes above");
  });

  it("buy invalidation says 'crosses below'", () => {
    const signal = makeSignal({ type: "buy" });
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec!.invalidationCondition).toContain("crosses below");
  });

  it("invalidation condition uses PRICE_PREFIX", () => {
    const signal = makeSignal();
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec!.invalidationCondition).toContain(PRICE_PREFIX);
  });

  it("returns trailingStopAfterTP2 with ATR reference", () => {
    const signal = makeSignal();
    const state = makeState();
    const rec = computeRiskRecommendation(signal, state, "moderate");
    expect(rec!.trailingStopAfterTP2.reference).toBe("ATR");
    expect(rec!.trailingStopAfterTP2.multiplier).toBe(2);
  });

  it("result includes pair and profile", () => {
    const signal = makeSignal({ pair: "ETH/USDT" });
    const state = makeState({ pair: "ETH/USDT" });
    const rec = computeRiskRecommendation(signal, state, "aggressive");
    expect(rec!.pair).toBe("ETH/USDT");
    expect(rec!.profile).toBe("aggressive");
  });
});
