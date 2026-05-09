import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Candle } from "@quantara/shared";

// Mock I/O dependencies before importing the SUT.
const storeCandelsMock = vi.fn().mockResolvedValue(undefined);
const storePriceSnapshotsMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/candle-store.js", () => ({
  storeCandles: storeCandelsMock,
}));

vi.mock("../lib/store.js", () => ({
  storePriceSnapshots: storePriceSnapshotsMock,
}));

// watchOHLCV / watchTicker mocks for WS-capable exchanges (binanceus, kraken).
const watchOHLCVMock = vi.fn();
const watchTickerMock = vi.fn();

// fetchOHLCV mock for the Coinbase REST backfill loop.
const fetchOHLCVMock = vi.fn();

vi.mock("ccxt", () => {
  // Exchanges that support watchOHLCV (binanceus, kraken).
  const wsExchangeClass = vi.fn().mockImplementation(() => ({
    has: { watchOHLCV: true, watchTicker: true },
    watchOHLCV: watchOHLCVMock,
    watchTicker: watchTickerMock,
    close: vi.fn().mockResolvedValue(undefined),
  }));

  // Coinbase: no watchOHLCV, but has fetchOHLCV for REST polling.
  const coinbaseExchangeClass = vi.fn().mockImplementation(() => ({
    has: { watchOHLCV: false, watchTicker: true },
    watchTicker: watchTickerMock,
    fetchOHLCV: fetchOHLCVMock,
    close: vi.fn().mockResolvedValue(undefined),
  }));

  return {
    default: {
      pro: {
        binanceus: wsExchangeClass,
        coinbase: coinbaseExchangeClass,
        kraken: wsExchangeClass,
      },
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  storeCandelsMock.mockReset().mockResolvedValue(undefined);
  storePriceSnapshotsMock.mockReset().mockResolvedValue(undefined);
  watchOHLCVMock.mockReset();
  watchTickerMock.mockReset();
  fetchOHLCVMock.mockReset();
});

/**
 * Drive one OHLCV batch through the live stream (binanceus + kraken) and
 * collect candles that were written to storeCandles.
 *
 * Strategy: resolve watchOHLCV once with the given rows, then make the
 * second call block until we call stop() — the abort signal exits the loop.
 * fetchOHLCV (Coinbase REST path) is made to block throughout so it doesn't
 * interfere with the candle count assertions.
 */
async function driveOneOHLCVBatch(rows: unknown[][]): Promise<Candle[]> {
  // First call resolves immediately; subsequent calls block (simulating no more data).
  watchOHLCVMock.mockResolvedValueOnce(rows);
  watchOHLCVMock.mockReturnValue(new Promise(() => {})); // never resolves

  // watchTicker also needs to block; we don't care about it here.
  watchTickerMock.mockReturnValue(new Promise(() => {}));

  // Coinbase REST backfill: block so it never writes in this helper.
  fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

  const { MarketStreamManager } = await import("./stream.js");
  const manager = new MarketStreamManager();
  await manager.start();

  // Give the async stream loops one event-loop tick to process the first batch.
  await new Promise((resolve) => setTimeout(resolve, 10));

  await manager.stop();

  // Collect all candles passed to storeCandles across all calls.
  const allCandles: Candle[] = [];
  for (const call of storeCandelsMock.mock.calls) {
    allCandles.push(...(call[0] as Candle[]));
  }
  return allCandles;
}

describe("MarketStreamManager — OHLCV numeric coercion", () => {
  it("stores candles with number-typed fields when CCXT returns string values (Kraken pattern)", async () => {
    const now = Date.now();
    // Two-minute-old candle so isClosed = true and it gets stored.
    const openTime = now - 120_000;

    // Kraken's CCXT client returns OHLCV values as strings.
    const stringRow = [openTime, "79757.2", "79800.0", "79700.5", "79780.1", "12.345"];

    const candles = await driveOneOHLCVBatch([stringRow]);

    // Should have received at least one candle (one per exchange × pair that processed the row).
    expect(candles.length).toBeGreaterThan(0);

    for (const candle of candles) {
      expect(typeof candle.open, "open must be a number").toBe("number");
      expect(typeof candle.high, "high must be a number").toBe("number");
      expect(typeof candle.low, "low must be a number").toBe("number");
      expect(typeof candle.close, "close must be a number").toBe("number");
      expect(typeof candle.volume, "volume must be a number").toBe("number");

      // Values must parse correctly and not be NaN.
      expect(Number.isNaN(candle.open)).toBe(false);
      expect(Number.isNaN(candle.close)).toBe(false);
    }

    // Spot-check the first candle's values.
    const first = candles[0];
    expect(first.open).toBe(79757.2);
    expect(first.close).toBe(79780.1);
  });

  it("stores candles with number-typed fields when CCXT returns number values (Binance pattern)", async () => {
    const now = Date.now();
    const openTime = now - 120_000;

    const numberRow = [openTime, 79668.35, 79710.0, 79600.0, 79680.0, 8.5];
    const candles = await driveOneOHLCVBatch([numberRow]);

    expect(candles.length).toBeGreaterThan(0);
    for (const candle of candles) {
      expect(typeof candle.open).toBe("number");
      expect(typeof candle.close).toBe("number");
    }
    expect(candles[0].open).toBe(79668.35);
  });

  it("coerces null fields to 0 without producing NaN", async () => {
    const now = Date.now();
    const openTime = now - 120_000;

    const nullRow = [openTime, null, null, null, null, null];
    const candles = await driveOneOHLCVBatch([nullRow]);

    expect(candles.length).toBeGreaterThan(0);
    for (const candle of candles) {
      expect(candle.open).toBe(0);
      expect(candle.high).toBe(0);
      expect(candle.low).toBe(0);
      expect(candle.close).toBe(0);
      expect(candle.volume).toBe(0);
      expect(Number.isNaN(candle.open)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// startCoinbaseBackfillLoop
// ---------------------------------------------------------------------------

/**
 * Helper: start the manager with the given fetchOHLCV behaviour, let the
 * backfill loop run for a few ticks, then stop. Returns candles stored.
 *
 * watchOHLCV and watchTicker are made to block indefinitely so they don't
 * interfere with storeCandles call counts.
 */
async function driveCoinbaseBackfill(): Promise<Candle[]> {
  watchOHLCVMock.mockReturnValue(new Promise(() => {}));
  watchTickerMock.mockReturnValue(new Promise(() => {}));

  const { MarketStreamManager } = await import("./stream.js");
  const manager = new MarketStreamManager();
  await manager.start();

  // Give the backfill loops time to process their first fetchOHLCV call.
  await new Promise((resolve) => setTimeout(resolve, 20));

  await manager.stop();

  const allCandles: Candle[] = [];
  for (const call of storeCandelsMock.mock.calls) {
    allCandles.push(...(call[0] as Candle[]));
  }
  return allCandles;
}

describe("MarketStreamManager — Coinbase REST backfill loop", () => {
  it("writes the closed bar (index 0) and skips the open bar (index 1)", async () => {
    const now = Date.now();
    // Bar 0: closed (openTime is 2 minutes ago).
    const closedOpenTime = now - 120_000;
    // Bar 1: currently open (openTime is 30s ago).
    const openOpenTime = now - 30_000;

    const closedBar = [closedOpenTime, 50000, 50100, 49900, 50050, 1.5];
    const openBar = [openOpenTime, 50060, 50080, 50010, 50070, 0.8];

    // First fetchOHLCV resolves with [closedBar, openBar]; subsequent calls block.
    fetchOHLCVMock.mockResolvedValueOnce([closedBar, openBar]);
    fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

    const candles = await driveCoinbaseBackfill();

    // Only the closed bar should be written; the open bar is ignored.
    const coinbaseCandles = candles.filter((c) => c.exchange === "coinbase");
    // 5 pairs × 1 write each.
    expect(coinbaseCandles.length).toBeGreaterThan(0);

    for (const candle of coinbaseCandles) {
      expect(candle.exchange).toBe("coinbase");
      expect(candle.isClosed).toBe(true);
      expect(candle.openTime).toBe(closedOpenTime);
      expect(candle.closeTime).toBe(closedOpenTime + 60_000);
      expect(candle.source).toBe("live");
      expect(candle.timeframe).toBe("1m");
    }
  });

  it("applies Number() coercion to string-typed OHLCV values", async () => {
    const now = Date.now();
    const closedOpenTime = now - 120_000;

    const closedBar = [closedOpenTime, "50000.5", "50100.0", "49900.25", "50050.75", "1.23456"];
    const openBar = [now - 30_000, "50060", "50080", "50010", "50070", "0.5"];

    fetchOHLCVMock.mockResolvedValueOnce([closedBar, openBar]);
    fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

    const candles = await driveCoinbaseBackfill();
    const coinbaseCandles = candles.filter((c) => c.exchange === "coinbase");

    expect(coinbaseCandles.length).toBeGreaterThan(0);
    for (const candle of coinbaseCandles) {
      expect(typeof candle.open).toBe("number");
      expect(typeof candle.high).toBe("number");
      expect(typeof candle.low).toBe("number");
      expect(typeof candle.close).toBe("number");
      expect(typeof candle.volume).toBe("number");
      expect(Number.isNaN(candle.open)).toBe(false);
    }
    expect(coinbaseCandles[0].open).toBe(50000.5);
    expect(coinbaseCandles[0].close).toBe(50050.75);
  });

  it("skips writing when the same closeTime is seen twice (idempotent)", async () => {
    const now = Date.now();
    const closedOpenTime = now - 120_000;
    const closedBar = [closedOpenTime, 50000, 50100, 49900, 50050, 1.5];
    const openBar = [now - 30_000, 50060, 50080, 50010, 50070, 0.8];

    // Both calls resolve immediately with the same closed bar.
    fetchOHLCVMock.mockResolvedValueOnce([closedBar, openBar]);
    fetchOHLCVMock.mockResolvedValueOnce([closedBar, openBar]);
    // Further calls block.
    fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

    // Allow enough time for two poll cycles.
    watchOHLCVMock.mockReturnValue(new Promise(() => {}));
    watchTickerMock.mockReturnValue(new Promise(() => {}));

    const { MarketStreamManager } = await import("./stream.js");
    const manager = new MarketStreamManager();
    await manager.start();

    // Wait long enough for two fetch cycles to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await manager.stop();

    const allCandles: Candle[] = [];
    for (const call of storeCandelsMock.mock.calls) {
      allCandles.push(...(call[0] as Candle[]));
    }

    const coinbaseCandles = allCandles.filter((c) => c.exchange === "coinbase");
    const uniquePairs = new Set(coinbaseCandles.map((c) => c.pair));

    // Each pair should have been written exactly once despite two fetches.
    for (const pair of uniquePairs) {
      const forPair = coinbaseCandles.filter((c) => c.pair === pair);
      expect(forPair.length).toBe(1);
    }
  });

  it("continues writing other pairs when one pair's fetchOHLCV throws", async () => {
    const now = Date.now();
    const closedOpenTime = now - 120_000;
    const closedBar = [closedOpenTime, 50000, 50100, 49900, 50050, 1.5];
    const openBar = [now - 30_000, 50060, 50080, 50010, 50070, 0.8];

    // First call throws (simulating one pair failing); rest succeed.
    fetchOHLCVMock
      .mockRejectedValueOnce(new Error("REST timeout"))
      .mockResolvedValue([closedBar, openBar]);

    const candles = await driveCoinbaseBackfill();

    // Even with the first call failing, storeCandles should still have been
    // called for the remaining pairs.
    const coinbaseCandles = candles.filter((c) => c.exchange === "coinbase");
    expect(coinbaseCandles.length).toBeGreaterThan(0);
  });
});
