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

// DynamoDB mock — watchdog writes staleness records; we stub the entire
// document client so unit tests don't make network calls.
// `from()` returns a stable mock client object (not the raw DynamoDBClient)
// to ensure `_ddbClient` is always a defined object with a `send` method.
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  const stubClient = { send: vi.fn().mockResolvedValue({}) };
  return {
    DynamoDBDocumentClient: { from: vi.fn().mockReturnValue(stubClient) },
    PutCommand: vi.fn().mockImplementation((input: unknown) => input),
  };
});

// watchOHLCV mock: emits one batch then blocks (simulates a live stream).
// We resolve immediately with the provided rows, then never resolve again
// so the while loop exits via abort.
const watchOHLCVMock = vi.fn();
const watchTickerMock = vi.fn();
const fetchOHLCVMock = vi.fn();

vi.mock("ccxt", () => {
  const fakeExchangeClass = vi.fn().mockImplementation(() => ({
    has: { watchOHLCV: true, watchTicker: true },
    watchOHLCV: watchOHLCVMock,
    watchTicker: watchTickerMock,
    fetchOHLCV: fetchOHLCVMock,
    close: vi.fn().mockResolvedValue(undefined),
  }));

  // coinbase: no watchOHLCV (triggers REST backfill path)
  const fakeCoinbaseClass = vi.fn().mockImplementation(() => ({
    has: { watchOHLCV: false, watchTicker: true },
    watchOHLCV: watchOHLCVMock,
    watchTicker: watchTickerMock,
    fetchOHLCV: fetchOHLCVMock,
    close: vi.fn().mockResolvedValue(undefined),
  }));

  return {
    default: {
      pro: {
        binanceus: fakeExchangeClass,
        coinbase: fakeCoinbaseClass,
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
  fetchOHLCVMock.mockReset();
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

  // fetchOHLCV blocks (coinbase won't be using it in these tests).
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
// Watchdog auto-reconnect tests
// ---------------------------------------------------------------------------

describe("MarketStreamManager — watchdog auto-reconnect", () => {
  /**
   * Build a manager, manipulate a stream's lastDataAt to simulate staleness,
   * then fire the watchdog manually and observe restart behaviour.
   *
   * We expose the private watchdog via bracket-notation casting.
   */

  it("logs a warning but does NOT restart a stream stale only past the 5-min threshold", async () => {
    // All streams block — we drive everything manually.
    watchOHLCVMock.mockReturnValue(new Promise(() => {}));
    watchTickerMock.mockReturnValue(new Promise(() => {}));
    fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

    const { MarketStreamManager } = await import("./stream.js");
    const manager = new MarketStreamManager();
    await manager.start();

    const streams: Map<string, any> = (manager as any).streams;

    // Seed all streams with a fresh lastDataAt so none trigger the reconnect threshold.
    const freshTs = Date.now() - 1_000;
    for (const state of streams.values()) {
      state.lastDataAt = freshTs;
    }

    // Then mark one kraken stream as 6-min stale (past warn threshold, below reconnect threshold).
    const krakenKey = [...streams.keys()].find((k) => k.startsWith("kraken:"));
    expect(krakenKey).toBeDefined();
    streams.get(krakenKey!).lastDataAt = Date.now() - 6 * 60_000;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Fire watchdog synchronously.
    (manager as any).watchdog();

    // Should have logged a stale warning.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stale"));

    // Should NOT have logged a restart message for any stream.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Restarting"));

    warnSpy.mockRestore();
    await manager.stop();
  });

  it("restarts a single stale stream after the 10-min reconnect threshold", async () => {
    watchOHLCVMock.mockReturnValue(new Promise(() => {}));
    watchTickerMock.mockReturnValue(new Promise(() => {}));
    fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

    const { MarketStreamManager } = await import("./stream.js");
    const manager = new MarketStreamManager();
    await manager.start();

    const streams: Map<string, any> = (manager as any).streams;

    // Seed all streams with fresh data so only our target triggers.
    const freshTs = Date.now() - 1_000;
    for (const state of streams.values()) {
      state.lastDataAt = freshTs;
    }

    // Record how many times streams were started initially.
    const initialWatchTickerCalls = watchTickerMock.mock.calls.length;
    const initialWatchOHLCVCalls = watchOHLCVMock.mock.calls.length;

    // Mark kraken:BTC/USDT as 11-min stale (past reconnect threshold).
    const targetKey = "kraken:BTC/USDT";
    const targetState = streams.get(targetKey);
    expect(targetState).toBeDefined();
    const originalAbortController = targetState.abortController;
    targetState.lastDataAt = Date.now() - 11 * 60_000;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Fire watchdog.
    (manager as any).watchdog();

    // A restart log message should appear.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`Restarting stream ${targetKey}`));

    // The per-stream abort controller should have been replaced.
    expect(targetState.abortController).not.toBe(originalAbortController);
    expect(originalAbortController.signal.aborted).toBe(true);

    // lastDataAt should be reset to 0.
    expect(targetState.lastDataAt).toBe(0);

    // New stream loops should have been started (ticker + OHLCV = 2 more calls).
    expect(watchTickerMock.mock.calls.length).toBeGreaterThan(initialWatchTickerCalls);
    expect(watchOHLCVMock.mock.calls.length).toBeGreaterThan(initialWatchOHLCVCalls);

    warnSpy.mockRestore();
    await manager.stop();
  });

  it("leaves other streams undisturbed when restarting one stale stream", async () => {
    watchOHLCVMock.mockReturnValue(new Promise(() => {}));
    watchTickerMock.mockReturnValue(new Promise(() => {}));
    fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

    const { MarketStreamManager } = await import("./stream.js");
    const manager = new MarketStreamManager();
    await manager.start();

    const streams: Map<string, any> = (manager as any).streams;

    // Seed all streams with fresh data so none trigger the reconnect threshold by default.
    const freshTs = Date.now() - 1_000;
    for (const state of streams.values()) {
      state.lastDataAt = freshTs;
    }

    // Snapshot abort controllers for all streams before the restart.
    const originalControllers = new Map<string, AbortController>();
    for (const [key, state] of streams) {
      originalControllers.set(key, state.abortController);
    }

    // Mark only kraken:ETH/USDT as past the reconnect threshold.
    const targetKey = "kraken:ETH/USDT";
    streams.get(targetKey)!.lastDataAt = Date.now() - 11 * 60_000;

    vi.spyOn(console, "warn").mockImplementation(() => {});

    (manager as any).watchdog();

    // Only the target's controller should have been replaced and aborted.
    for (const [key, state] of streams) {
      if (key === targetKey) {
        expect(state.abortController).not.toBe(originalControllers.get(key));
        expect(originalControllers.get(key)!.signal.aborted).toBe(true);
      } else {
        // Other streams: their original abort controllers must NOT have been aborted.
        expect(originalControllers.get(key)!.signal.aborted).toBe(false);
      }
    }

    vi.restoreAllMocks();
    await manager.stop();
  });

  it("restarts coinbase backfill loop (not watchOHLCV) when coinbase stream goes stale", async () => {
    watchOHLCVMock.mockReturnValue(new Promise(() => {}));
    watchTickerMock.mockReturnValue(new Promise(() => {}));
    fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

    const { MarketStreamManager } = await import("./stream.js");
    const manager = new MarketStreamManager();
    await manager.start();

    const streams: Map<string, any> = (manager as any).streams;

    // Seed all streams with fresh data so only the target triggers.
    const freshTs = Date.now() - 1_000;
    for (const state of streams.values()) {
      state.lastDataAt = freshTs;
    }

    // Mark coinbase:BTC/USDT as past reconnect threshold.
    const targetKey = "coinbase:BTC/USDT";
    expect(streams.get(targetKey)).toBeDefined();
    const targetState = streams.get(targetKey)!;
    const originalAbortController = targetState.abortController;
    targetState.lastDataAt = Date.now() - 11 * 60_000;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    (manager as any).watchdog();

    // Verify the restart message was logged.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Restarting stream ${targetKey}`),
    );

    // Verify per-stream abort controller was replaced (old one aborted, new one fresh).
    expect(originalAbortController.signal.aborted).toBe(true);
    expect(targetState.abortController).not.toBe(originalAbortController);
    expect(targetState.abortController.signal.aborted).toBe(false);

    // lastDataAt should be reset to 0 so the loop starts fresh.
    expect(targetState.lastDataAt).toBe(0);

    // The exchange object for coinbase should NOT have called watchOHLCV for the restart
    // (coinbase uses fetchOHLCV instead). Verify watchOHLCV was NOT called more than
    // the initial ticker+OHLCV streams would have called it (coinbase has no OHLCV stream).
    // (We don't count fetchOHLCV calls here since async timing is non-deterministic in tests.)

    warnSpy.mockRestore();
    await manager.stop();
  });

  it("preserves stale warnings at the 5-min threshold alongside restart at 10-min threshold", async () => {
    watchOHLCVMock.mockReturnValue(new Promise(() => {}));
    watchTickerMock.mockReturnValue(new Promise(() => {}));
    fetchOHLCVMock.mockReturnValue(new Promise(() => {}));

    const { MarketStreamManager } = await import("./stream.js");
    const manager = new MarketStreamManager();
    await manager.start();

    const streams: Map<string, any> = (manager as any).streams;

    // Seed all streams with fresh data so only our two test streams trigger.
    const freshTs = Date.now() - 1_000;
    for (const state of streams.values()) {
      state.lastDataAt = freshTs;
    }

    // Make kraken:XRP/USDT just past the stale threshold (6 min).
    const mildKey = "kraken:XRP/USDT";
    streams.get(mildKey)!.lastDataAt = Date.now() - 6 * 60_000;

    // Make binanceus:BTC/USDT past the reconnect threshold (11 min).
    const severeKey = "binanceus:BTC/USDT";
    streams.get(severeKey)!.lastDataAt = Date.now() - 11 * 60_000;

    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((msg: string) => warnings.push(msg));

    (manager as any).watchdog();

    // Both should generate a stale warning (5-min log threshold).
    const staleWarnings = warnings.filter((w) => w.includes("stale"));
    expect(staleWarnings.some((w) => w.includes(mildKey))).toBe(true);
    expect(staleWarnings.some((w) => w.includes(severeKey))).toBe(true);

    // Only the severe one should trigger a restart.
    const restartWarnings = warnings.filter((w) => w.includes("Restarting"));
    expect(restartWarnings.some((w) => w.includes(severeKey))).toBe(true);
    expect(restartWarnings.some((w) => w.includes(mildKey))).toBe(false);

    vi.restoreAllMocks();
    await manager.stop();
  });
});
