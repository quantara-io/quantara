/**
 * Unit tests for the v1 RULES library (packages/shared/src/constants/signals.ts).
 *
 * Covers:
 *   - Each rule fires when its condition is true
 *   - Each rule does NOT fire when its condition is false
 *   - appliesTo gating: rules restricted to certain TFs don't fire on others
 *   - group-max: when both rsi-oversold and rsi-oversold-strong would fire (rsi=15),
 *     only the strong one survives group-max via scoreRules
 *   - MIN_CONFLUENCE value
 */

import { describe, it, expect } from "vitest";
import { RULES, MIN_CONFLUENCE } from "@quantara/shared";
import type { Rule, IndicatorState } from "@quantara/shared";
import { scoreRules } from "./score.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal IndicatorState. All numeric fields set to neutral values that do
 * not trigger any rule by default. Tests override specific fields.
 */
function makeState(overrides: Partial<IndicatorState> = {}): IndicatorState {
  return {
    pair: "BTC/USDT",
    exchange: "binanceus",
    timeframe: "1h",
    asOf: 1_700_000_000_000,
    barsSinceStart: 1000,
    rsi14: 50,
    ema20: 80000,
    ema50: 80000,
    ema200: 80000,
    macdLine: 0,
    macdSignal: 0,
    macdHist: 0,
    atr14: 200,
    bbUpper: 81000,
    bbMid: 80000,
    bbLower: 79000,
    bbWidth: 0.025,
    obv: 100000,
    obvSlope: 0,
    vwap: 80000,
    volZ: 0,
    realizedVolAnnualized: 0.5,
    fearGreed: 50,
    dispersion: 0.001,
    history: {
      rsi14: [50, 50, 50, 50, 50],
      macdHist: [0, 0, 0, 0, 0],
      ema20: [80000, 80000, 80000, 80000, 80000],
      ema50: [80000, 80000, 80000, 80000, 80000],
      close: [80000, 79000, 78000, 77000, 76000],
      volume: [100, 100, 100, 100, 100],
    },
    ...overrides,
  };
}

/** Find a rule by name from the RULES array (throws if not found). */
function getRule(name: string): Rule {
  const r = RULES.find((r) => r.name === name);
  if (!r) throw new Error(`Rule not found: ${name}`);
  return r;
}

// ---------------------------------------------------------------------------
// MIN_CONFLUENCE
// ---------------------------------------------------------------------------

describe("MIN_CONFLUENCE", () => {
  it("is exported as 1.5", () => {
    expect(MIN_CONFLUENCE).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// RULES shape invariants
// ---------------------------------------------------------------------------

describe("RULES shape invariants", () => {
  it("exports 14 rules", () => {
    expect(RULES).toHaveLength(14);
  });

  it("every rule has a non-empty name", () => {
    for (const r of RULES) {
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
    }
  });

  it("every rule has appliesTo with at least one timeframe", () => {
    for (const r of RULES) {
      expect(r.appliesTo.length).toBeGreaterThan(0);
    }
  });

  it("every rule has a numeric requiresPrior >= 0", () => {
    for (const r of RULES) {
      expect(typeof r.requiresPrior).toBe("number");
      expect(r.requiresPrior).toBeGreaterThanOrEqual(0);
    }
  });

  it("tiered RSI rules have the correct group", () => {
    expect(getRule("rsi-oversold-strong").group).toBe("rsi-oversold-tier");
    expect(getRule("rsi-oversold").group).toBe("rsi-oversold-tier");
    expect(getRule("rsi-overbought-strong").group).toBe("rsi-overbought-tier");
    expect(getRule("rsi-overbought").group).toBe("rsi-overbought-tier");
  });
});

// ---------------------------------------------------------------------------
// RSI rules
// ---------------------------------------------------------------------------

describe("rsi-oversold-strong", () => {
  const r = getRule("rsi-oversold-strong");

  it("fires when rsi14 < 20", () => {
    expect(r.when(makeState({ rsi14: 15 }))).toBe(true);
    expect(r.when(makeState({ rsi14: 19.9 }))).toBe(true);
  });

  it("does not fire when rsi14 === 20", () => {
    expect(r.when(makeState({ rsi14: 20 }))).toBe(false);
  });

  it("does not fire when rsi14 > 20", () => {
    expect(r.when(makeState({ rsi14: 25 }))).toBe(false);
    expect(r.when(makeState({ rsi14: 50 }))).toBe(false);
  });

  it("does not fire when rsi14 is null", () => {
    expect(r.when(makeState({ rsi14: null }))).toBe(false);
  });

  it("applies to 15m, 1h, 4h, 1d", () => {
    expect(r.appliesTo).toEqual(expect.arrayContaining(["15m", "1h", "4h", "1d"]));
  });
});

describe("rsi-oversold", () => {
  const r = getRule("rsi-oversold");

  it("fires when rsi14 in [20, 30)", () => {
    expect(r.when(makeState({ rsi14: 20 }))).toBe(true);
    expect(r.when(makeState({ rsi14: 25 }))).toBe(true);
    expect(r.when(makeState({ rsi14: 29.9 }))).toBe(true);
  });

  it("does not fire when rsi14 < 20", () => {
    expect(r.when(makeState({ rsi14: 15 }))).toBe(false);
  });

  it("does not fire when rsi14 >= 30", () => {
    expect(r.when(makeState({ rsi14: 30 }))).toBe(false);
    expect(r.when(makeState({ rsi14: 50 }))).toBe(false);
  });

  it("does not fire when rsi14 is null", () => {
    expect(r.when(makeState({ rsi14: null }))).toBe(false);
  });
});

describe("rsi-overbought-strong", () => {
  const r = getRule("rsi-overbought-strong");

  it("fires when rsi14 > 80", () => {
    expect(r.when(makeState({ rsi14: 85 }))).toBe(true);
    expect(r.when(makeState({ rsi14: 80.1 }))).toBe(true);
  });

  it("does not fire when rsi14 === 80", () => {
    expect(r.when(makeState({ rsi14: 80 }))).toBe(false);
  });

  it("does not fire when rsi14 < 80", () => {
    expect(r.when(makeState({ rsi14: 70 }))).toBe(false);
    expect(r.when(makeState({ rsi14: 50 }))).toBe(false);
  });

  it("does not fire when rsi14 is null", () => {
    expect(r.when(makeState({ rsi14: null }))).toBe(false);
  });
});

describe("rsi-overbought", () => {
  const r = getRule("rsi-overbought");

  it("fires when rsi14 in (70, 80]", () => {
    expect(r.when(makeState({ rsi14: 71 }))).toBe(true);
    expect(r.when(makeState({ rsi14: 75 }))).toBe(true);
    expect(r.when(makeState({ rsi14: 80 }))).toBe(true);
  });

  it("does not fire when rsi14 <= 70", () => {
    expect(r.when(makeState({ rsi14: 70 }))).toBe(false);
    expect(r.when(makeState({ rsi14: 50 }))).toBe(false);
  });

  it("does not fire when rsi14 > 80", () => {
    expect(r.when(makeState({ rsi14: 81 }))).toBe(false);
  });

  it("does not fire when rsi14 is null", () => {
    expect(r.when(makeState({ rsi14: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EMA stack rules
// ---------------------------------------------------------------------------

describe("ema-stack-bull", () => {
  const r = getRule("ema-stack-bull");

  it("fires when ema20 > ema50 > ema200 (bull stack)", () => {
    const state = makeState({ ema20: 82000, ema50: 81000, ema200: 79000 });
    expect(r.when(state)).toBe(true);
  });

  it("does not fire when ema20 < ema50 (bear stack)", () => {
    const state = makeState({ ema20: 78000, ema50: 80000, ema200: 82000 });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when EMAs are equal (flat)", () => {
    const state = makeState({ ema20: 80000, ema50: 80000, ema200: 80000 });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when any EMA is null", () => {
    expect(r.when(makeState({ ema20: null }))).toBe(false);
    expect(r.when(makeState({ ema50: null }))).toBe(false);
    expect(r.when(makeState({ ema200: null }))).toBe(false);
  });

  it("applies only to 4h and 1d (not 15m or 1h)", () => {
    expect(r.appliesTo).toContain("4h");
    expect(r.appliesTo).toContain("1d");
    expect(r.appliesTo).not.toContain("15m");
    expect(r.appliesTo).not.toContain("1h");
  });
});

describe("ema-stack-bear", () => {
  const r = getRule("ema-stack-bear");

  it("fires when ema20 < ema50 < ema200 (bear stack)", () => {
    const state = makeState({ ema20: 78000, ema50: 80000, ema200: 82000 });
    expect(r.when(state)).toBe(true);
  });

  it("does not fire when ema20 > ema50 (bull stack)", () => {
    const state = makeState({ ema20: 82000, ema50: 81000, ema200: 79000 });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when EMAs are equal (flat)", () => {
    const state = makeState({ ema20: 80000, ema50: 80000, ema200: 80000 });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when any EMA is null", () => {
    expect(r.when(makeState({ ema200: null }))).toBe(false);
  });

  it("applies only to 4h and 1d", () => {
    expect(r.appliesTo).toContain("4h");
    expect(r.appliesTo).toContain("1d");
    expect(r.appliesTo).not.toContain("1h");
  });
});

// ---------------------------------------------------------------------------
// MACD cross rules
// ---------------------------------------------------------------------------

describe("macd-cross-bull", () => {
  const r = getRule("macd-cross-bull");

  it("fires when macdHist crosses from negative to positive", () => {
    const state = makeState({
      macdHist: 0.5,
      history: {
        ...makeState().history,
        macdHist: [-0.1, -0.3, -0.2, -0.1, -0.05],
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("fires when prev was exactly 0 and now > 0", () => {
    const state = makeState({
      macdHist: 0.1,
      history: {
        ...makeState().history,
        macdHist: [0, -0.1, -0.2, -0.3, -0.1],
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("does not fire when cur <= 0", () => {
    const state = makeState({
      macdHist: -0.1,
      history: {
        ...makeState().history,
        macdHist: [-0.2, -0.3, -0.2, -0.1, -0.05],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when prev > 0 (not a cross)", () => {
    const state = makeState({
      macdHist: 0.5,
      history: {
        ...makeState().history,
        macdHist: [0.3, 0.2, 0.1, 0.05, 0.01],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when macdHist is null", () => {
    const state = makeState({
      macdHist: null,
      history: {
        ...makeState().history,
        macdHist: [-0.1, -0.2, -0.3, -0.2, -0.1],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("applies to 1h, 4h, 1d (not 15m)", () => {
    expect(r.appliesTo).toContain("1h");
    expect(r.appliesTo).toContain("4h");
    expect(r.appliesTo).toContain("1d");
    expect(r.appliesTo).not.toContain("15m");
  });
});

describe("macd-cross-bear", () => {
  const r = getRule("macd-cross-bear");

  it("fires when macdHist crosses from positive to negative", () => {
    const state = makeState({
      macdHist: -0.1,
      history: {
        ...makeState().history,
        macdHist: [0.2, 0.3, 0.4, 0.3, 0.2],
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("does not fire when cur >= 0", () => {
    const state = makeState({
      macdHist: 0.1,
      history: {
        ...makeState().history,
        macdHist: [0.2, 0.3, 0.2, 0.1, 0.05],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when prev was negative (not a cross)", () => {
    const state = makeState({
      macdHist: -0.5,
      history: {
        ...makeState().history,
        macdHist: [-0.3, -0.2, -0.1, -0.05, -0.01],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("applies to 1h, 4h, 1d (not 15m)", () => {
    expect(r.appliesTo).not.toContain("15m");
    expect(r.appliesTo).toContain("1h");
  });
});

// ---------------------------------------------------------------------------
// Bollinger touch rules
// ---------------------------------------------------------------------------

describe("bollinger-touch-lower", () => {
  const r = getRule("bollinger-touch-lower");

  it("fires when most recent close <= bbLower with non-trivial width", () => {
    const state = makeState({
      bbLower: 79500,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [79400, 79500, 79600, 79700, 79800],
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("fires when close exactly equals bbLower", () => {
    const state = makeState({
      bbLower: 79500,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [79500, 79600, 79700, 79800, 79900],
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("does not fire when close > bbLower", () => {
    const state = makeState({
      bbLower: 79000,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [80000, 79500, 79200, 79100, 79000],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when bbWidth <= 0.005 (narrow band)", () => {
    const state = makeState({
      bbLower: 79500,
      bbWidth: 0.003,
      history: {
        ...makeState().history,
        close: [79400, 79500, 79600, 79700, 79800],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when bbLower is null", () => {
    const state = makeState({
      bbLower: null,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [79400, 79500, 79600, 79700, 79800],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when history.close is empty", () => {
    const state = makeState({
      bbLower: 79500,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("applies only to 4h and 1d — NOT 15m or 1h", () => {
    expect(r.appliesTo).not.toContain("15m");
    expect(r.appliesTo).not.toContain("1h");
    expect(r.appliesTo).toContain("4h");
    expect(r.appliesTo).toContain("1d");
  });

  it("does NOT fire on a 15m state even when the condition would match (appliesTo gating)", () => {
    const state = makeState({
      timeframe: "15m",
      barsSinceStart: 1000,
      bbLower: 79500,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [79400, 79500, 79600, 79700, 79800],
      },
    });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((f) => f.name)).not.toContain("bollinger-touch-lower");
  });
});

describe("bollinger-touch-upper", () => {
  const r = getRule("bollinger-touch-upper");

  it("fires when most recent close >= bbUpper with non-trivial width", () => {
    const state = makeState({
      bbUpper: 80500,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [80600, 80500, 80400, 80300, 80200],
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("fires when close exactly equals bbUpper", () => {
    const state = makeState({
      bbUpper: 80500,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [80500, 80400, 80300, 80200, 80100],
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("does not fire when close < bbUpper", () => {
    const state = makeState({
      bbUpper: 81000,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [80000, 80200, 80400, 80600, 80800],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when bbWidth <= 0.005", () => {
    const state = makeState({
      bbUpper: 80500,
      bbWidth: 0.003,
      history: {
        ...makeState().history,
        close: [80600, 80500, 80400, 80300, 80200],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("applies only to 4h and 1d", () => {
    expect(r.appliesTo).not.toContain("15m");
    expect(r.appliesTo).not.toContain("1h");
    expect(r.appliesTo).toContain("4h");
    expect(r.appliesTo).toContain("1d");
  });
});

// ---------------------------------------------------------------------------
// Volume spike rules
// ---------------------------------------------------------------------------

describe("volume-spike-bull", () => {
  const r = getRule("volume-spike-bull");

  it("fires when volZ > 2 and close > prevClose", () => {
    const state = makeState({
      volZ: 2.5,
      history: {
        ...makeState().history,
        close: [80500, 80000, 79500, 79000, 78500], // close=80500 > prevClose=80000
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("does not fire when volZ <= 2", () => {
    const state = makeState({
      volZ: 1.5,
      history: {
        ...makeState().history,
        close: [80500, 80000, 79500, 79000, 78500],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when close < prevClose (down bar)", () => {
    const state = makeState({
      volZ: 3.0,
      history: {
        ...makeState().history,
        close: [79500, 80000, 80500, 81000, 81500], // close=79500 < prevClose=80000
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when volZ is null", () => {
    const state = makeState({
      volZ: null,
      history: {
        ...makeState().history,
        close: [80500, 80000, 79500, 79000, 78500],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when history.close has fewer than 2 entries", () => {
    const state = makeState({
      volZ: 3.0,
      history: {
        ...makeState().history,
        close: [80500],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("applies to 15m, 1h, 4h, 1d", () => {
    expect(r.appliesTo).toEqual(expect.arrayContaining(["15m", "1h", "4h", "1d"]));
  });
});

describe("volume-spike-bear", () => {
  const r = getRule("volume-spike-bear");

  it("fires when volZ > 2 and close < prevClose (down bar)", () => {
    const state = makeState({
      volZ: 2.5,
      history: {
        ...makeState().history,
        close: [79500, 80000, 80500, 81000, 81500], // close=79500 < prevClose=80000
      },
    });
    expect(r.when(state)).toBe(true);
  });

  it("does not fire when close > prevClose (up bar)", () => {
    const state = makeState({
      volZ: 3.0,
      history: {
        ...makeState().history,
        close: [80500, 80000, 79500, 79000, 78500], // close=80500 > prevClose=80000
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when volZ <= 2", () => {
    const state = makeState({
      volZ: 1.0,
      history: {
        ...makeState().history,
        close: [79500, 80000, 80500, 81000, 81500],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("does not fire when volZ is null", () => {
    const state = makeState({
      volZ: null,
      history: {
        ...makeState().history,
        close: [79500, 80000, 80500, 81000, 81500],
      },
    });
    expect(r.when(state)).toBe(false);
  });

  it("applies to 15m, 1h, 4h, 1d", () => {
    expect(r.appliesTo).toEqual(expect.arrayContaining(["15m", "1h", "4h", "1d"]));
  });
});

// ---------------------------------------------------------------------------
// Fear & Greed rules
// ---------------------------------------------------------------------------

describe("fng-extreme-greed", () => {
  const r = getRule("fng-extreme-greed");

  it("fires when fearGreed > 75", () => {
    expect(r.when(makeState({ fearGreed: 76 }))).toBe(true);
    expect(r.when(makeState({ fearGreed: 95 }))).toBe(true);
  });

  it("does not fire when fearGreed === 75", () => {
    expect(r.when(makeState({ fearGreed: 75 }))).toBe(false);
  });

  it("does not fire when fearGreed < 75", () => {
    expect(r.when(makeState({ fearGreed: 50 }))).toBe(false);
    expect(r.when(makeState({ fearGreed: 25 }))).toBe(false);
  });

  it("does not fire when fearGreed is null", () => {
    expect(r.when(makeState({ fearGreed: null }))).toBe(false);
  });

  it("requiresPrior is 0", () => {
    expect(r.requiresPrior).toBe(0);
  });
});

describe("fng-extreme-fear", () => {
  const r = getRule("fng-extreme-fear");

  it("fires when fearGreed < 25", () => {
    expect(r.when(makeState({ fearGreed: 24 }))).toBe(true);
    expect(r.when(makeState({ fearGreed: 5 }))).toBe(true);
  });

  it("does not fire when fearGreed === 25", () => {
    expect(r.when(makeState({ fearGreed: 25 }))).toBe(false);
  });

  it("does not fire when fearGreed > 25", () => {
    expect(r.when(makeState({ fearGreed: 50 }))).toBe(false);
    expect(r.when(makeState({ fearGreed: 75 }))).toBe(false);
  });

  it("does not fire when fearGreed is null", () => {
    expect(r.when(makeState({ fearGreed: null }))).toBe(false);
  });

  it("requiresPrior is 0", () => {
    expect(r.requiresPrior).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// appliesTo gating — verified through scoreRules
// ---------------------------------------------------------------------------

describe("appliesTo gating — verified through scoreRules", () => {
  it("ema-stack-bull does not fire on 1h even when condition matches", () => {
    const state = makeState({
      timeframe: "1h",
      barsSinceStart: 1000,
      ema20: 82000,
      ema50: 81000,
      ema200: 79000,
    });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).not.toContain("ema-stack-bull");
  });

  it("ema-stack-bull fires on 4h when condition matches and barsSinceStart >= 600", () => {
    const state = makeState({
      timeframe: "4h",
      barsSinceStart: 1000,
      ema20: 82000,
      ema50: 81000,
      ema200: 79000,
    });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).toContain("ema-stack-bull");
  });

  it("macd-cross-bull does not fire on 15m even when condition matches", () => {
    const state = makeState({
      timeframe: "15m",
      barsSinceStart: 1000,
      macdHist: 0.5,
      history: {
        ...makeState().history,
        macdHist: [-0.1, -0.2, -0.3, -0.2, -0.1],
      },
    });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).not.toContain("macd-cross-bull");
  });

  it("bollinger-touch-lower does not fire on 15m even when condition would match", () => {
    const state = makeState({
      timeframe: "15m",
      barsSinceStart: 1000,
      bbLower: 79500,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [79400, 79500, 79600, 79700, 79800],
      },
    });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).not.toContain("bollinger-touch-lower");
  });

  it("bollinger-touch-upper does not fire on 1h even when condition would match", () => {
    const state = makeState({
      timeframe: "1h",
      barsSinceStart: 1000,
      bbUpper: 80500,
      bbWidth: 0.02,
      history: {
        ...makeState().history,
        close: [80600, 80500, 80400, 80300, 80200],
      },
    });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).not.toContain("bollinger-touch-upper");
  });

  it("rsi-oversold-strong fires on 15m when condition matches and barsSinceStart >= 14", () => {
    const state = makeState({
      timeframe: "15m",
      barsSinceStart: 1000,
      rsi14: 15,
    });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).toContain("rsi-oversold-strong");
  });
});

// ---------------------------------------------------------------------------
// group-max: RSI tier mutual exclusion via scoreRules
// ---------------------------------------------------------------------------

describe("group-max — RSI tier mutual exclusion", () => {
  it("rsi=25 — only rsi-oversold fires (strong predicate fails), rsi-oversold-strong absent", () => {
    const state = makeState({ timeframe: "1h", barsSinceStart: 1000, rsi14: 25 });
    const fired = scoreRules(state, RULES, {});
    const names = fired.map((r) => r.name);
    expect(names).toContain("rsi-oversold");
    expect(names).not.toContain("rsi-oversold-strong");
  });

  it("rsi=15 — only rsi-oversold-strong fires (rsi-oversold predicate requires rsi >= 20)", () => {
    const state = makeState({ timeframe: "1h", barsSinceStart: 1000, rsi14: 15 });
    const fired = scoreRules(state, RULES, {});
    const names = fired.map((r) => r.name);
    expect(names).toContain("rsi-oversold-strong");
    expect(names).not.toContain("rsi-oversold");
  });

  it("group-max collapses both tiers to only the strongest when both predicates fire", () => {
    // Construct both rules with always-true predicates sharing the same group
    const bothFire: Rule[] = [
      {
        name: "rsi-oversold",
        direction: "bullish",
        strength: 1.0,
        when: () => true,
        appliesTo: ["1h"],
        group: "rsi-oversold-tier",
        requiresPrior: 0,
      },
      {
        name: "rsi-oversold-strong",
        direction: "bullish",
        strength: 1.5,
        when: () => true,
        appliesTo: ["1h"],
        group: "rsi-oversold-tier",
        requiresPrior: 0,
      },
    ];
    const state = makeState({ timeframe: "1h", barsSinceStart: 100 });
    const fired = scoreRules(state, bothFire, {});
    expect(fired).toHaveLength(1);
    expect(fired[0].name).toBe("rsi-oversold-strong");
    expect(fired[0].strength).toBe(1.5);
    expect(fired[0].group).toBe("rsi-oversold-tier");
  });

  it("rsi=75 — rsi-overbought fires, rsi-overbought-strong does not", () => {
    const state = makeState({ timeframe: "1h", barsSinceStart: 1000, rsi14: 75 });
    const fired = scoreRules(state, RULES, {});
    const names = fired.map((r) => r.name);
    expect(names).toContain("rsi-overbought");
    expect(names).not.toContain("rsi-overbought-strong");
  });

  it("rsi=85 — only rsi-overbought-strong fires", () => {
    const state = makeState({ timeframe: "1h", barsSinceStart: 1000, rsi14: 85 });
    const fired = scoreRules(state, RULES, {});
    const names = fired.map((r) => r.name);
    expect(names).toContain("rsi-overbought-strong");
    expect(names).not.toContain("rsi-overbought");
  });

  it("rsi=50 — neither overbought nor oversold tier fires", () => {
    const state = makeState({ timeframe: "1h", barsSinceStart: 1000, rsi14: 50 });
    const fired = scoreRules(state, RULES, {});
    const names = fired.map((r) => r.name);
    expect(names).not.toContain("rsi-oversold");
    expect(names).not.toContain("rsi-oversold-strong");
    expect(names).not.toContain("rsi-overbought");
    expect(names).not.toContain("rsi-overbought-strong");
  });
});

// ---------------------------------------------------------------------------
// requiresPrior warm-up gate — spot check via scoreRules
// ---------------------------------------------------------------------------

describe("requiresPrior warm-up gate", () => {
  it("rsi-oversold-strong does not fire when barsSinceStart < 14", () => {
    const state = makeState({ timeframe: "1h", barsSinceStart: 13, rsi14: 15 });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).not.toContain("rsi-oversold-strong");
  });

  it("rsi-oversold-strong fires when barsSinceStart >= 14", () => {
    const state = makeState({ timeframe: "1h", barsSinceStart: 14, rsi14: 15 });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).toContain("rsi-oversold-strong");
  });

  it("fng-extreme-fear fires even at barsSinceStart=1 (requiresPrior=0)", () => {
    const state = makeState({ timeframe: "1h", barsSinceStart: 1, fearGreed: 10 });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).toContain("fng-extreme-fear");
  });

  it("ema-stack-bull does not fire when barsSinceStart < 600", () => {
    const state = makeState({
      timeframe: "4h",
      barsSinceStart: 599,
      ema20: 82000,
      ema50: 81000,
      ema200: 79000,
    });
    const fired = scoreRules(state, RULES, {});
    expect(fired.map((r) => r.name)).not.toContain("ema-stack-bull");
  });
});
