/**
 * engine.lookahead.test.ts — Phase 3 look-ahead protection unit tests.
 *
 * Each test below exercises a real production code path: a regression that
 * removes the look-ahead defense (e.g. dropping `baseSeries.slice(0, baseIdx+1)`
 * from engine.ts, or letting the outcome resolver pick a candle beyond
 * `expiresAt`) MUST cause one of these tests to fail.
 *
 * Test cases:
 *   1. Indicator state — engine.ts `baseSeries.slice(0, baseIdx + 1)` defense:
 *      no future candle can influence the indicator state at bar N.
 *   2. Outcome price lookup — resolver uses the candle AT `expiresAt`, not a
 *      later candle. (No TF_MS slack — strict equality.)
 *   3. Calibration freeze — `checkFrozenCalibrationGuard` warns when
 *      paramsAt > earliest signal emittedAt.
 *   4. Walk-forward calibration — window N's Platt fit uses only outcomes from
 *      windows < N, never the current or future window.
 *
 * Sentiment look-ahead (old test #5) and rule-"since" look-ahead (old test #6)
 * are deferred until those features are wired through the engine. Sentiment is
 * currently stubbed (Phase 1) and rules do not yet carry a `since` field, so
 * there is no production code path to exercise. A test that filters an
 * in-test array with `Array.filter` does not test the engine — it tests
 * `Array.filter`. Better to leave the test out than ship a hollow guard.
 */

import { describe, it, expect, vi } from "vitest";
import type { Candle, Timeframe } from "@quantara/shared";

import { BacktestEngine } from "./engine.js";
import type { HistoricalCandleStore } from "./store/candle-store.js";
import {
  checkFrozenCalibrationGuard,
  applyWalkForwardCalibration,
  buildWalkForwardWindows,
} from "./calibration/walk-forward.js";
import type { BacktestSignal } from "./engine.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TF_MS = 3_600_000; // 1h
const EXCHANGES = ["binanceus", "coinbase", "kraken"] as const;

/**
 * Build a series of synthetic 1h candles. `closeAt(i)` controls per-bar close
 * price (open/high/low track close ± 0.1% to keep bar shape consistent with
 * the engine.test.ts fixtures).
 */
function makeCandles(count: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = closeAt(i);
    return {
      exchange: "binanceus",
      symbol: "BTC/USDT",
      pair: "BTC/USDT",
      timeframe: "1h" as Timeframe,
      openTime: BASE_TIME + i * TF_MS,
      closeTime: BASE_TIME + i * TF_MS + TF_MS - 1,
      open: close,
      high: close * 1.001,
      low: close * 0.999,
      close,
      volume: 100,
      isClosed: true,
      source: "backfill" as const,
    };
  });
}

/**
 * Mock store that returns the same candle series for every production exchange
 * regardless of the requested fetch window — so the engine sees the full
 * synthetic history (including any "future" bars we baked in) and must rely
 * on its own internal slice to avoid look-ahead.
 */
function mockStore(candles: Candle[]): HistoricalCandleStore {
  const perExchange: Record<string, Candle[]> = {};
  for (const ex of EXCHANGES) perExchange[ex] = candles.map((c) => ({ ...c, exchange: ex }));
  return {
    getCandles: vi.fn().mockResolvedValue([]),
    getCandlesForAllExchanges: vi.fn().mockImplementation(async (_p: string, tf: string) => {
      if (tf !== "1h") return {};
      return perExchange;
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. Indicator state — `baseSeries.slice(0, baseIdx + 1)` defense
// ---------------------------------------------------------------------------

describe("look-ahead guard: indicator state", () => {
  it("indicator state at bar N reflects ONLY candles [0..N], not future bars", async () => {
    // Fixture: 200 candles. Bars 0–99 are flat at $30,000 (RSI converges to
    // 50, no momentum rule fires). Bars 100–199 are a sustained linear crash
    // from $30,000 down to $1,500 — heavy enough that, computed at the END
    // of the series, RSI would be deep in oversold territory (< 20).
    //
    // The store returns ALL 200 candles regardless of fetch window, so the
    // engine's baseSeries will hold the full history. If the engine's
    // `baseSeries.slice(0, baseIdx + 1)` defense is removed (or `baseIdx`
    // wrong), `buildIndicatorState` will be called with bars 0..199 and the
    // produced state will reflect the crash — triggering `rsi-oversold` or
    // `rsi-oversold-strong`. With the defense intact, the state at bar 99
    // sees only the flat history and no rsi-* rule fires.
    const candles = makeCandles(200, (i) => (i < 100 ? 30_000 : 30_000 - (i - 99) * 285));
    // Sanity-check the fixture: end of crash is well below baseline so a
    // peek-ahead would unambiguously trip rsi-oversold-strong.
    expect(candles[199]!.close).toBeLessThan(2_000);

    const engine = new BacktestEngine(mockStore(candles));

    // Evaluate ONLY bar 99 (the last flat bar) so we're testing a single,
    // well-defined indicator state. closeTime of bar 99 = BASE_TIME + 100*TF_MS - 1.
    const bar99Close = BASE_TIME + 99 * TF_MS + TF_MS - 1;
    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 99 * TF_MS), // bar 99 openTime
      to: new Date(bar99Close), // bar 99 closeTime
    });

    expect(result.signals.length).toBe(1);
    const signal = result.signals[0]!;
    expect(signal.closeTime).toBe(bar99Close);

    // priceAtSignal is the canonical close AT bar 99 — must be the flat
    // baseline. (Independent of the slice defense but pins the test to the
    // correct bar.)
    expect(signal.priceAtSignal).toBe(30_000);

    // Flat-past indicator state: ATR ≈ 0, realized vol ≈ 0, dispersion = 0.
    // The volatility/dispersion gate in `evaluateGates` reads ATR + recent
    // realized vol; both are computed by `buildIndicatorState`, which the
    // slice feeds. With the slice defense intact, the engine sees the flat
    // 0..99 history and the gate stays quiet. If the slice is removed and
    // the engine reads the full 0..199 series, the same `buildIndicatorState`
    // call now produces a state at bar 199 with extreme ATR / realized vol,
    // and the volatility gate fires (gateReason="vol").
    //
    // Asserting `gateReason === null` is therefore a direct check on
    // "indicator state was computed without future bars". This assertion has
    // been mutation-tested: removing `baseSeries.slice(0, baseIdx + 1)` at
    // engine.ts:769 flips gateReason from null → "vol" and fails this line.
    expect(signal.gateReason).toBeNull();

    // Belt-and-suspenders: the flat past gives RSI ≈ 50, so no rsi-* rule
    // can fire on a defended state. (When the volatility gate fires it
    // suppresses rulesFired regardless, so this is a secondary signal.)
    expect(signal.type).toBe("hold");
    const rsiRulesFired = signal.rulesFired.filter((r) => r.startsWith("rsi-"));
    expect(rsiRulesFired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Outcome price lookup — resolver uses the candle AT expiresAt, not later
// ---------------------------------------------------------------------------

describe("look-ahead guard: outcome price lookup", () => {
  it("priceAtResolution is the close at expiresAt, NOT the close at expiresAt+TF_MS", async () => {
    // Fixture engineering:
    //   - Bars 0..104: flat at $30,000.
    //   - Bar 105+:    jumps to $60,000 (huge gap).
    //
    // Signal emitted at bar 100 has expiresAtMs = bar104.closeTime, so the
    // resolver MUST read the candle at bar 104 (close = $30,000). If the
    // resolver peeks one bar ahead, it would return $60,000 — the assertion
    // below catches that immediately.
    const candles = makeCandles(210, (i) => (i <= 104 ? 30_000 : 60_000));

    const engine = new BacktestEngine(mockStore(candles));

    // Run with `to` = bar 104's closeTime so that ONLY the signal emitted at
    // bar 100 will have its expiresAt fall inside the evaluation window (and
    // therefore have a resolution candle available). Signals at bars 101–104
    // expire past `to` and stay unresolved — they won't pollute the assertion.
    const bar100Open = BASE_TIME + 100 * TF_MS;
    const bar104Close = BASE_TIME + 104 * TF_MS + TF_MS - 1;
    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(bar100Open),
      to: new Date(bar104Close),
    });

    // Find the signal emitted at bar 100.
    const bar100Signal = result.signals.find(
      (s) => s.closeTime === BASE_TIME + 100 * TF_MS + TF_MS - 1,
    );
    expect(bar100Signal, "engine should emit a signal at bar 100").toBeDefined();
    expect(bar100Signal!.priceAtResolution).not.toBeNull();

    // Strict equality: priceAtResolution must equal bar 104's close ($30,000),
    // not bar 105's close ($60,000). Any one-bar look-ahead leaks $60,000.
    expect(bar100Signal!.priceAtResolution).toBe(30_000);
    expect(bar100Signal!.priceAtResolution).not.toBe(60_000);

    // resolvedAt must equal expiresAt exactly — no TF_MS slack.
    expect(bar100Signal!.resolvedAt).toBe(bar100Signal!.expiresAt);
  });
});

// ---------------------------------------------------------------------------
// 3. Calibration freeze: paramsAt > earliest_signal_emittedAt → warn
// ---------------------------------------------------------------------------

describe("look-ahead guard: frozen calibration", () => {
  function fakeSignal(emittedAt: string): BacktestSignal {
    return {
      emittedAt,
      closeTime: new Date(emittedAt).getTime(),
      pair: "BTC/USDT",
      timeframe: "1h",
      type: "buy",
      confidence: 0.7,
      rulesFired: [],
      gateReason: null,
      resolvedAt: null,
      outcome: null,
      priceMovePct: null,
      priceAtSignal: 30000,
      priceAtResolution: null,
      expiresAt: new Date(new Date(emittedAt).getTime() + 4 * TF_MS).toISOString(),
      ratificationStatus: "not-required",
    };
  }

  it("warns when paramsAt is after earliest signal", () => {
    const warning = checkFrozenCalibrationGuard(
      { kind: "frozen", paramsAt: "2026-04-01T00:00:00.000Z" },
      [fakeSignal("2026-01-15T00:00:00.000Z")],
    );

    expect(warning).not.toBeNull();
    expect(warning).toContain("LOOK-AHEAD WARNING");
    expect(warning).toContain("paramsAt=2026-04-01");
  });

  it("returns null when paramsAt is before earliest signal", () => {
    const warning = checkFrozenCalibrationGuard(
      { kind: "frozen", paramsAt: "2026-01-01T00:00:00.000Z" },
      [fakeSignal("2026-04-15T00:00:00.000Z")],
    );

    expect(warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Walk-forward calibration: window N params come from outcomes of windows < N
// ---------------------------------------------------------------------------

describe("look-ahead guard: walk-forward calibration", () => {
  it("window 1 confidences are calibrated using ONLY window 0 outcomes", () => {
    // Build a 60-day period with refitDays=30 (exactly 2 windows). Each
    // window contains 60 synthetic signals (well above
    // CALIBRATION_MIN_SAMPLES=50 in `fitPlattCoeffs`) so the Platt fit will
    // actually run on prior-window data instead of returning null.
    //
    // Per-window setup (raw confidence sweeps linearly across [0.3, 0.7] to
    // give the Newton-Raphson solver a non-singular Hessian — constant x
    // makes the Hessian determinant zero, so the fit degenerates to identity):
    //
    //   Window 0 (Jan 2026): 60 signals, raw conf ∈ [0.3, 0.7], outcome="correct".
    //   Window 1 (Feb 2026): 60 signals, raw conf ∈ [0.3, 0.7], outcome="incorrect".
    //
    // With window-0-only training data (all y=1), Platt drives σ(a·x + b) → 1
    // across the whole confidence range; calibrated values land at ≈ 1.0.
    //
    // If walk-forward LEAKED window 1's outcomes into its own fit, training
    // would see 60 correct + 60 incorrect at matched x — labels balance per-x,
    // Platt converges near identity, calibrated values stay ≈ raw. The
    // assertion catches that drift.
    const fromMs = new Date("2026-01-01T00:00:00.000Z").getTime();
    const refitDays = 30;
    const windowMs = refitDays * 86_400_000;
    const toMs = fromMs + 2 * windowMs;

    const windows = buildWalkForwardWindows(fromMs, toMs, refitDays);
    expect(windows.length).toBe(2);

    const SIGNALS_PER_WINDOW = 60;

    function rawConfidenceAt(i: number): number {
      // Spread raw confidence in [0.3, 0.7] across the window. Variation in x
      // is required to keep Platt's Hessian non-singular.
      return 0.3 + (i / SIGNALS_PER_WINDOW) * 0.4;
    }

    function buildSignal(
      emittedMs: number,
      rawConf: number,
      outcome: "correct" | "incorrect",
    ): BacktestSignal {
      return {
        emittedAt: new Date(emittedMs).toISOString(),
        closeTime: emittedMs,
        pair: "BTC/USDT",
        timeframe: "1h",
        type: "buy",
        confidence: rawConf,
        rulesFired: ["rsi-oversold"],
        gateReason: null,
        resolvedAt: new Date(emittedMs + 4 * TF_MS).toISOString(),
        outcome,
        priceMovePct: outcome === "correct" ? 0.01 : -0.01,
        priceAtSignal: 30_000,
        priceAtResolution: outcome === "correct" ? 30_300 : 29_700,
        expiresAt: new Date(emittedMs + 4 * TF_MS).toISOString(),
        ratificationStatus: "not-required",
      };
    }

    const signals: BacktestSignal[] = [];
    for (let w = 0; w < windows.length; w++) {
      const win = windows[w]!;
      // Spread the 60 signals evenly across the window so each one is
      // unambiguously inside [startMs, endMs).
      const spacing = Math.floor((win.endMs - win.startMs) / SIGNALS_PER_WINDOW);
      const outcome: "correct" | "incorrect" = w === 0 ? "correct" : "incorrect";
      for (let i = 0; i < SIGNALS_PER_WINDOW; i++) {
        signals.push(buildSignal(win.startMs + i * spacing, rawConfidenceAt(i), outcome));
      }
    }
    expect(signals).toHaveLength(SIGNALS_PER_WINDOW * 2);

    const calibrated = applyWalkForwardCalibration(
      signals,
      { kind: "walk-forward", refitDays },
      fromMs,
      toMs,
    );
    expect(calibrated).toHaveLength(signals.length);

    // Window 0 signals: no prior outcomes → fitPlattCoeffs returns null →
    // confidence must be UNCHANGED.
    const window0End = windows[0]!.endMs;
    const window0Calibrated = calibrated.filter(
      (s) => new Date(s.emittedAt).getTime() < window0End,
    );
    expect(window0Calibrated).toHaveLength(SIGNALS_PER_WINDOW);
    for (let i = 0; i < window0Calibrated.length; i++) {
      expect(window0Calibrated[i]!.confidence).toBe(rawConfidenceAt(i));
    }

    // Window 1 signals: Platt fit runs on window 0 outcomes (all "correct"),
    // so calibrated confidence should be pushed strongly upward toward 1.0
    // across the entire raw-confidence range. If window 1's own
    // (all-incorrect) outcomes leaked into the fit, the calibration would be
    // near identity (calibrated ≈ raw).
    const window1Calibrated = calibrated.filter(
      (s) => new Date(s.emittedAt).getTime() >= window0End,
    );
    expect(window1Calibrated).toHaveLength(SIGNALS_PER_WINDOW);
    for (let i = 0; i < window1Calibrated.length; i++) {
      const sig = window1Calibrated[i]!;
      const raw = rawConfidenceAt(i);
      // Decisive separation: > 0.99 if calibrated from window 0 alone (all y=1),
      // ≈ raw (0.3..0.7) if window 1 leaked into its own fit. Margin is wide.
      expect(sig.confidence).toBeGreaterThan(0.99);
      // And the calibrated value must have actually shifted away from raw.
      expect(sig.confidence - raw).toBeGreaterThan(0.25);
    }
  });
});
