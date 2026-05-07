import { describe, it, expect } from "vitest";
import {
  gateVolatility,
  gateDispersion,
  gateStale,
  evaluateGates,
  narrowPair,
} from "./gates.js";
import type { IndicatorState } from "@quantara/shared";

// Minimal IndicatorState factory — only the fields the gate functions read
function makeState(overrides: Partial<IndicatorState> = {}): IndicatorState {
  return {
    pair: "BTC/USDT",
    exchange: "binanceus",
    timeframe: "1h",
    asOf: Date.now(),
    barsSinceStart: 100,
    rsi14: null,
    ema20: null,
    ema50: null,
    ema200: null,
    macdLine: null,
    macdSignal: null,
    macdHist: null,
    atr14: null,
    bbUpper: null,
    bbMid: null,
    bbLower: null,
    bbWidth: null,
    obv: null,
    obvSlope: null,
    vwap: null,
    volZ: null,
    realizedVolAnnualized: null,
    fearGreed: null,
    dispersion: null,
    history: {
      rsi14: [],
      macdHist: [],
      ema20: [],
      ema50: [],
      close: [],
      volume: [],
    },
    ...overrides,
  };
}

const STALE_3 = { binanceus: false, coinbase: false, kraken: false };

// ─── narrowPair ────────────────────────────────────────────────────────────────

describe("narrowPair", () => {
  it("returns the pair when it is valid", () => {
    expect(narrowPair("BTC/USDT")).toBe("BTC/USDT");
    expect(narrowPair("ETH/USDT")).toBe("ETH/USDT");
    expect(narrowPair("SOL/USDT")).toBe("SOL/USDT");
    expect(narrowPair("XRP/USDT")).toBe("XRP/USDT");
    expect(narrowPair("DOGE/USDT")).toBe("DOGE/USDT");
  });

  it("throws a descriptive error when the pair is unknown", () => {
    expect(() => narrowPair("AVAX/USDT")).toThrow(/AVAX\/USDT/);
    expect(() => narrowPair("AVAX/USDT")).toThrow(/BTC\/USDT/); // mentions valid set
  });

  it("throws on empty string", () => {
    expect(() => narrowPair("")).toThrow();
  });
});

// ─── gateVolatility ───────────────────────────────────────────────────────────

describe("gateVolatility", () => {
  it("fires when vol exceeds the per-pair threshold", () => {
    // BTC/USDT threshold = 1.50
    const state = makeState({ realizedVolAnnualized: 1.51 });
    const result = gateVolatility(state, "BTC/USDT");
    expect(result).toEqual({ fired: true, reason: "vol" });
  });

  it("does not fire when vol equals the threshold exactly", () => {
    const state = makeState({ realizedVolAnnualized: 1.50 });
    expect(gateVolatility(state, "BTC/USDT").fired).toBe(false);
  });

  it("does not fire when vol is below the threshold", () => {
    const state = makeState({ realizedVolAnnualized: 0.5 });
    expect(gateVolatility(state, "BTC/USDT").fired).toBe(false);
  });

  it("uses the correct per-pair threshold (DOGE/USDT = 3.50)", () => {
    const below = makeState({ realizedVolAnnualized: 3.49 });
    const above = makeState({ realizedVolAnnualized: 3.51 });
    expect(gateVolatility(below, "DOGE/USDT").fired).toBe(false);
    expect(gateVolatility(above, "DOGE/USDT")).toEqual({ fired: true, reason: "vol" });
  });

  it("does not fire when realizedVolAnnualized is null", () => {
    const state = makeState({ realizedVolAnnualized: null });
    expect(gateVolatility(state, "BTC/USDT").fired).toBe(false);
  });

  it("does not fire when realizedVolAnnualized is NaN", () => {
    const state = makeState({ realizedVolAnnualized: NaN });
    expect(gateVolatility(state, "BTC/USDT").fired).toBe(false);
  });

  it("does not fire when realizedVolAnnualized is Infinity", () => {
    const state = makeState({ realizedVolAnnualized: Infinity });
    expect(gateVolatility(state, "BTC/USDT").fired).toBe(false);
  });

  it("does not fire when realizedVolAnnualized is negative", () => {
    const state = makeState({ realizedVolAnnualized: -0.1 });
    expect(gateVolatility(state, "BTC/USDT").fired).toBe(false);
  });

  it("does not mutate the input state", () => {
    const state = makeState({ realizedVolAnnualized: 2.0 });
    const snapshot = JSON.stringify(state);
    gateVolatility(state, "BTC/USDT");
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

// ─── gateDispersion ───────────────────────────────────────────────────────────

describe("gateDispersion", () => {
  const ABOVE = [0.02, 0.03, 0.015]; // all three > 0.01, most-recent-first
  const MIXED = [0.02, 0.005, 0.015]; // second entry below threshold

  it("fires when all 3 most-recent history values exceed 1%", () => {
    const state = makeState({ dispersion: 0.02 });
    expect(gateDispersion(state, ABOVE)).toEqual({ fired: true, reason: "dispersion" });
  });

  it("does not fire when any of the 3 most-recent values is at or below 1%", () => {
    const state = makeState({ dispersion: 0.02 });
    expect(gateDispersion(state, MIXED).fired).toBe(false);
  });

  it("does not fire when dispersionHistory has fewer than 3 entries", () => {
    const state = makeState({ dispersion: 0.05 });
    expect(gateDispersion(state, [0.05, 0.05]).fired).toBe(false);
    expect(gateDispersion(state, [0.05]).fired).toBe(false);
    expect(gateDispersion(state, []).fired).toBe(false);
  });

  it("only looks at the first 3 elements (most-recent-first contract)", () => {
    // 4th element is high but first 3 include a low — should not fire
    const state = makeState({ dispersion: 0.02 });
    const history = [0.02, 0.005, 0.02, 0.05];
    expect(gateDispersion(state, history).fired).toBe(false);
  });

  it("does not fire when state.dispersion is null", () => {
    const state = makeState({ dispersion: null });
    expect(gateDispersion(state, ABOVE).fired).toBe(false);
  });

  it("does not fire when state.dispersion is NaN", () => {
    const state = makeState({ dispersion: NaN });
    expect(gateDispersion(state, ABOVE).fired).toBe(false);
  });

  it("does not fire when state.dispersion is Infinity", () => {
    const state = makeState({ dispersion: Infinity });
    expect(gateDispersion(state, ABOVE).fired).toBe(false);
  });

  it("does not fire when state.dispersion is negative", () => {
    const state = makeState({ dispersion: -0.01 });
    expect(gateDispersion(state, ABOVE).fired).toBe(false);
  });

  it("does not mutate the dispersionHistory array", () => {
    const state = makeState({ dispersion: 0.02 });
    const history = [...ABOVE];
    const snapshot = JSON.stringify(history);
    gateDispersion(state, history);
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});

// ─── gateStale ────────────────────────────────────────────────────────────────

describe("gateStale", () => {
  it("fires when exactly 2 of 3 exchanges are stale", () => {
    const map = { binanceus: true, coinbase: true, kraken: false };
    expect(gateStale(map)).toEqual({ fired: true, reason: "stale" });
  });

  it("fires when all 3 exchanges are stale", () => {
    const map = { binanceus: true, coinbase: true, kraken: true };
    expect(gateStale(map)).toEqual({ fired: true, reason: "stale" });
  });

  it("does not fire when only 1 exchange is stale", () => {
    const map = { binanceus: true, coinbase: false, kraken: false };
    expect(gateStale(map).fired).toBe(false);
  });

  it("does not fire when no exchanges are stale", () => {
    expect(gateStale(STALE_3).fired).toBe(false);
  });

  it("throws when fewer than 3 exchanges are provided", () => {
    expect(() => gateStale({ binanceus: true, coinbase: false })).toThrow(/exactly 3/);
  });

  it("throws when more than 3 exchanges are provided", () => {
    expect(() =>
      gateStale({ binanceus: true, coinbase: false, kraken: true, bybit: false }),
    ).toThrow(/exactly 3/);
  });

  it("throws with a message that includes the actual count", () => {
    expect(() => gateStale({ binanceus: true, coinbase: false })).toThrow(/2/);
    expect(() =>
      gateStale({ binanceus: true, coinbase: false, kraken: true, bybit: false }),
    ).toThrow(/4/);
  });

  it("does not mutate the staleness map", () => {
    const map = { binanceus: true, coinbase: true, kraken: false };
    const snapshot = JSON.stringify(map);
    gateStale(map);
    expect(JSON.stringify(map)).toBe(snapshot);
  });
});

// ─── evaluateGates ────────────────────────────────────────────────────────────

describe("evaluateGates", () => {
  const DISPERSION_ABOVE = [0.02, 0.03, 0.015];
  const DISPERSION_BELOW = [0.002, 0.003, 0.001];

  it("returns { fired: false, reason: null } when no gate fires", () => {
    const state = makeState({ realizedVolAnnualized: 0.5, dispersion: 0.001 });
    expect(evaluateGates(state, "BTC/USDT", DISPERSION_BELOW, STALE_3)).toEqual({
      fired: false,
      reason: null,
    });
  });

  it("returns vol gate first when vol fires", () => {
    // vol fires (1.51 > 1.50), dispersion also fires, stale also fires
    const state = makeState({ realizedVolAnnualized: 1.51, dispersion: 0.02 });
    const staleMap = { binanceus: true, coinbase: true, kraken: false };
    const result = evaluateGates(state, "BTC/USDT", DISPERSION_ABOVE, staleMap);
    expect(result).toEqual({ fired: true, reason: "vol" });
  });

  it("returns dispersion gate when vol does not fire but dispersion does", () => {
    // vol does not fire, dispersion fires, stale also fires
    const state = makeState({ realizedVolAnnualized: 0.5, dispersion: 0.02 });
    const staleMap = { binanceus: true, coinbase: true, kraken: false };
    const result = evaluateGates(state, "BTC/USDT", DISPERSION_ABOVE, staleMap);
    expect(result).toEqual({ fired: true, reason: "dispersion" });
  });

  it("returns stale gate when vol and dispersion do not fire", () => {
    const state = makeState({ realizedVolAnnualized: 0.5, dispersion: 0.001 });
    const staleMap = { binanceus: true, coinbase: true, kraken: false };
    const result = evaluateGates(state, "BTC/USDT", DISPERSION_BELOW, staleMap);
    expect(result).toEqual({ fired: true, reason: "stale" });
  });

  it("propagates the gateStale throw on bad arity", () => {
    const state = makeState({ realizedVolAnnualized: 0.5, dispersion: 0.001 });
    expect(() =>
      evaluateGates(state, "BTC/USDT", DISPERSION_BELOW, {
        binanceus: false,
        coinbase: false,
      }),
    ).toThrow(/exactly 3/);
  });
});
