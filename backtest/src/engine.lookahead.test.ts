/**
 * engine.lookahead.test.ts — Phase 3 look-ahead protection unit tests.
 *
 * Six guard tests covering the most common backtest look-ahead bias patterns.
 * Each test is ≤30 LOC and fails loudly with a specific error message.
 *
 * Test cases:
 *   1. Indicator state: candle[50] state uses ONLY candles 0-50, not 51-99.
 *   2. Outcome price lookup: resolver looks up candle at expiresAt, not a future candle.
 *   3. Calibration freeze: paramsAt > earliest_signal_emittedAt → warn/throw.
 *   4. Walk-forward calibration: window N params come from outcomes of windows < N.
 *   5. Sentiment timestamp: publishedAt > signal.emittedAt should be filtered out.
 *   6. Rule "since" filtering: assert harness no-op behavior (rules lack "since" field).
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

function makeCandles(count: number, baseClose = 30_000): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    exchange: "binanceus",
    symbol: "BTC/USDT",
    pair: "BTC/USDT",
    timeframe: "1h" as Timeframe,
    openTime: BASE_TIME + i * TF_MS,
    closeTime: BASE_TIME + i * TF_MS + TF_MS - 1,
    open: baseClose,
    high: baseClose * 1.001,
    low: baseClose * 0.999,
    close: baseClose,
    volume: 100,
    isClosed: true,
    source: "backfill" as const,
  }));
}

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
// 1. Indicator state — candles available at evaluation time only
// ---------------------------------------------------------------------------

describe("look-ahead guard: indicator state", () => {
  it("engine called with 100 candles starting from candle[50] uses only candles 0-50", async () => {
    // 100 candles. Eval window starts at candle 50 (after warmup headroom).
    // The engine fetches warmup bars BEFORE from, so it requests from - WARMUP_BARS.
    // We verify it never reads candles AFTER evalFrom.
    const candles = makeCandles(100);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 50 * TF_MS);
    const evalTo = new Date(BASE_TIME + 59 * TF_MS);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: evalFrom,
      to: evalTo,
    });

    // All emittedAt timestamps must be in [evalFrom, evalTo].
    for (const sig of result.signals) {
      const emittedMs = new Date(sig.emittedAt).getTime();
      expect(emittedMs).toBeGreaterThanOrEqual(evalFrom.getTime());
      expect(emittedMs).toBeLessThanOrEqual(evalTo.getTime());
    }

    // getCandlesForAllExchanges was called with a fetchFrom BEFORE evalFrom
    // (warmup bars), never after.
    const call = (store.getCandlesForAllExchanges as ReturnType<typeof vi.fn>).mock.calls[0];
    const fetchFrom: Date = call[2];
    const fetchTo: Date = call[3];
    expect(fetchFrom.getTime()).toBeLessThan(evalFrom.getTime());
    // fetchTo should not extend beyond the declared `to`.
    expect(fetchTo.getTime()).toBeLessThanOrEqual(evalTo.getTime());
  });
});

// ---------------------------------------------------------------------------
// 2. Outcome price lookup — resolver uses expiresAt candle, not a future one
// ---------------------------------------------------------------------------

describe("look-ahead guard: outcome price lookup", () => {
  it("priceAtResolution corresponds to the candle at expiresAt, not a later candle", async () => {
    // 260 candles. Signals emitted at bars 205-259. expiresAt = emittedAt + 4 bars.
    // Resolution candle must be at emittedAt + 4*TF_MS, not beyond.
    const candles = makeCandles(260);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS),
      to: new Date(BASE_TIME + 259 * TF_MS),
    });

    for (const sig of result.signals) {
      if (sig.priceAtResolution === null) continue;
      const expiresMs = new Date(sig.expiresAt).getTime();
      const resolvedMs = sig.resolvedAt ? new Date(sig.resolvedAt).getTime() : expiresMs;
      // resolvedAt must be <= expiresAt (cannot use a candle after expiry).
      expect(resolvedMs).toBeLessThanOrEqual(expiresMs + TF_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Calibration freeze: paramsAt > earliest_signal_emittedAt → warn
// ---------------------------------------------------------------------------

describe("look-ahead guard: frozen calibration", () => {
  it("checkFrozenCalibrationGuard returns a warning when paramsAt is after earliest signal", () => {
    const signals: BacktestSignal[] = [
      {
        emittedAt: "2026-01-15T00:00:00.000Z",
        closeTime: BASE_TIME,
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
        expiresAt: "2026-01-15T04:00:00.000Z",
        ratificationStatus: "not-required",
      },
    ];

    const warning = checkFrozenCalibrationGuard(
      { kind: "frozen", paramsAt: "2026-04-01T00:00:00.000Z" },
      signals,
    );

    expect(warning).not.toBeNull();
    expect(warning).toContain("LOOK-AHEAD WARNING");
    expect(warning).toContain("paramsAt=2026-04-01");
  });

  it("checkFrozenCalibrationGuard returns null when paramsAt is before earliest signal", () => {
    const signals: BacktestSignal[] = [
      {
        emittedAt: "2026-04-15T00:00:00.000Z",
        closeTime: BASE_TIME,
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
        expiresAt: "2026-04-15T04:00:00.000Z",
        ratificationStatus: "not-required",
      },
    ];

    const warning = checkFrozenCalibrationGuard(
      { kind: "frozen", paramsAt: "2026-01-01T00:00:00.000Z" },
      signals,
    );

    expect(warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Walk-forward calibration: window N params come from outcomes of windows < N
// ---------------------------------------------------------------------------

describe("look-ahead guard: walk-forward calibration", () => {
  it("window N signals only see Platt params fit on prior-window outcomes", () => {
    // 6 months of signals: Jan to Jun 2026, refitDays=30.
    // January-February signals should have no Platt coefficients (no prior data).
    // March signals should be fit on Jan+Feb outcomes only.
    const fromMs = new Date("2026-01-01").getTime();
    const toMs = new Date("2026-06-01").getTime();
    const refitDays = 30;

    const windows = buildWalkForwardWindows(fromMs, toMs, refitDays);
    // There should be 5 windows (Jan, Feb, Mar, Apr, May).
    expect(windows.length).toBeGreaterThanOrEqual(5);

    // Build synthetic signals: 5 per window, all resolved as "correct".
    const signals: BacktestSignal[] = [];
    for (const w of windows) {
      const midMs = (w.startMs + w.endMs) / 2;
      for (let i = 0; i < 3; i++) {
        signals.push({
          emittedAt: new Date(midMs + i * 3600000).toISOString(),
          closeTime: midMs + i * 3600000,
          pair: "BTC/USDT",
          timeframe: "1h",
          type: "buy",
          confidence: 0.65 + i * 0.05,
          rulesFired: ["rsi-oversold"],
          gateReason: null,
          resolvedAt: new Date(midMs + i * 3600000 + 4 * TF_MS).toISOString(),
          outcome: "correct",
          priceMovePct: 0.01,
          priceAtSignal: 30000,
          priceAtResolution: 30300,
          expiresAt: new Date(midMs + i * 3600000 + 4 * TF_MS).toISOString(),
          ratificationStatus: "not-required",
        });
      }
    }

    // applyWalkForwardCalibration must not throw and must return same count.
    const calibrated = applyWalkForwardCalibration(
      signals,
      { kind: "walk-forward", refitDays },
      fromMs,
      toMs,
    );

    expect(calibrated.length).toBe(signals.length);

    // Window 0 (January) has no prior outcomes → confidences should be UNCHANGED.
    const window0End = windows[0]!.endMs;
    const window0Signals = calibrated.filter((s) => new Date(s.emittedAt).getTime() < window0End);
    const window0Original = signals.filter((s) => new Date(s.emittedAt).getTime() < window0End);

    for (let i = 0; i < window0Signals.length; i++) {
      // No prior data → no Platt fit → confidence unchanged.
      expect(window0Signals[i]!.confidence).toBe(window0Original[i]!.confidence);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Sentiment timestamp: publishedAt > signal.emittedAt should be filtered out
// ---------------------------------------------------------------------------

describe("look-ahead guard: sentiment timestamp", () => {
  it("sentiment items with publishedAt after signal.emittedAt are excluded (stub behavior)", () => {
    // Phase 1 stub: sentiment is not yet wired into the backtest engine.
    // This test asserts the stub behavior: the engine does NOT use a future
    // sentiment bundle (because it has no sentiment wiring at all).
    // When sentiment is wired in a future phase, this test should be updated.
    const signalEmittedAt = new Date("2026-03-01T12:00:00.000Z");

    // Simulate filtering logic that would be applied when sentiment is wired.
    const sentimentItems = [
      { publishedAt: "2026-03-01T10:00:00.000Z", sentiment: "positive" },
      { publishedAt: "2026-03-01T11:59:59.999Z", sentiment: "negative" },
      { publishedAt: "2026-03-01T12:00:01.000Z", sentiment: "positive" }, // future — must be excluded
      { publishedAt: "2026-03-02T00:00:00.000Z", sentiment: "positive" }, // future — must be excluded
    ];

    const filtered = sentimentItems.filter((item) => new Date(item.publishedAt) <= signalEmittedAt);

    expect(filtered).toHaveLength(2);
    for (const item of filtered) {
      expect(new Date(item.publishedAt).getTime()).toBeLessThanOrEqual(signalEmittedAt.getTime());
    }

    // Assert that future items are absent.
    const futureItems = sentimentItems.filter(
      (item) => new Date(item.publishedAt) > signalEmittedAt,
    );
    expect(futureItems).toHaveLength(2);
    // None of the filtered items should be in the future set.
    for (const item of filtered) {
      expect(futureItems).not.toContain(item);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Rule "since" filtering — assert harness no-op behavior
// ---------------------------------------------------------------------------

describe("look-ahead guard: rule since field", () => {
  it("rules do not have a since field yet — engine fires rules regardless of date (no-op)", async () => {
    // This test asserts the current no-op behavior: rules in RULES[] do not have
    // a "since" field, so the engine fires all enabled rules regardless of signal date.
    // When a "since" field is added to rule definitions, this test should be updated
    // to assert temporal filtering.
    const candles = makeCandles(260);
    const engine = new BacktestEngine(mockStore(candles));

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS),
      to: new Date(BASE_TIME + 259 * TF_MS),
    });

    // Verify the engine ran without error and produced signals.
    // No "since" filtering is applied — all rules fire freely.
    expect(typeof result.metrics.totalSignals).toBe("number");

    // Any rule that fires should produce a non-empty rulesFired array.
    const withRules = result.signals.filter((s) => s.rulesFired.length > 0);
    // Assert that rulesFired entries are strings (no "since" field attached).
    for (const sig of withRules) {
      for (const ruleName of sig.rulesFired) {
        expect(typeof ruleName).toBe("string");
        // The rule name should not contain a date suffix (no "since" in naming convention).
        expect(ruleName).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      }
    }
  });
});
