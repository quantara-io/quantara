import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external I/O dependencies before importing the SUT.
const storeCandlesConditionalMock = vi.fn().mockResolvedValue(undefined);
const archiveCandlesMock = vi.fn().mockResolvedValue(undefined);
const getCursorMock = vi.fn().mockResolvedValue(null);
const saveCursorMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/candle-store.js", () => ({
  storeCandlesConditional: storeCandlesConditionalMock,
}));

vi.mock("../lib/s3-archive.js", () => ({
  archiveCandles: archiveCandlesMock,
}));

vi.mock("../lib/metadata-store.js", () => ({
  getCursor: getCursorMock,
  saveCursor: saveCursorMock,
}));

// Fake CCXT exchange: fetchOHLCV returns one row with string-typed OHLCV values.
// This mirrors what Kraken's CCXT client actually returns.
const fetchOHLCVMock = vi.fn();

vi.mock("ccxt", () => {
  const fakeExchangeClass = vi.fn().mockImplementation(() => ({
    fetchOHLCV: fetchOHLCVMock,
  }));
  return {
    default: {
      kraken: fakeExchangeClass,
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  storeCandlesConditionalMock.mockReset().mockResolvedValue(undefined);
  archiveCandlesMock.mockReset().mockResolvedValue(undefined);
  getCursorMock.mockReset().mockResolvedValue(null);
  saveCursorMock.mockReset().mockResolvedValue(undefined);
  fetchOHLCVMock.mockReset();
});

describe("backfillCandles — OHLCV numeric coercion", () => {
  it("stores candles with number-typed fields when CCXT returns string values (Kraken pattern)", async () => {
    const now = Date.now();
    const openTime = now - 120_000; // 2 min ago so isClosed = true

    // Kraken's CCXT client returns OHLCV fields as strings.
    const stringRow = [openTime, "79757.2", "79800.0", "79700.5", "79780.1", "12.345"];

    // First call returns one row; second call returns empty to end the while loop.
    fetchOHLCVMock.mockResolvedValueOnce([stringRow]).mockResolvedValueOnce([]);

    const { backfillCandles } = await import("./backfill.js");
    await backfillCandles({
      exchangeId: "kraken",
      pair: "BTC/USDT",
      timeframe: "1m",
      days: 1,
      archiveToS3: false,
    });

    expect(storeCandlesConditionalMock).toHaveBeenCalledOnce();
    const [candles] = storeCandlesConditionalMock.mock.calls[0] as [
      import("@quantara/shared").Candle[],
    ];
    expect(candles).toHaveLength(1);

    const candle = candles[0];
    expect(typeof candle.open).toBe("number");
    expect(typeof candle.high).toBe("number");
    expect(typeof candle.low).toBe("number");
    expect(typeof candle.close).toBe("number");
    expect(typeof candle.volume).toBe("number");

    // Verify the parsed values are correct numbers (not NaN).
    expect(candle.open).toBe(79757.2);
    expect(candle.high).toBe(79800.0);
    expect(candle.low).toBe(79700.5);
    expect(candle.close).toBe(79780.1);
    expect(candle.volume).toBe(12.345);
  });

  it("stores candles with number-typed fields when CCXT returns number values (Binance pattern)", async () => {
    const now = Date.now();
    const openTime = now - 120_000;

    // Binance returns OHLCV as numbers — must still work correctly.
    const numberRow = [openTime, 79668.35, 79710.0, 79600.0, 79680.0, 8.5];

    fetchOHLCVMock.mockResolvedValueOnce([numberRow]).mockResolvedValueOnce([]);

    const { backfillCandles } = await import("./backfill.js");
    await backfillCandles({
      exchangeId: "kraken",
      pair: "BTC/USDT",
      timeframe: "1m",
      days: 1,
      archiveToS3: false,
    });

    expect(storeCandlesConditionalMock).toHaveBeenCalledOnce();
    const [candles] = storeCandlesConditionalMock.mock.calls[0] as [
      import("@quantara/shared").Candle[],
    ];
    const candle = candles[0];

    expect(typeof candle.open).toBe("number");
    expect(typeof candle.close).toBe("number");
    expect(candle.open).toBe(79668.35);
  });

  it("coerces null/undefined fields to 0 without producing NaN", async () => {
    const now = Date.now();
    const openTime = now - 120_000;

    // Simulate a row where some OHLCV fields are null.
    const nullRow = [openTime, null, null, null, null, null];

    fetchOHLCVMock.mockResolvedValueOnce([nullRow]).mockResolvedValueOnce([]);

    const { backfillCandles } = await import("./backfill.js");
    await backfillCandles({
      exchangeId: "kraken",
      pair: "BTC/USDT",
      timeframe: "1m",
      days: 1,
      archiveToS3: false,
    });

    const [candles] = storeCandlesConditionalMock.mock.calls[0] as [
      import("@quantara/shared").Candle[],
    ];
    const candle = candles[0];

    expect(candle.open).toBe(0);
    expect(candle.high).toBe(0);
    expect(candle.low).toBe(0);
    expect(candle.close).toBe(0);
    expect(candle.volume).toBe(0);
    expect(Number.isNaN(candle.open)).toBe(false);
  });
});
