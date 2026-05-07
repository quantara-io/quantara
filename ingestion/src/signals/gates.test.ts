import { describe, it, expect } from "vitest";
import {
  gateVolatility,
  gateDispersion,
  gateStale,
  evaluateGates,
} from "./gates.js";
import type { IndicatorState } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(
  overrides: Partial<IndicatorState> = {},
): IndicatorState {
  return {
    pair: "BTC/USDT",
    exchange: "binanceus",
    timeframe: "1h",
    asOf: 1_700_000_000_000,
    barsSinceStart: 100,
    rsi14: 55,
    ema20: 30000,
    ema50: 29000,
    ema200: 28000,
    macdLine: 100,
    macdSignal: 90,
    macdHist: 10,
    atr14: 500,
    bbUpper: 32000,
    bbMid: 30000,
    bbLower: 28000,
    bbWidth: 0.13,
    obv: 1000,
    obvSlope: 0.5,
    vwap: 30100,
    volZ: 0.2,
    realizedVolAnnualized: 0.5, // 50% — below BTC threshold of 150%
    fearGreed: 55,
    dispersion: 0.005,
    history: {
      rsi14: [55, 54, 53, 52, 51],
      macdHist: [10, 9, 8, 7, 6],
      ema20: [30000, 29900, 29800, 29700, 29600],
      ema50: [29000, 28900, 28800, 28700, 28600],
      close: [30000, 29900, 29800, 29700, 29600],
      volume: [1000, 900, 800, 700, 600],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// gateVolatility
// ---------------------------------------------------------------------------

describe("gateVolatility", () => {
  it("does not fire when realizedVolAnnualized is null (warm-up)", () => {
    const state = makeState({ realizedVolAnnualized: null });
    const result = gateVolatility(state);
    expect(result.fired).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("does not fire when vol is below the threshold", () => {
    // BTC threshold is 1.50; 0.5 < 1.50
    const state = makeState({ pair: "BTC/USDT", realizedVolAnnualized: 0.5 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("does not fire when vol equals the threshold exactly (must exceed, not equal)", () => {
    const state = makeState({ pair: "BTC/USDT", realizedVolAnnualized: 1.50 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("fires when vol exceeds the BTC threshold (1.50)", () => {
    const state = makeState({ pair: "BTC/USDT", realizedVolAnnualized: 1.51 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("vol");
  });

  it("fires when vol exceeds the ETH threshold (2.00)", () => {
    const state = makeState({ pair: "ETH/USDT", realizedVolAnnualized: 2.01 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("vol");
  });

  it("fires when vol exceeds the SOL threshold (3.00)", () => {
    const state = makeState({ pair: "SOL/USDT", realizedVolAnnualized: 3.01 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("vol");
  });

  it("fires when vol exceeds the XRP threshold (2.50)", () => {
    const state = makeState({ pair: "XRP/USDT", realizedVolAnnualized: 2.51 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("vol");
  });

  it("fires when vol exceeds the DOGE threshold (3.50)", () => {
    const state = makeState({ pair: "DOGE/USDT", realizedVolAnnualized: 3.51 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("vol");
  });

  it("does not fire when vol is below the DOGE threshold", () => {
    const state = makeState({ pair: "DOGE/USDT", realizedVolAnnualized: 3.49 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(false);
  });

  it("does not mutate the input state", () => {
    const state = makeState({ realizedVolAnnualized: 2.0 });
    const before = JSON.stringify(state);
    gateVolatility(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("does not fire for unknown pair", () => {
    const state = makeState({ pair: "UNKNOWN/USDT", realizedVolAnnualized: 99.0 });
    const result = gateVolatility(state);
    expect(result.fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gateDispersion
// ---------------------------------------------------------------------------

describe("gateDispersion", () => {
  it("does not fire when state.dispersion is null", () => {
    const state = makeState({ dispersion: null });
    const result = gateDispersion(state, [0.02, 0.02, 0.02]);
    expect(result.fired).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("does not fire when fewer than 3 bars of history are provided", () => {
    const state = makeState({ dispersion: 0.02 });
    expect(gateDispersion(state, []).fired).toBe(false);
    expect(gateDispersion(state, [0.02]).fired).toBe(false);
    expect(gateDispersion(state, [0.02, 0.02]).fired).toBe(false);
  });

  it("fires when all 3 most-recent values exceed 0.01", () => {
    const state = makeState({ dispersion: 0.02 });
    const result = gateDispersion(state, [0.02, 0.015, 0.011]);
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("dispersion");
  });

  it("does not fire on a single-bar spike (other bars at or below 0.01)", () => {
    const state = makeState({ dispersion: 0.02 });
    // Only the most recent bar is above 0.01; the other two are not.
    const result = gateDispersion(state, [0.02, 0.01, 0.005]);
    expect(result.fired).toBe(false);
  });

  it("does not fire when exactly at threshold (must exceed 0.01, not equal)", () => {
    const state = makeState({ dispersion: 0.01 });
    const result = gateDispersion(state, [0.01, 0.01, 0.01]);
    expect(result.fired).toBe(false);
  });

  it("does not fire when two of three bars are above threshold", () => {
    const state = makeState({ dispersion: 0.02 });
    const result = gateDispersion(state, [0.02, 0.02, 0.005]);
    expect(result.fired).toBe(false);
  });

  it("only checks the 3 most recent values from the history array", () => {
    const state = makeState({ dispersion: 0.02 });
    // First 3 are all above; the rest are below — should still fire.
    const result = gateDispersion(state, [0.05, 0.04, 0.03, 0.0, 0.0, 0.0]);
    expect(result.fired).toBe(true);
  });

  it("does not mutate the input state or dispersionHistory array", () => {
    const state = makeState({ dispersion: 0.02 });
    const history = [0.02, 0.02, 0.02];
    const beforeState = JSON.stringify(state);
    const beforeHistory = [...history];
    gateDispersion(state, history);
    expect(JSON.stringify(state)).toBe(beforeState);
    expect(history).toEqual(beforeHistory);
  });
});

// ---------------------------------------------------------------------------
// gateStale
// ---------------------------------------------------------------------------

describe("gateStale", () => {
  it("does not fire when no exchanges are stale", () => {
    const result = gateStale({
      binanceus: false,
      coinbase: false,
      kraken: false,
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("does not fire when only 1 exchange is stale", () => {
    const result = gateStale({
      binanceus: true,
      coinbase: false,
      kraken: false,
    });
    expect(result.fired).toBe(false);
  });

  it("fires when exactly 2 exchanges are stale", () => {
    const result = gateStale({
      binanceus: true,
      coinbase: true,
      kraken: false,
    });
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("stale");
  });

  it("fires when all 3 exchanges are stale", () => {
    const result = gateStale({
      binanceus: true,
      coinbase: true,
      kraken: true,
    });
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("stale");
  });

  it("fires when 2 of 4 entries are stale (handles >3 exchanges)", () => {
    const result = gateStale({
      a: true,
      b: true,
      c: false,
      d: false,
    });
    expect(result.fired).toBe(true);
  });

  it("does not fire with empty staleness map", () => {
    const result = gateStale({});
    expect(result.fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateGates
// ---------------------------------------------------------------------------

describe("evaluateGates", () => {
  it("returns { fired: false, reason: null } when no gates fire", () => {
    const state = makeState({
      realizedVolAnnualized: 0.5,
      dispersion: 0.005,
    });
    const result = evaluateGates(
      state,
      [0.005, 0.004, 0.003],
      { binanceus: false, coinbase: false, kraken: false },
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("returns vol reason when vol gate fires (highest priority)", () => {
    const state = makeState({
      pair: "BTC/USDT",
      realizedVolAnnualized: 2.0, // exceeds 1.50 threshold
      dispersion: 0.02,
    });
    // Also trigger dispersion and stale so we verify priority ordering.
    const result = evaluateGates(
      state,
      [0.02, 0.02, 0.02], // dispersion would also fire
      { binanceus: true, coinbase: true, kraken: false }, // stale would also fire
    );
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("vol");
  });

  it("returns dispersion reason when vol does not fire but dispersion does", () => {
    const state = makeState({
      pair: "BTC/USDT",
      realizedVolAnnualized: 0.5, // below threshold
      dispersion: 0.02,
    });
    const result = evaluateGates(
      state,
      [0.02, 0.02, 0.02],
      { binanceus: true, coinbase: true, kraken: false }, // stale would also fire
    );
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("dispersion");
  });

  it("returns stale reason when only stale gate fires", () => {
    const state = makeState({
      realizedVolAnnualized: 0.5,
      dispersion: 0.005,
    });
    const result = evaluateGates(
      state,
      [0.005, 0.004, 0.003],
      { binanceus: true, coinbase: true, kraken: false },
    );
    expect(result.fired).toBe(true);
    expect(result.reason).toBe("stale");
  });

  it("handles null realizedVolAnnualized (warm-up) without crashing", () => {
    const state = makeState({
      realizedVolAnnualized: null,
      dispersion: null,
    });
    const result = evaluateGates(
      state,
      [],
      { binanceus: false, coinbase: false, kraken: false },
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("handles null dispersion without crashing", () => {
    const state = makeState({
      realizedVolAnnualized: 0.5,
      dispersion: null,
    });
    const result = evaluateGates(
      state,
      [0.02, 0.02, 0.02],
      { binanceus: false, coinbase: false, kraken: false },
    );
    expect(result.fired).toBe(false);
  });

  it("does not mutate input state, dispersionHistory, or exchangeStaleness", () => {
    const state = makeState({ realizedVolAnnualized: 2.0, dispersion: 0.02 });
    const history = [0.02, 0.02, 0.02];
    const staleness = { binanceus: true, coinbase: true, kraken: false };
    const beforeState = JSON.stringify(state);
    const beforeHistory = [...history];
    const beforeStaleness = { ...staleness };
    evaluateGates(state, history, staleness);
    expect(JSON.stringify(state)).toBe(beforeState);
    expect(history).toEqual(beforeHistory);
    expect(staleness).toEqual(beforeStaleness);
  });
});
