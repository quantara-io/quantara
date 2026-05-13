/**
 * BacktestEngine unit tests — synthetic candle stream.
 *
 * Strategy: build a hand-crafted candle stream that forces known indicator
 * conditions, run the engine against a mocked candle store, and assert
 * on the shape and content of BacktestResult.
 *
 * The mock store is injected via HistoricalCandleStore — no DDB calls.
 */

import { describe, it, expect, vi } from "vitest";
import type { Candle, Timeframe } from "@quantara/shared";

import type { BacktestInput, BacktestResult } from "./engine.js";
import { BacktestEngine } from "./engine.js";
import type { HistoricalCandleStore } from "./store/candle-store.js";

// ---------------------------------------------------------------------------
// Synthetic candle factory
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000; // arbitrary fixed epoch
const TF_MS = 3_600_000; // 1h

/**
 * Build a series of synthetic 1h candles starting at BASE_TIME.
 * All candles are flat (close ≈ open ≈ high ≈ low) to minimise indicator noise.
 * `overrides` allows per-candle field injection (e.g., RSI-driving volume spikes).
 */
function makeCandles(
  count: number,
  baseClose = 30_000,
  overrides: Partial<Candle>[] = [],
): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = BASE_TIME + i * TF_MS;
    const closeTime = openTime + TF_MS - 1;
    const base: Candle = {
      exchange: "binance",
      symbol: "BTC/USDT",
      pair: "BTC/USDT",
      timeframe: "1h",
      openTime,
      closeTime,
      open: baseClose,
      high: baseClose * 1.001,
      low: baseClose * 0.999,
      close: baseClose,
      volume: 100,
      isClosed: true,
      source: "backfill",
    };
    return { ...base, ...(overrides[i] ?? {}) };
  });
}

// ---------------------------------------------------------------------------
// Mock store helpers
// ---------------------------------------------------------------------------

function mockStore(candles: Candle[]): HistoricalCandleStore {
  return {
    getCandles: vi.fn().mockResolvedValue(candles),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BacktestEngine", () => {
  it("returns empty result when store returns no candles", async () => {
    const store = mockStore([]);
    const engine = new BacktestEngine(store);

    const input: BacktestInput = {
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME),
      to: new Date(BASE_TIME + 10 * TF_MS),
    };

    const result: BacktestResult = await engine.run(input);

    expect(result.signals).toHaveLength(0);
    expect(result.metrics.totalSignals).toBe(0);
    expect(result.metrics.brierScore).toBeNull();
    expect(result.metrics.winRate).toBeNull();
    expect(result.meta.candleCount).toBe(0);
  });

  it("produces a BacktestResult with meta fields when candles are provided", async () => {
    // 230 candles: 205 warmup + 25 evaluation candles.
    const candles = makeCandles(230);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 205 * TF_MS);
    const evalTo = new Date(BASE_TIME + 229 * TF_MS);

    const input: BacktestInput = {
      pair: "BTC/USDT",
      timeframe: "1h",
      from: evalFrom,
      to: evalTo,
    };

    const result = await engine.run(input);

    expect(result.meta.pair).toBe("BTC/USDT");
    expect(result.meta.timeframe).toBe("1h");
    expect(result.meta.candleCount).toBe(230);
    expect(typeof result.meta.durationMs).toBe("number");
    expect(result.meta.startedAt).toBeTruthy();
  });

  it("signals have required fields and valid types", async () => {
    const candles = makeCandles(230);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 205 * TF_MS);
    const evalTo = new Date(BASE_TIME + 229 * TF_MS);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: evalFrom,
      to: evalTo,
    });

    for (const sig of result.signals) {
      expect(sig.pair).toBe("BTC/USDT");
      expect(sig.timeframe).toBe("1h");
      expect(["strong-buy", "buy", "hold", "sell", "strong-sell"]).toContain(sig.type);
      expect(sig.confidence).toBeGreaterThanOrEqual(0);
      expect(sig.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(sig.rulesFired)).toBe(true);
      expect(sig.priceAtSignal).toBeGreaterThan(0);
      expect(typeof sig.expiresAt).toBe("string");
      expect(typeof sig.emittedAt).toBe("string");
    }
  });

  it("metrics totalSignals matches signals array length", async () => {
    const candles = makeCandles(230);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS),
      to: new Date(BASE_TIME + 229 * TF_MS),
    });

    expect(result.metrics.totalSignals).toBe(result.signals.length);
  });

  it("resolved signals have outcome and priceAtResolution set", async () => {
    // Use 260 candles: warmup (205) + eval (55) so some signals expire before `to`.
    const candles = makeCandles(260);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    const evalFrom = new Date(BASE_TIME + 205 * TF_MS);
    const evalTo = new Date(BASE_TIME + 259 * TF_MS);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: evalFrom,
      to: evalTo,
    });

    const resolved = result.signals.filter((s) => s.outcome !== null);
    for (const s of resolved) {
      expect(s.resolvedAt).toBeTruthy();
      expect(s.priceAtResolution).not.toBeNull();
      expect(s.priceMovePct).not.toBeNull();
      expect(["correct", "incorrect", "neutral"]).toContain(s.outcome);
    }
  });

  it("byOutcome sums to totalSignals", async () => {
    const candles = makeCandles(260);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS),
      to: new Date(BASE_TIME + 259 * TF_MS),
    });

    const { byOutcome, totalSignals } = result.metrics;
    const sum = byOutcome.correct + byOutcome.incorrect + byOutcome.neutral + byOutcome.unresolved;
    expect(sum).toBe(totalSignals);
  });

  it("uses default exchange 'binance' when not specified", async () => {
    const candles = makeCandles(10);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME),
      to: new Date(BASE_TIME + 9 * TF_MS),
    });

    // The store.getCandles should have been called with 'binance'.
    expect(store.getCandles).toHaveBeenCalledWith(
      "BTC/USDT",
      "binance",
      "1h",
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("respects custom exchange parameter", async () => {
    const candles = makeCandles(10);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    await engine.run({
      pair: "BTC/USDT",
      exchange: "kraken",
      timeframe: "1h",
      from: new Date(BASE_TIME),
      to: new Date(BASE_TIME + 9 * TF_MS),
    });

    expect(store.getCandles).toHaveBeenCalledWith(
      "BTC/USDT",
      "kraken",
      "1h",
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("expiresAt is 4 bars after closeTime", async () => {
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
      const expiresMs = new Date(sig.expiresAt).getTime();
      const expectedExpiry = sig.closeTime + 4 * TF_MS;
      expect(expiresMs).toBe(expectedExpiry);
    }
  });

  it("handles multiple timeframes (4h) correctly", async () => {
    const TF_4H = 14_400_000;
    const candles4h: Candle[] = Array.from({ length: 230 }, (_, i) => {
      const openTime = BASE_TIME + i * TF_4H;
      return {
        exchange: "binance",
        symbol: "ETH/USDT",
        pair: "ETH/USDT",
        timeframe: "4h" as Timeframe,
        openTime,
        closeTime: openTime + TF_4H - 1,
        open: 2000,
        high: 2010,
        low: 1990,
        close: 2000,
        volume: 500,
        isClosed: true,
        source: "backfill" as const,
      };
    });

    const store = mockStore(candles4h);
    const engine = new BacktestEngine(store);

    const result = await engine.run({
      pair: "ETH/USDT",
      timeframe: "4h",
      from: new Date(BASE_TIME + 205 * TF_4H),
      to: new Date(BASE_TIME + 229 * TF_4H),
    });

    expect(result.meta.timeframe).toBe("4h");
    // Expiry should be 4 × 4h = 16h per signal.
    for (const sig of result.signals) {
      const expiresMs = new Date(sig.expiresAt).getTime();
      expect(expiresMs).toBe(sig.closeTime + 4 * TF_4H);
    }
  });
});
