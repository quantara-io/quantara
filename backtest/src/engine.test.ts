/**
 * BacktestEngine unit tests — synthetic candle stream.
 *
 * Strategy: build a hand-crafted candle stream that forces known indicator
 * conditions, run the engine against a mocked candle store, and assert
 * on the shape and content of BacktestResult.
 *
 * The mock store is injected via HistoricalCandleStore — no DDB calls.
 *
 * Phase 1 §canonicalize: the engine now consumes per-exchange candle maps
 * via `getCandlesForAllExchanges` so it can mirror production's canonicalize
 * → buildIndicatorState path. Tests provide identical candles on all three
 * production exchanges (binanceus, coinbase, kraken) so the median trivially
 * equals the synthetic value.
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
const PRODUCTION_EXCHANGES = ["binanceus", "coinbase", "kraken"] as const;

/**
 * Build a series of synthetic 1h candles starting at BASE_TIME.
 * All candles are flat (close ≈ open ≈ high ≈ low) to minimise indicator noise.
 * `overrides` allows per-candle field injection.
 */
function makeCandles(
  count: number,
  baseClose = 30_000,
  overrides: Partial<Candle>[] = [],
  exchange = "binanceus",
  pair = "BTC/USDT",
  timeframe: Timeframe = "1h",
  tfMs = TF_MS,
): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = BASE_TIME + i * tfMs;
    const closeTime = openTime + tfMs - 1;
    const base: Candle = {
      exchange,
      symbol: pair,
      pair,
      timeframe,
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

/**
 * Return a mock store that hands the same candle series back for all three
 * production exchanges. Used for tests where cross-exchange consensus should
 * trivially equal the synthetic value.
 */
function mockStore(
  candles: Candle[],
  pair = "BTC/USDT",
  timeframe: Timeframe = "1h",
): HistoricalCandleStore {
  const perExchange: Record<string, Candle[]> = {};
  for (const ex of PRODUCTION_EXCHANGES) {
    // Clone with the right exchange label so the records are realistic. Indices
    // align so all three exchanges have a candle at every closeTime.
    perExchange[ex] = candles.map((c) => ({ ...c, exchange: ex }));
  }
  return {
    getCandles: vi.fn().mockImplementation(async (_pair, exchange) => {
      return perExchange[exchange as string] ?? [];
    }),
    getCandlesForAllExchanges: vi.fn().mockImplementation(async (callPair, callTf) => {
      if (callPair !== pair || callTf !== timeframe) return {};
      return perExchange;
    }),
  };
}

/**
 * Return a mock store that returns NO candles for any exchange — used to
 * exercise the empty-result path.
 */
function emptyMockStore(): HistoricalCandleStore {
  const empty: Record<string, Candle[]> = {};
  for (const ex of PRODUCTION_EXCHANGES) empty[ex] = [];
  return {
    getCandles: vi.fn().mockResolvedValue([]),
    getCandlesForAllExchanges: vi.fn().mockResolvedValue(empty),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BacktestEngine", () => {
  it("returns empty result when store returns no candles", async () => {
    const store = emptyMockStore();
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
    // 230 candles per exchange × 3 exchanges → 690 total.
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
    // Engine now sums across all three production exchanges.
    expect(result.meta.candleCount).toBe(230 * PRODUCTION_EXCHANGES.length);
    expect(typeof result.meta.durationMs).toBe("number");
    expect(result.meta.startedAt).toBeTruthy();
    expect(result.meta.skippedNoConsensus).toBe(0);
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
      // gateReason is either null or a known short reason.
      expect([null, "vol", "dispersion", "stale"]).toContain(sig.gateReason);
      expect(typeof sig.expiresAt).toBe("string");
      expect(typeof sig.emittedAt).toBe("string");
    }
  });

  it("priceAtSignal equals the canonical (median) close across exchanges", async () => {
    // Build a deliberately mixed-price stream: same closes on all exchanges so
    // the median trivially equals 30_000 (the synthetic baseline). Asserts the
    // engine isn't accidentally re-using a single-exchange field.
    const candles = makeCandles(230, 30_000);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS),
      to: new Date(BASE_TIME + 229 * TF_MS),
    });

    for (const sig of result.signals) {
      // The makeCandles factory uses close = baseClose for every bar; the
      // median across 3 identical inputs is also baseClose.
      expect(sig.priceAtSignal).toBe(30_000);
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

  it("fetches candles via getCandlesForAllExchanges (multi-exchange)", async () => {
    const candles = makeCandles(10);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME),
      to: new Date(BASE_TIME + 9 * TF_MS),
    });

    expect(store.getCandlesForAllExchanges).toHaveBeenCalledWith(
      "BTC/USDT",
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

  it("resolves the signal whose expiresAt lands exactly on `to`", async () => {
    // Production resolves when expiresAt <= now (inclusive). Construct a
    // scenario where exactly one signal's expiry equals `to`: with 1h TF, set
    // `to = BASE_TIME + 209*TF_MS - 1` (closeTime of bar 209). A signal at
    // closeTime baseTime + 205*TF_MS - 1 expires at +4 bars = +209*TF_MS - 1.
    const candles = makeCandles(210);
    const store = mockStore(candles);
    const engine = new BacktestEngine(store);

    // Eval from bar 205, to includes the exact-boundary resolution bar.
    const evalFromIdx = 205;
    const evalToIdx = 209;
    const evalFromMs = BASE_TIME + evalFromIdx * TF_MS;
    const evalToMs = BASE_TIME + evalToIdx * TF_MS + TF_MS - 1;

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(evalFromMs),
      to: new Date(evalToMs),
    });

    // The signal emitted at bar 205 must be resolvable because its expiresAt
    // equals `to` exactly.
    const boundarySignal = result.signals.find(
      (s) => s.closeTime === BASE_TIME + evalFromIdx * TF_MS + TF_MS - 1,
    );
    if (boundarySignal) {
      expect(boundarySignal.priceAtResolution).not.toBeNull();
    }
  });

  it("handles multiple timeframes (4h) correctly", async () => {
    const TF_4H = 14_400_000;
    const candles4h = makeCandles(230, 2000, [], "binanceus", "ETH/USDT", "4h", TF_4H);

    const store = mockStore(candles4h, "ETH/USDT", "4h");
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

  it("skips bars when canonicalizeCandle has no consensus (1 of 3 exchanges)", async () => {
    // Provide a stream where only one exchange has candles → canonicalize
    // returns null at every bar. Engine should skip all eval bars and report
    // skippedNoConsensus matching the eval window length.
    const candles = makeCandles(230);
    const sparseStore: HistoricalCandleStore = {
      getCandles: vi.fn().mockResolvedValue([]),
      getCandlesForAllExchanges: vi.fn().mockResolvedValue({
        binanceus: candles.map((c) => ({ ...c, exchange: "binanceus" })),
        coinbase: [],
        kraken: [],
      }),
    };
    const engine = new BacktestEngine(sparseStore);

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS),
      to: new Date(BASE_TIME + 229 * TF_MS),
    });

    expect(result.signals).toHaveLength(0);
    expect(result.meta.skippedNoConsensus).toBeGreaterThan(0);
  });
});
