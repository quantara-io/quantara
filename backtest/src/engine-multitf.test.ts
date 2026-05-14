/**
 * Multi-TF blend engine tests — Phase 2.
 *
 * Tests the new Strategy-driven multi-TF path in BacktestEngine.run().
 * Phase 1 tests in engine.test.ts still run the single-TF path (no strategy).
 */

import { describe, it, expect, vi } from "vitest";
import type { Candle, Timeframe } from "@quantara/shared";

import { BacktestEngine } from "./engine.js";
import type { BacktestInput } from "./engine.js";
import type { HistoricalCandleStore } from "./store/candle-store.js";
import type { Strategy } from "./strategy/types.js";

// ---------------------------------------------------------------------------
// Synthetic candle factory
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TF_MS_15M = 900_000;
const TF_MS_1H = 3_600_000;
const TF_MS_4H = 14_400_000;
const TF_MS_1D = 86_400_000;
const PRODUCTION_EXCHANGES = ["binanceus", "coinbase", "kraken"] as const;

function tfMs(tf: Timeframe): number {
  const map: Record<Timeframe, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": TF_MS_15M,
    "1h": TF_MS_1H,
    "4h": TF_MS_4H,
    "1d": TF_MS_1D,
  };
  return map[tf];
}

function makeCandles(
  count: number,
  tf: Timeframe = "15m",
  baseClose = 30_000,
  exchange = "binanceus",
  pair = "BTC/USDT",
): Candle[] {
  const ms = tfMs(tf);
  return Array.from({ length: count }, (_, i) => {
    const openTime = BASE_TIME + i * ms;
    const closeTime = openTime + ms - 1;
    return {
      exchange,
      symbol: pair,
      pair,
      timeframe: tf,
      openTime,
      closeTime,
      open: baseClose,
      high: baseClose * 1.001,
      low: baseClose * 0.999,
      close: baseClose,
      volume: 100,
      isClosed: true,
      source: "backfill" as const,
    };
  });
}

/**
 * Build a multi-TF mock store that returns synthetic candles for all 4 signal TFs.
 * All exchanges receive the same candles (so canonical median = synthetic value).
 */
function mockMultiTfStore(
  counts: Partial<Record<Timeframe, number>>,
  pair = "BTC/USDT",
): HistoricalCandleStore {
  const perTfPerExchange: Record<string, Record<string, Candle[]>> = {};

  for (const tf of ["15m", "1h", "4h", "1d"] as const) {
    const count = counts[tf] ?? 0;
    const perExchange: Record<string, Candle[]> = {};
    for (const ex of PRODUCTION_EXCHANGES) {
      perExchange[ex] = makeCandles(count, tf, 30_000, ex, pair);
    }
    perTfPerExchange[tf] = perExchange;
  }

  return {
    getCandles: vi.fn().mockResolvedValue([]),
    getCandlesForAllExchanges: vi.fn().mockImplementation(async (_pair: string, tf: Timeframe) => {
      return perTfPerExchange[tf] ?? {};
    }),
  };
}

// ---------------------------------------------------------------------------
// Reference strategy (minimal valid)
// ---------------------------------------------------------------------------

const testStrategy: Strategy = {
  name: "test-blend",
  description: "Test strategy for multi-TF blend tests.",
  exitPolicy: { kind: "n-bars", nBars: 4 },
  sizing: { kind: "fixed-pct", pct: 0.01 },
};

const weightedStrategy: Strategy = {
  name: "1d-heavy",
  description: "1d-heavy for weight override test.",
  timeframeWeights: {
    "1m": 0,
    "5m": 0,
    "15m": 0.05,
    "1h": 0.2,
    "4h": 0.25,
    "1d": 0.5,
  },
  exitPolicy: { kind: "n-bars", nBars: 4 },
  sizing: { kind: "fixed-pct", pct: 0.01 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BacktestEngine multi-TF blend", () => {
  it("returns empty result when store returns no candles for all TFs", async () => {
    const store = mockMultiTfStore({ "15m": 0, "1h": 0, "4h": 0, "1d": 0 });
    const engine = new BacktestEngine(store);

    const input: BacktestInput = {
      pair: "BTC/USDT",
      timeframe: "15m",
      from: new Date(BASE_TIME),
      to: new Date(BASE_TIME + 10 * TF_MS_15M),
      strategy: testStrategy,
    };

    const result = await engine.run(input);

    expect(result.signals).toHaveLength(0);
    expect(result.metrics.totalSignals).toBe(0);
    expect(result.meta.multiTfBlend).toBe(true);
  });

  it("sets meta.multiTfBlend=true and meta.strategyName when strategy is provided", async () => {
    const store = mockMultiTfStore({ "15m": 240, "1h": 60, "4h": 15, "1d": 4 });
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 205 * TF_MS_15M);
    const evalTo = new Date(BASE_TIME + 239 * TF_MS_15M);

    const input: BacktestInput = {
      pair: "BTC/USDT",
      timeframe: "15m",
      from: evalFrom,
      to: evalTo,
      strategy: testStrategy,
    };

    const result = await engine.run(input);

    expect(result.meta.multiTfBlend).toBe(true);
    expect(result.meta.strategyName).toBe("test-blend");
  });

  it("calls getCandlesForAllExchanges for each signal TF (15m, 1h, 4h, 1d)", async () => {
    const store = mockMultiTfStore({ "15m": 240, "1h": 60, "4h": 15, "1d": 4 });
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 205 * TF_MS_15M);
    const evalTo = new Date(BASE_TIME + 239 * TF_MS_15M);

    await engine.run({
      pair: "BTC/USDT",
      timeframe: "15m",
      from: evalFrom,
      to: evalTo,
      strategy: testStrategy,
    });

    // Should have been called once per signal TF.
    expect(store.getCandlesForAllExchanges).toHaveBeenCalledWith(
      "BTC/USDT",
      "15m",
      expect.any(Date),
      expect.any(Date),
    );
    expect(store.getCandlesForAllExchanges).toHaveBeenCalledWith(
      "BTC/USDT",
      "1h",
      expect.any(Date),
      expect.any(Date),
    );
    expect(store.getCandlesForAllExchanges).toHaveBeenCalledWith(
      "BTC/USDT",
      "4h",
      expect.any(Date),
      expect.any(Date),
    );
    expect(store.getCandlesForAllExchanges).toHaveBeenCalledWith(
      "BTC/USDT",
      "1d",
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("signals have ratificationStatus=not-required in algo-only mode", async () => {
    const store = mockMultiTfStore({ "15m": 240, "1h": 60, "4h": 15, "1d": 4 });
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 205 * TF_MS_15M);
    const evalTo = new Date(BASE_TIME + 239 * TF_MS_15M);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "15m",
      from: evalFrom,
      to: evalTo,
      strategy: testStrategy,
    });

    for (const sig of result.signals) {
      expect(sig.ratificationStatus).toBe("not-required");
    }
  });

  it("signals have valid fields in multi-TF mode", async () => {
    const store = mockMultiTfStore({ "15m": 240, "1h": 60, "4h": 15, "1d": 4 });
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 205 * TF_MS_15M);
    const evalTo = new Date(BASE_TIME + 239 * TF_MS_15M);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "15m",
      from: evalFrom,
      to: evalTo,
      strategy: testStrategy,
    });

    for (const sig of result.signals) {
      expect(sig.pair).toBe("BTC/USDT");
      expect(["strong-buy", "buy", "hold", "sell", "strong-sell"]).toContain(sig.type);
      expect(sig.confidence).toBeGreaterThanOrEqual(0);
      expect(sig.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(sig.rulesFired)).toBe(true);
      expect(sig.priceAtSignal).toBeGreaterThan(0);
      expect(typeof sig.expiresAt).toBe("string");
      expect(typeof sig.emittedAt).toBe("string");
    }
  });

  it("strategy weight override is accepted without crash (1d-heavy)", async () => {
    const store = mockMultiTfStore({ "15m": 240, "1h": 60, "4h": 15, "1d": 4 });
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 205 * TF_MS_15M);
    const evalTo = new Date(BASE_TIME + 230 * TF_MS_15M);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "15m",
      from: evalFrom,
      to: evalTo,
      strategy: weightedStrategy,
    });

    expect(result.meta.strategyName).toBe("1d-heavy");
    // Weight override should not cause a crash; signal count may differ from default.
    expect(typeof result.metrics.totalSignals).toBe("number");
  });

  it("single-TF run (no strategy) does NOT set multiTfBlend", async () => {
    // Phase 1 compat: single-TF run without strategy should produce a result
    // without meta.multiTfBlend.
    const candles = makeCandles(240, "1h");
    const perExchange: Record<string, Candle[]> = {};
    for (const ex of PRODUCTION_EXCHANGES) {
      perExchange[ex] = candles.map((c) => ({ ...c, exchange: ex }));
    }
    const store: HistoricalCandleStore = {
      getCandles: vi.fn().mockResolvedValue([]),
      getCandlesForAllExchanges: vi.fn().mockResolvedValue(perExchange),
    };
    const engine = new BacktestEngine(store);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS_1H),
      to: new Date(BASE_TIME + 239 * TF_MS_1H),
    });

    // No strategy → single-TF mode → multiTfBlend should be absent/undefined.
    expect(result.meta.multiTfBlend).toBeUndefined();
  });

  it("byOutcome sums to totalSignals in multi-TF mode", async () => {
    const store = mockMultiTfStore({ "15m": 280, "1h": 70, "4h": 18, "1d": 5 });
    const engine = new BacktestEngine(store);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "15m",
      from: new Date(BASE_TIME + 205 * TF_MS_15M),
      to: new Date(BASE_TIME + 279 * TF_MS_15M),
      strategy: testStrategy,
    });

    const { byOutcome, totalSignals } = result.metrics;
    const sum = byOutcome.correct + byOutcome.incorrect + byOutcome.neutral + byOutcome.unresolved;
    expect(sum).toBe(totalSignals);
  });

  it("expiresAt uses strategy.exitPolicy.nBars=8 (not the hardcoded 4)", async () => {
    // Provide enough candles so the engine emits at least one signal.
    const store = mockMultiTfStore({ "15m": 280, "1h": 70, "4h": 18, "1d": 5 });
    const engine = new BacktestEngine(store);

    const eightBarStrategy: Strategy = {
      name: "8-bar-hold",
      description: "Strategy with nBars=8 exit policy.",
      exitPolicy: { kind: "n-bars", nBars: 8 },
      sizing: { kind: "fixed-pct", pct: 0.01 },
    };

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "15m",
      from: new Date(BASE_TIME + 205 * TF_MS_15M),
      to: new Date(BASE_TIME + 279 * TF_MS_15M),
      strategy: eightBarStrategy,
    });

    // Every signal must expire exactly 8 × 15m after its closeTime.
    expect(result.signals.length).toBeGreaterThan(0);
    for (const sig of result.signals) {
      const expiresMs = new Date(sig.expiresAt).getTime();
      expect(expiresMs - sig.closeTime).toBe(8 * TF_MS_15M);
    }
  });

  it("expiresAt uses strategy.exitPolicy.nBars=4 (default baseline)", async () => {
    // Symmetry check: nBars=4 produces the same result as the legacy hardcoded constant.
    const store = mockMultiTfStore({ "15m": 280, "1h": 70, "4h": 18, "1d": 5 });
    const engine = new BacktestEngine(store);

    const fourBarStrategy: Strategy = {
      name: "4-bar-hold",
      description: "Strategy with nBars=4 exit policy (default equivalent).",
      exitPolicy: { kind: "n-bars", nBars: 4 },
      sizing: { kind: "fixed-pct", pct: 0.01 },
    };

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "15m",
      from: new Date(BASE_TIME + 205 * TF_MS_15M),
      to: new Date(BASE_TIME + 279 * TF_MS_15M),
      strategy: fourBarStrategy,
    });

    expect(result.signals.length).toBeGreaterThan(0);
    for (const sig of result.signals) {
      const expiresMs = new Date(sig.expiresAt).getTime();
      expect(expiresMs - sig.closeTime).toBe(4 * TF_MS_15M);
    }
  });
});
