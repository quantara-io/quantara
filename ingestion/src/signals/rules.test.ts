/**
 * Tests for the Appendix A rule library (RULES + MIN_CONFLUENCE from @quantara/shared).
 *
 * Aggregator convention (verified in aggregator.test.ts:147-148):
 *   history.X[0] = current bar (most recent)
 *   history.X[1] = previous bar (t-1)
 *   history.X[2] = t-2, etc.
 *
 * All fixtures respect this convention: history.macdHist[0] === state.macdHist.
 *
 * Coverage:
 *   - RULES exports 14 rules with correct names, directions, strengths
 *   - MIN_CONFLUENCE === 1.5
 *   - Each rule fires on the expected state
 *   - Each rule does NOT fire on the inverted / boundary state
 *   - macd-cross-bull/bear use history.macdHist[1] for prev (the P1 fix)
 *   - volume-spike-bull/bear use history.close[0] vs history.close[1]
 *   - End-to-end: buildIndicatorState from synthetic candles where MACD genuinely
 *     crosses triggers macd-cross-bull (the test PR #49 was missing)
 *   - appliesTo enforcement for each rule
 *   - group-max: rsi-oversold-tier and rsi-overbought-tier
 */

import { describe, it, expect } from "vitest";
import { RULES, MIN_CONFLUENCE } from "@quantara/shared";
import type { Rule } from "@quantara/shared";
import type { IndicatorState } from "@quantara/shared";
import type { Candle } from "@quantara/shared";

import { buildIndicatorState } from "../indicators/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal IndicatorState respecting the aggregator convention.
 *  history.X[0] always equals the scalar field X. */
function makeState(overrides: Partial<IndicatorState> = {}): IndicatorState {
  const base: IndicatorState = {
    pair: "BTC/USDT",
    exchange: "binanceus",
    timeframe: "1h",
    asOf: 1_700_000_000_000,
    barsSinceStart: 300,
    rsi14: 50,
    ema20: 50000,
    ema50: 50000,
    ema200: 50000,
    macdLine: 0,
    macdSignal: 0,
    macdHist: 0, // current bar — must equal history.macdHist[0]
    atr14: 500,
    bbUpper: 51000,
    bbMid: 50000,
    bbLower: 49000,
    bbWidth: 0.04,
    obv: 1_000_000,
    obvSlope: 0,
    vwap: 50000,
    volZ: 0,
    realizedVolAnnualized: 0.5,
    fearGreed: 50,
    dispersion: 0.001,
    history: {
      rsi14: [50, 50, 50, 50, 50],
      macdHist: [0, 0, 0, 0, 0], // [0] == state.macdHist (convention)
      ema20: [50000, 50000, 50000, 50000, 50000],
      ema50: [50000, 50000, 50000, 50000, 50000],
      close: [50000, 50000, 50000, 50000, 50000], // [0] == most recent close
      volume: [1000, 1000, 1000, 1000, 1000],
    },
  };

  // Deep merge overrides.history if provided.
  if (overrides.history) {
    return {
      ...base,
      ...overrides,
      history: { ...base.history, ...overrides.history },
    };
  }
  return { ...base, ...overrides };
}

/** Find a rule by name in RULES. Throws if not found. */
function getRule(name: string): Rule {
  const r = RULES.find((x) => x.name === name);
  if (!r) throw new Error(`Rule '${name}' not found in RULES`);
  return r;
}

// ---------------------------------------------------------------------------
// Metadata: count, names, MIN_CONFLUENCE
// ---------------------------------------------------------------------------

describe("RULES export — metadata", () => {
  it("exports exactly 14 rules", () => {
    expect(RULES).toHaveLength(14);
  });

  it("all rule names are unique", () => {
    const names = RULES.map((r) => r.name);
    const unique = new Set(names);
    expect(unique.size).toBe(14);
  });

  it("exports expected rule names", () => {
    const expected = [
      "rsi-oversold-strong",
      "rsi-oversold",
      "rsi-overbought-strong",
      "rsi-overbought",
      "ema-stack-bull",
      "ema-stack-bear",
      "macd-cross-bull",
      "macd-cross-bear",
      "bollinger-touch-lower",
      "bollinger-touch-upper",
      "volume-spike-bull",
      "volume-spike-bear",
      "fng-extreme-greed",
      "fng-extreme-fear",
    ];
    const actual = RULES.map((r) => r.name).sort();
    expect(actual).toEqual(expected.sort());
  });

  it("MIN_CONFLUENCE is 1.5", () => {
    expect(MIN_CONFLUENCE).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// rsi-oversold-strong
// ---------------------------------------------------------------------------

describe("rsi-oversold-strong", () => {
  const rule = getRule("rsi-oversold-strong");

  it("direction=bullish, strength=1.5", () => {
    expect(rule.direction).toBe("bullish");
    expect(rule.strength).toBe(1.5);
  });

  it("group=rsi-oversold-tier", () => {
    expect(rule.group).toBe("rsi-oversold-tier");
  });

  it("appliesTo includes 15m, 1h, 4h, 1d", () => {
    expect(rule.appliesTo).toContain("15m");
    expect(rule.appliesTo).toContain("1h");
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
  });

  it("fires when rsi14 < 20", () => {
    expect(rule.when(makeState({ rsi14: 19 }))).toBe(true);
    expect(rule.when(makeState({ rsi14: 0 }))).toBe(true);
  });

  it("does not fire when rsi14 >= 20", () => {
    expect(rule.when(makeState({ rsi14: 20 }))).toBe(false);
    expect(rule.when(makeState({ rsi14: 25 }))).toBe(false);
  });

  it("does not fire when rsi14 is null", () => {
    expect(rule.when(makeState({ rsi14: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rsi-oversold
// ---------------------------------------------------------------------------

describe("rsi-oversold", () => {
  const rule = getRule("rsi-oversold");

  it("direction=bullish, strength=1.0", () => {
    expect(rule.direction).toBe("bullish");
    expect(rule.strength).toBe(1.0);
  });

  it("group=rsi-oversold-tier", () => {
    expect(rule.group).toBe("rsi-oversold-tier");
  });

  it("fires when 20 <= rsi14 < 30", () => {
    expect(rule.when(makeState({ rsi14: 20 }))).toBe(true);
    expect(rule.when(makeState({ rsi14: 29 }))).toBe(true);
  });

  it("does not fire when rsi14 < 20 (strong rule takes over)", () => {
    expect(rule.when(makeState({ rsi14: 19 }))).toBe(false);
  });

  it("does not fire when rsi14 >= 30", () => {
    expect(rule.when(makeState({ rsi14: 30 }))).toBe(false);
    expect(rule.when(makeState({ rsi14: 50 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rsi-overbought-strong
// ---------------------------------------------------------------------------

describe("rsi-overbought-strong", () => {
  const rule = getRule("rsi-overbought-strong");

  it("direction=bearish, strength=1.5", () => {
    expect(rule.direction).toBe("bearish");
    expect(rule.strength).toBe(1.5);
  });

  it("group=rsi-overbought-tier", () => {
    expect(rule.group).toBe("rsi-overbought-tier");
  });

  it("appliesTo includes 15m, 1h, 4h, 1d", () => {
    expect(rule.appliesTo).toContain("15m");
    expect(rule.appliesTo).toContain("1h");
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
  });

  it("fires when rsi14 > 80", () => {
    expect(rule.when(makeState({ rsi14: 81 }))).toBe(true);
    expect(rule.when(makeState({ rsi14: 100 }))).toBe(true);
  });

  it("does not fire when rsi14 <= 80", () => {
    expect(rule.when(makeState({ rsi14: 80 }))).toBe(false);
    expect(rule.when(makeState({ rsi14: 75 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rsi-overbought
// ---------------------------------------------------------------------------

describe("rsi-overbought", () => {
  const rule = getRule("rsi-overbought");

  it("direction=bearish, strength=1.0", () => {
    expect(rule.direction).toBe("bearish");
    expect(rule.strength).toBe(1.0);
  });

  it("group=rsi-overbought-tier", () => {
    expect(rule.group).toBe("rsi-overbought-tier");
  });

  it("fires when 70 < rsi14 <= 80", () => {
    expect(rule.when(makeState({ rsi14: 71 }))).toBe(true);
    expect(rule.when(makeState({ rsi14: 80 }))).toBe(true);
  });

  it("does not fire when rsi14 > 80", () => {
    expect(rule.when(makeState({ rsi14: 81 }))).toBe(false);
  });

  it("does not fire when rsi14 <= 70", () => {
    expect(rule.when(makeState({ rsi14: 70 }))).toBe(false);
    expect(rule.when(makeState({ rsi14: 50 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ema-stack-bull
// ---------------------------------------------------------------------------

describe("ema-stack-bull", () => {
  const rule = getRule("ema-stack-bull");

  it("direction=bullish, strength=1.0", () => {
    expect(rule.direction).toBe("bullish");
    expect(rule.strength).toBe(1.0);
  });

  it("appliesTo 4h, 1d only (not 15m or 1h)", () => {
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
    expect(rule.appliesTo).not.toContain("15m");
    expect(rule.appliesTo).not.toContain("1h");
  });

  it("requiresPrior=200", () => {
    expect(rule.requiresPrior).toBe(200);
  });

  it("fires when ema20 > ema50 > ema200", () => {
    expect(rule.when(makeState({ ema20: 52000, ema50: 51000, ema200: 50000 }))).toBe(true);
  });

  it("does not fire when ema20 < ema50 (not bullish stack)", () => {
    expect(rule.when(makeState({ ema20: 49000, ema50: 51000, ema200: 50000 }))).toBe(false);
  });

  it("does not fire when any EMA is null", () => {
    expect(rule.when(makeState({ ema200: null }))).toBe(false);
    expect(rule.when(makeState({ ema50: null }))).toBe(false);
    expect(rule.when(makeState({ ema20: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ema-stack-bear
// ---------------------------------------------------------------------------

describe("ema-stack-bear", () => {
  const rule = getRule("ema-stack-bear");

  it("direction=bearish, strength=1.0", () => {
    expect(rule.direction).toBe("bearish");
    expect(rule.strength).toBe(1.0);
  });

  it("appliesTo 4h, 1d only (not 15m or 1h)", () => {
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
    expect(rule.appliesTo).not.toContain("15m");
    expect(rule.appliesTo).not.toContain("1h");
  });

  it("fires when ema20 < ema50 < ema200", () => {
    expect(rule.when(makeState({ ema20: 48000, ema50: 49000, ema200: 50000 }))).toBe(true);
  });

  it("does not fire when ema20 > ema50 (not bearish stack)", () => {
    expect(rule.when(makeState({ ema20: 52000, ema50: 51000, ema200: 50000 }))).toBe(false);
  });

  it("does not fire when any EMA is null", () => {
    expect(rule.when(makeState({ ema200: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// macd-cross-bull — P1 fix: uses history.macdHist[1] for prev
// ---------------------------------------------------------------------------

describe("macd-cross-bull", () => {
  const rule = getRule("macd-cross-bull");

  it("direction=bullish, strength=1.0", () => {
    expect(rule.direction).toBe("bullish");
    expect(rule.strength).toBe(1.0);
  });

  it("appliesTo 1h, 4h, 1d (not 15m)", () => {
    expect(rule.appliesTo).toContain("1h");
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
    expect(rule.appliesTo).not.toContain("15m");
  });

  it("cooldownBars=3", () => {
    expect(rule.cooldownBars).toBe(3);
  });

  it("requiresPrior=26", () => {
    expect(rule.requiresPrior).toBe(26);
  });

  it("fires when macdHist (cur) > 0 AND history.macdHist[1] (prev) <= 0", () => {
    // Correct aggregator-convention fixture: history[0] == state.macdHist
    const state = makeState({
      macdHist: 0.4, // current bar is positive
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0.4, -0.1, -0.2, -0.3, -0.4], // [0]=cur=0.4, [1]=prev=-0.1
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("fires when prev is exactly 0 (boundary: prev <= 0)", () => {
    const state = makeState({
      macdHist: 0.1,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0.1, 0, -0.1, -0.2, -0.3], // prev = 0 <= 0 → fires
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("does NOT fire when both cur and prev are positive (not a cross)", () => {
    const state = makeState({
      macdHist: 0.4,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0.4, 0.2, 0.1, 0.05, 0.01], // prev = 0.2 > 0 → no cross
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when cur is negative", () => {
    const state = makeState({
      macdHist: -0.1,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [-0.1, -0.5, -0.3, -0.2, -0.1],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when macdHist is null", () => {
    const state = makeState({
      macdHist: null,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [null, -0.1, -0.2, -0.3, -0.4],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when history.macdHist[1] is null (not enough history)", () => {
    const state = makeState({
      macdHist: 0.4,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0.4, null, null, null, null], // prev null → no cross possible
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// macd-cross-bear — P1 fix: uses history.macdHist[1] for prev
// ---------------------------------------------------------------------------

describe("macd-cross-bear", () => {
  const rule = getRule("macd-cross-bear");

  it("direction=bearish, strength=1.0", () => {
    expect(rule.direction).toBe("bearish");
    expect(rule.strength).toBe(1.0);
  });

  it("appliesTo 1h, 4h, 1d (not 15m)", () => {
    expect(rule.appliesTo).toContain("1h");
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
    expect(rule.appliesTo).not.toContain("15m");
  });

  it("cooldownBars=3", () => {
    expect(rule.cooldownBars).toBe(3);
  });

  it("fires when macdHist (cur) < 0 AND history.macdHist[1] (prev) >= 0", () => {
    const state = makeState({
      macdHist: -0.2,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [-0.2, 0.1, 0.3, 0.2, 0.1], // [0]=cur=-0.2, [1]=prev=0.1
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("fires when prev is exactly 0 (boundary: prev >= 0)", () => {
    const state = makeState({
      macdHist: -0.1,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [-0.1, 0, 0.1, 0.2, 0.3], // prev = 0 >= 0 → fires
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("does NOT fire when both cur and prev are negative (not a cross)", () => {
    const state = makeState({
      macdHist: -0.2,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [-0.2, -0.1, -0.05, -0.3, -0.2], // both negative
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when macdHist is null", () => {
    const state = makeState({
      macdHist: null,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [null, 0.1, 0.2, 0.3, 0.4],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 50000, 50000, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bollinger-touch-lower
// ---------------------------------------------------------------------------

describe("bollinger-touch-lower", () => {
  const rule = getRule("bollinger-touch-lower");

  it("direction=bullish, strength=0.5", () => {
    expect(rule.direction).toBe("bullish");
    expect(rule.strength).toBe(0.5);
  });

  it("appliesTo 4h, 1d only", () => {
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
    expect(rule.appliesTo).not.toContain("15m");
    expect(rule.appliesTo).not.toContain("1h");
  });

  it("fires when close <= bbLower", () => {
    const state = makeState({
      bbLower: 49500,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [49400, 49500, 50000, 50000, 50000], // close[0]=49400 <= bbLower=49500
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("fires exactly at bbLower (boundary)", () => {
    const state = makeState({
      bbLower: 49500,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [49500, 49600, 50000, 50000, 50000], // close[0] == bbLower exactly
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("does not fire when close > bbLower", () => {
    const state = makeState({
      bbLower: 49000,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 49500, 49000, 49000, 49000], // close[0]=50000 > bbLower=49000
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does not fire when bbLower is null", () => {
    const state = makeState({
      bbLower: null,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [48000, 49000, 49500, 49800, 50000],
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bollinger-touch-upper
// ---------------------------------------------------------------------------

describe("bollinger-touch-upper", () => {
  const rule = getRule("bollinger-touch-upper");

  it("direction=bearish, strength=0.5", () => {
    expect(rule.direction).toBe("bearish");
    expect(rule.strength).toBe(0.5);
  });

  it("appliesTo 4h, 1d only", () => {
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
    expect(rule.appliesTo).not.toContain("15m");
    expect(rule.appliesTo).not.toContain("1h");
  });

  it("fires when close >= bbUpper", () => {
    const state = makeState({
      bbUpper: 51000,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [51200, 51000, 50500, 50000, 49800], // close[0]=51200 >= bbUpper=51000
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("does not fire when close < bbUpper", () => {
    const state = makeState({
      bbUpper: 52000,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50500, 51000, 51500, 51800, 52000], // close[0]=50500 < bbUpper=52000
        volume: [1000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// volume-spike-bull
// history.close[0] = current close, history.close[1] = previous close
// Bullish bar: current close > previous close
// ---------------------------------------------------------------------------

describe("volume-spike-bull", () => {
  const rule = getRule("volume-spike-bull");

  it("direction=bullish, strength=0.5", () => {
    expect(rule.direction).toBe("bullish");
    expect(rule.strength).toBe(0.5);
  });

  it("appliesTo 15m, 1h, 4h, 1d", () => {
    expect(rule.appliesTo).toContain("15m");
    expect(rule.appliesTo).toContain("1h");
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
  });

  it("fires when volZ > 2 AND close[0] > close[1] (bullish bar)", () => {
    const state = makeState({
      volZ: 2.5,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50200, 50000, 49800, 49900, 50000], // close[0]=50200 > close[1]=50000
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("does NOT fire when volZ <= 2 (no spike)", () => {
    const state = makeState({
      volZ: 1.5,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50200, 50000, 49800, 49900, 50000],
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when close[0] < close[1] (bearish bar, even with spike)", () => {
    const state = makeState({
      volZ: 3.0,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [49800, 50000, 50100, 50200, 50300], // close[0]=49800 < close[1]=50000
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when close[0] === close[1] (doji bar, not strictly greater)", () => {
    const state = makeState({
      volZ: 3.0,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50000, 50000, 49900, 50000, 50100], // close[0] == close[1]
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when volZ is null", () => {
    const state = makeState({
      volZ: null,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50200, 50000, 49800, 49900, 50000],
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when close[1] is null (no prior close)", () => {
    const state = makeState({
      volZ: 3.0,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50200, null, null, null, null], // only 1 bar of history
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// volume-spike-bear
// ---------------------------------------------------------------------------

describe("volume-spike-bear", () => {
  const rule = getRule("volume-spike-bear");

  it("direction=bearish, strength=0.5", () => {
    expect(rule.direction).toBe("bearish");
    expect(rule.strength).toBe(0.5);
  });

  it("fires when volZ > 2 AND close[0] < close[1] (bearish bar)", () => {
    const state = makeState({
      volZ: 2.5,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [49800, 50000, 50100, 50200, 50300], // close[0]=49800 < close[1]=50000
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(true);
  });

  it("does NOT fire when close[0] > close[1] (bullish bar)", () => {
    const state = makeState({
      volZ: 3.0,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [50200, 50000, 49800, 49900, 50000],
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });

  it("does NOT fire when volZ <= 2", () => {
    const state = makeState({
      volZ: 2.0,
      history: {
        rsi14: [50, 50, 50, 50, 50],
        macdHist: [0, 0, 0, 0, 0],
        ema20: [50000, 50000, 50000, 50000, 50000],
        ema50: [50000, 50000, 50000, 50000, 50000],
        close: [49800, 50000, 50100, 50200, 50300],
        volume: [5000, 1000, 1000, 1000, 1000],
      },
    });
    expect(rule.when(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fng-extreme-greed
// ---------------------------------------------------------------------------

describe("fng-extreme-greed", () => {
  const rule = getRule("fng-extreme-greed");

  it("direction=bearish, strength=0.3", () => {
    expect(rule.direction).toBe("bearish");
    expect(rule.strength).toBe(0.3);
  });

  it("appliesTo 15m, 1h, 4h, 1d", () => {
    expect(rule.appliesTo).toContain("15m");
    expect(rule.appliesTo).toContain("1h");
    expect(rule.appliesTo).toContain("4h");
    expect(rule.appliesTo).toContain("1d");
  });

  it("requiresPrior=0", () => {
    expect(rule.requiresPrior).toBe(0);
  });

  it("fires when fearGreed > 75", () => {
    expect(rule.when(makeState({ fearGreed: 76 }))).toBe(true);
    expect(rule.when(makeState({ fearGreed: 100 }))).toBe(true);
  });

  it("does not fire when fearGreed <= 75", () => {
    expect(rule.when(makeState({ fearGreed: 75 }))).toBe(false);
    expect(rule.when(makeState({ fearGreed: 50 }))).toBe(false);
  });

  it("does not fire when fearGreed is null", () => {
    expect(rule.when(makeState({ fearGreed: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fng-extreme-fear
// ---------------------------------------------------------------------------

describe("fng-extreme-fear", () => {
  const rule = getRule("fng-extreme-fear");

  it("direction=bullish, strength=0.3", () => {
    expect(rule.direction).toBe("bullish");
    expect(rule.strength).toBe(0.3);
  });

  it("fires when fearGreed < 25", () => {
    expect(rule.when(makeState({ fearGreed: 24 }))).toBe(true);
    expect(rule.when(makeState({ fearGreed: 0 }))).toBe(true);
  });

  it("does not fire when fearGreed >= 25", () => {
    expect(rule.when(makeState({ fearGreed: 25 }))).toBe(false);
    expect(rule.when(makeState({ fearGreed: 50 }))).toBe(false);
  });

  it("does not fire when fearGreed is null", () => {
    expect(rule.when(makeState({ fearGreed: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group membership checks
// ---------------------------------------------------------------------------

describe("group membership", () => {
  it("rsi-oversold-strong and rsi-oversold share group rsi-oversold-tier", () => {
    const strong = getRule("rsi-oversold-strong");
    const normal = getRule("rsi-oversold");
    expect(strong.group).toBe("rsi-oversold-tier");
    expect(normal.group).toBe("rsi-oversold-tier");
  });

  it("rsi-overbought-strong and rsi-overbought share group rsi-overbought-tier", () => {
    const strong = getRule("rsi-overbought-strong");
    const normal = getRule("rsi-overbought");
    expect(strong.group).toBe("rsi-overbought-tier");
    expect(normal.group).toBe("rsi-overbought-tier");
  });
});

// ---------------------------------------------------------------------------
// appliesTo §4.7 table spot checks
// ---------------------------------------------------------------------------

describe("appliesTo §4.7 table", () => {
  it("ema-stack rules are NOT in appliesTo 15m or 1h", () => {
    const bull = getRule("ema-stack-bull");
    const bear = getRule("ema-stack-bear");
    expect(bull.appliesTo).not.toContain("15m");
    expect(bull.appliesTo).not.toContain("1h");
    expect(bear.appliesTo).not.toContain("15m");
    expect(bear.appliesTo).not.toContain("1h");
  });

  it("macd-cross rules are NOT in appliesTo 15m", () => {
    const bull = getRule("macd-cross-bull");
    const bear = getRule("macd-cross-bear");
    expect(bull.appliesTo).not.toContain("15m");
    expect(bear.appliesTo).not.toContain("15m");
  });

  it("bollinger-touch rules are NOT in appliesTo 15m or 1h", () => {
    const lower = getRule("bollinger-touch-lower");
    const upper = getRule("bollinger-touch-upper");
    expect(lower.appliesTo).not.toContain("15m");
    expect(lower.appliesTo).not.toContain("1h");
    expect(upper.appliesTo).not.toContain("15m");
    expect(upper.appliesTo).not.toContain("1h");
  });

  it("volume-spike rules apply to all timeframes", () => {
    const bull = getRule("volume-spike-bull");
    const bear = getRule("volume-spike-bear");
    for (const tf of ["15m", "1h", "4h", "1d"] as const) {
      expect(bull.appliesTo).toContain(tf);
      expect(bear.appliesTo).toContain(tf);
    }
  });

  it("fng-extreme rules apply to all timeframes", () => {
    const greed = getRule("fng-extreme-greed");
    const fear = getRule("fng-extreme-fear");
    for (const tf of ["15m", "1h", "4h", "1d"] as const) {
      expect(greed.appliesTo).toContain(tf);
      expect(fear.appliesTo).toContain(tf);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end test: buildIndicatorState + MACD genuine cross fires macd-cross-bull
//
// This is the test PR #49 was missing.
// The aggregator convention is: history.X[0] = current bar value.
// We build synthetic candles where the MACD histogram genuinely crosses from
// negative to positive, then assert that the rule fires on real IndicatorState.
// ---------------------------------------------------------------------------

describe("end-to-end: buildIndicatorState + macd-cross-bull (P1 fix validation)", () => {
  /**
   * Strategy: build 100 candles that are slightly decreasing (to drive MACD
   * negative), then append candles that sharply increase (to drive MACD positive).
   * The cross point — where macdHist flips from negative to positive — should
   * trigger macd-cross-bull on the bar where the flip occurs.
   */

  function makeCandleSeries(): Candle[] {
    const candles: Candle[] = [];
    const HOUR_MS = 3_600_000;
    const BASE_TIME = 1_700_000_000_000;

    // 150 bars gently trending down: price from 50000 to 48000.
    for (let i = 0; i < 150; i++) {
      const t = BASE_TIME + i * HOUR_MS;
      const price = 50000 - i * 13; // small downward drift
      candles.push({
        exchange: "binanceus",
        symbol: "BTC/USDT",
        pair: "BTC-USDT",
        timeframe: "1h",
        openTime: t,
        closeTime: t + HOUR_MS - 1,
        open: price,
        high: price + 100,
        low: price - 100,
        close: price,
        volume: 1000,
        isClosed: true,
        source: "live" as const,
      });
    }

    // 50 bars sharply trending up: strong impulse to push macdHist positive.
    for (let i = 0; i < 50; i++) {
      const idx = 150 + i;
      const t = BASE_TIME + idx * HOUR_MS;
      const price = 48000 + i * 100; // strong upward impulse
      candles.push({
        exchange: "binanceus",
        symbol: "BTC/USDT",
        pair: "BTC-USDT",
        timeframe: "1h",
        openTime: t,
        closeTime: t + HOUR_MS - 1,
        open: price,
        high: price + 150,
        low: price - 50,
        close: price,
        volume: 1000,
        isClosed: true,
        source: "live" as const,
      });
    }

    return candles;
  }

  const allCandles = makeCandleSeries();
  const ctx = {
    pair: "BTC-USDT",
    exchange: "binanceus",
    timeframe: "1h" as const,
    fearGreed: null,
    dispersion: null,
  };

  it("buildIndicatorState produces state where history.macdHist[0] === state.macdHist (convention check)", () => {
    const state = buildIndicatorState(allCandles, ctx);
    expect(state.history.macdHist[0]).toBeCloseTo(state.macdHist!, 8);
  });

  it("macd-cross-bull fires on the bar where macdHist first crosses from negative to positive", () => {
    const rule = getRule("macd-cross-bull");

    // Scan all candidate states from bar 30 onward (after MACD warm-up ~26 bars).
    let crossFound = false;
    let ruleFireCount = 0;

    for (let i = 30; i < allCandles.length; i++) {
      const slice = allCandles.slice(0, i + 1);
      const state = buildIndicatorState(slice, ctx);

      // Only test bars where MACD is available.
      if (state.macdHist === null) continue;
      if (state.history.macdHist[1] === null) continue;

      // Verify convention: history[0] always equals the scalar macdHist.
      expect(state.history.macdHist[0]).toBeCloseTo(state.macdHist, 6);

      const cur = state.macdHist;
      const prev = state.history.macdHist[1] as number;

      if (cur > 0 && prev <= 0) {
        crossFound = true;
        // The rule should fire on this bar.
        expect(rule.when(state)).toBe(true);
        ruleFireCount++;
      }
    }

    // Our candle series is designed to produce at least one genuine cross.
    expect(crossFound).toBe(true);
    expect(ruleFireCount).toBeGreaterThan(0);
  });

  it("macd-cross-bull does NOT fire when no cross occurred (both positive or both negative)", () => {
    const rule = getRule("macd-cross-bull");

    // On bars where both cur and prev are negative, the rule must not fire.
    for (let i = 30; i < 150; i++) {
      const slice = allCandles.slice(0, i + 1);
      const state = buildIndicatorState(slice, ctx);

      if (state.macdHist === null || state.history.macdHist[1] === null) continue;

      const cur = state.macdHist;
      const prev = state.history.macdHist[1] as number;

      if (cur < 0 && prev < 0) {
        expect(rule.when(state)).toBe(false);
      }
    }
  });
});
