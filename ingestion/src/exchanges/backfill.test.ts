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

describe("backfillCandles — force flag", () => {
  it("ignores the saved cursor and uses days lookback when force=true", async () => {
    const now = Date.now();
    // Cursor was saved at "yesterday" — without force, since would start from there.
    const cursorTs = new Date(now - 24 * 3600 * 1000).toISOString();
    getCursorMock.mockResolvedValue({
      lastTimestamp: cursorTs,
      status: "complete",
      updatedAt: new Date().toISOString(),
      metadata: {},
    });

    // Return one row on the first fetch, then empty to end the loop.
    const openTime = now - 91 * 86400 * 1000;
    fetchOHLCVMock
      .mockResolvedValueOnce([[openTime, "100", "110", "90", "105", "5"]])
      .mockResolvedValueOnce([]);

    const { backfillCandles } = await import("./backfill.js");
    await backfillCandles({
      exchangeId: "kraken",
      pair: "BTC/USDT",
      timeframe: "1m",
      days: 90,
      force: true,
      archiveToS3: false,
    });

    // fetchOHLCV should have been called with a `since` ≈ now - 90d, NOT the cursor.
    const firstCallSince = fetchOHLCVMock.mock.calls[0][2] as number;
    const expectedSince = now - 90 * 86400 * 1000;

    // Allow 5 s of clock drift between when `now` was captured in the test vs the SUT.
    expect(Math.abs(firstCallSince - expectedSince)).toBeLessThan(5_000);
    // Confirm it is NOT starting from the cursor timestamp.
    const cursorSince = new Date(cursorTs).getTime();
    expect(firstCallSince).toBeLessThan(cursorSince);
  });

  it("uses the saved cursor normally when force is absent", async () => {
    const now = Date.now();
    const cursorTs = new Date(now - 3600 * 1000).toISOString(); // 1 hour ago
    getCursorMock.mockResolvedValue({
      lastTimestamp: cursorTs,
      status: "complete",
      updatedAt: new Date().toISOString(),
      metadata: {},
    });

    // Return empty immediately so the loop exits fast.
    fetchOHLCVMock.mockResolvedValue([]);

    const { backfillCandles } = await import("./backfill.js");
    await backfillCandles({
      exchangeId: "kraken",
      pair: "BTC/USDT",
      timeframe: "1m",
      days: 90,
      archiveToS3: false,
    });

    const firstCallSince = fetchOHLCVMock.mock.calls[0][2] as number;
    const cursorSince = new Date(cursorTs).getTime();

    // Should start from the cursor, not from now - 90d.
    expect(Math.abs(firstCallSince - cursorSince)).toBeLessThan(5_000);
  });

  it("updates the cursor after a force run (regular cursor-save behavior)", async () => {
    const now = Date.now();
    const cursorTs = new Date(now - 24 * 3600 * 1000).toISOString();
    getCursorMock.mockResolvedValue({
      lastTimestamp: cursorTs,
      status: "complete",
      updatedAt: new Date().toISOString(),
      metadata: {},
    });

    const openTime = now - 91 * 86400 * 1000;
    fetchOHLCVMock
      .mockResolvedValueOnce([[openTime, "100", "110", "90", "105", "5"]])
      .mockResolvedValueOnce([]);

    const { backfillCandles } = await import("./backfill.js");
    await backfillCandles({
      exchangeId: "kraken",
      pair: "BTC/USDT",
      timeframe: "1m",
      days: 90,
      force: true,
      archiveToS3: false,
    });

    // saveCursor must have been called (cursor updated after the run).
    expect(saveCursorMock).toHaveBeenCalled();
    const lastCall = saveCursorMock.mock.calls[saveCursorMock.mock.calls.length - 1][0] as {
      status: string;
    };
    expect(lastCall.status).toBe("complete");
  });
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
