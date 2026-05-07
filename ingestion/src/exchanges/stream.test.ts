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

// watchOHLCV mock: emits one batch then blocks (simulates a live stream).
// We resolve immediately with the provided rows, then never resolve again
// so the while loop exits via abort.
const watchOHLCVMock = vi.fn();
const watchTickerMock = vi.fn();

vi.mock("ccxt", () => {
  const fakeExchangeClass = vi.fn().mockImplementation(() => ({
    has: { watchOHLCV: true, watchTicker: true },
    watchOHLCV: watchOHLCVMock,
    watchTicker: watchTickerMock,
    close: vi.fn().mockResolvedValue(undefined),
  }));

  return {
    default: {
      pro: {
        binanceus: fakeExchangeClass,
        coinbase: fakeExchangeClass,
        kraken: fakeExchangeClass,
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
});

/**
 * Drive one OHLCV batch through the live stream and collect candles
 * that were written to storeCandles.
 *
 * Strategy: resolve watchOHLCV once with the given rows, then make the
 * second call block until we call stop() — the abort signal exits the loop.
 */
async function driveOneOHLCVBatch(rows: unknown[][]): Promise<Candle[]> {
  // First call resolves immediately; subsequent calls block (simulating no more data).
  watchOHLCVMock.mockResolvedValueOnce(rows);
  watchOHLCVMock.mockReturnValue(new Promise(() => {})); // never resolves

  // watchTicker also needs to block; we don't care about it here.
  watchTickerMock.mockReturnValue(new Promise(() => {}));

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
