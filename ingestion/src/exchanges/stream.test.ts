import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Candle } from "@quantara/shared";

import { PAIRS } from "./config.js";

// Mock I/O dependencies before importing the SUT.
const storeCandelsMock = vi.fn().mockResolvedValue(undefined);
const storePriceSnapshotsMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/candle-store.js", () => ({
  storeCandles: storeCandelsMock,
}));

vi.mock("../lib/store.js", () => ({
  storePriceSnapshots: storePriceSnapshotsMock,
}));

// DynamoDB mock — the watchdog persists per-pair staleness to DDB; without
// this, the constructor's real DDB client tries to send a Put and the test
// either hangs or errors. `from()` returns a stable stub object so the
// per-instance `ddbClient` is always defined.
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

// Derived from the production constant so the test stays aligned if PAIRS changes.
const COINBASE_PAIR_COUNT = PAIRS.length;

/**
 * Helper: start the manager with the given fetchOHLCV behaviour and wait
 * (real-timer poll via `vi.waitFor`) until either the expected number of
 * stores have happened, or `expectNoStores` is true and a short window
 * passes with no stores. Stops the manager and returns candles.
 *
 * `mockResolvedValue` (not `Once`) is used so every pair's first poll gets
 * the same response. The 30s `abortableSleep` between cycles wakes
 * immediately when `stop()` aborts the signal, so shutdown is prompt.
 */
async function driveCoinbaseBackfillSingleCycle(
  fetchResponse: unknown[][] | (() => unknown[][] | Promise<unknown[][]>),
  options: { expectedStores?: number } = {},
): Promise<Candle[]> {
  watchOHLCVMock.mockReturnValue(new Promise(() => {}));
  watchTickerMock.mockReturnValue(new Promise(() => {}));
  if (typeof fetchResponse === "function") {
    fetchOHLCVMock.mockImplementation(fetchResponse);
  } else {
    fetchOHLCVMock.mockResolvedValue(fetchResponse);
  }

  const { MarketStreamManager } = await import("./stream.js");
  const manager = new MarketStreamManager();
  await manager.start();

  const expected = options.expectedStores ?? COINBASE_PAIR_COUNT;
  if (expected === 0) {
    // Wait for all pair loops to have polled at least once, then assert no
    // stores happened.
    await vi.waitFor(
      () => {
        expect(fetchOHLCVMock.mock.calls.length).toBeGreaterThanOrEqual(COINBASE_PAIR_COUNT);
      },
      { timeout: 1000 },
    );
    expect(storeCandelsMock.mock.calls.length).toBe(0);
  } else {
    // Wait until the expected number of stores have happened. Also waits
    // for all pair loops to have polled (catches "wrote less than expected"
    // by ensuring fetches all completed).
    await vi.waitFor(
      () => {
        expect(fetchOHLCVMock.mock.calls.length).toBeGreaterThanOrEqual(COINBASE_PAIR_COUNT);
        expect(storeCandelsMock.mock.calls.length).toBeGreaterThanOrEqual(expected);
      },
      { timeout: 1000 },
    );
  }

  await manager.stop();

  const allCandles: Candle[] = [];
  for (const call of storeCandelsMock.mock.calls) {
    allCandles.push(...(call[0] as Candle[]));
  }
  return allCandles;
}

describe("MarketStreamManager — Coinbase REST backfill loop", () => {
  it("writes the most-recently-closed bar when ccxt returns [closed, open]", async () => {
    const now = Date.now();
    const closedOpenTime = now - 120_000; // 2m ago — closed
    const openOpenTime = now - 30_000; // 30s ago — currently open

    const closedBar = [closedOpenTime, 50000, 50100, 49900, 50050, 1.5];
    const openBar = [openOpenTime, 50060, 50080, 50010, 50070, 0.8];

    // ccxt is chronological (oldest → newest), so [closed, open] is the
    // common shape when the in-progress bar is included at the end.
    const candles = await driveCoinbaseBackfillSingleCycle([closedBar, openBar]);
    const coinbaseCandles = candles.filter((c) => c.exchange === "coinbase");

    expect(coinbaseCandles).toHaveLength(COINBASE_PAIR_COUNT);
    for (const candle of coinbaseCandles) {
      expect(candle.openTime).toBe(closedOpenTime);
      expect(candle.closeTime).toBe(closedOpenTime + 60_000);
      expect(candle.isClosed).toBe(true);
      expect(candle.source).toBe("live");
      expect(candle.timeframe).toBe("1m");
    }
  });

  it("picks the newest closed bar when ccxt returns only closed bars (no open bar)", async () => {
    const now = Date.now();
    const olderOpenTime = now - 180_000; // 3m ago
    const newerOpenTime = now - 120_000; // 2m ago — newest closed

    const olderBar = [olderOpenTime, 50000, 50100, 49900, 50050, 1.5];
    const newerBar = [newerOpenTime, 50050, 50200, 49950, 50100, 1.8];

    // Both bars closed. The loop should pick the newer one (highest closeTime),
    // not the older one — that's the regression Copilot flagged.
    const candles = await driveCoinbaseBackfillSingleCycle([olderBar, newerBar]);
    const coinbaseCandles = candles.filter((c) => c.exchange === "coinbase");

    expect(coinbaseCandles).toHaveLength(COINBASE_PAIR_COUNT);
    for (const candle of coinbaseCandles) {
      expect(candle.openTime).toBe(newerOpenTime);
      expect(candle.closeTime).toBe(newerOpenTime + 60_000);
    }
  });

  it("skips when no closed bar is present (all bars still open)", async () => {
    const now = Date.now();
    // Both bars within the current minute → both still open.
    const bar1 = [now - 45_000, 50000, 50100, 49900, 50050, 1.5];
    const bar2 = [now - 15_000, 50060, 50080, 50010, 50070, 0.8];

    const candles = await driveCoinbaseBackfillSingleCycle([bar1, bar2], {
      expectedStores: 0,
    });
    const coinbaseCandles = candles.filter((c) => c.exchange === "coinbase");

    expect(coinbaseCandles).toHaveLength(0);
  });

  it("applies Number() coercion to string-typed OHLCV values", async () => {
    const now = Date.now();
    const closedOpenTime = now - 120_000;

    const closedBar = [closedOpenTime, "50000.5", "50100.0", "49900.25", "50050.75", "1.23456"];
    const openBar = [now - 30_000, "50060", "50080", "50010", "50070", "0.5"];

    const candles = await driveCoinbaseBackfillSingleCycle([closedBar, openBar]);
    const coinbaseCandles = candles.filter((c) => c.exchange === "coinbase");

    expect(coinbaseCandles).toHaveLength(COINBASE_PAIR_COUNT);
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

  it("continues writing other pairs when one pair's fetchOHLCV throws", async () => {
    const now = Date.now();
    const closedOpenTime = now - 120_000;
    const closedBar = [closedOpenTime, 50000, 50100, 49900, 50050, 1.5];
    const openBar = [now - 30_000, 50060, 50080, 50010, 50070, 0.8];

    // First fetch throws (simulates one pair failing); the rest succeed.
    let firstCall = true;
    const candles = await driveCoinbaseBackfillSingleCycle(
      () => {
        if (firstCall) {
          firstCall = false;
          return Promise.reject(new Error("REST timeout"));
        }
        return Promise.resolve([closedBar, openBar]);
      },
      { expectedStores: COINBASE_PAIR_COUNT - 1 },
    );

    const coinbaseCandles = candles.filter((c) => c.exchange === "coinbase");
    // N-1 of N pairs wrote; one failed silently.
    expect(coinbaseCandles).toHaveLength(COINBASE_PAIR_COUNT - 1);
  });
});

// ---------------------------------------------------------------------------
// pickClosedBar — pure helper, unit-tested directly
// ---------------------------------------------------------------------------

describe("pickClosedBar", () => {
  it("returns the newest closed bar when an open bar is present at the end", async () => {
    const { pickClosedBar } = await import("./stream.js");
    const now = 1_700_000_000_000;
    const closedBar: [number, ...number[]] = [now - 120_000, 1, 2, 3, 4, 5];
    const openBar: [number, ...number[]] = [now - 30_000, 6, 7, 8, 9, 10];

    expect(pickClosedBar([closedBar, openBar], now)).toBe(closedBar);
  });

  it("returns the newest closed bar when no open bar is present", async () => {
    const { pickClosedBar } = await import("./stream.js");
    const now = 1_700_000_000_000;
    const olderBar: [number, ...number[]] = [now - 180_000, 1, 2, 3, 4, 5];
    const newerBar: [number, ...number[]] = [now - 120_000, 6, 7, 8, 9, 10];

    expect(pickClosedBar([olderBar, newerBar], now)).toBe(newerBar);
  });

  it("returns null when every bar is still open", async () => {
    const { pickClosedBar } = await import("./stream.js");
    const now = 1_700_000_000_000;
    const bar1: [number, ...number[]] = [now - 45_000, 1, 2, 3, 4, 5];
    const bar2: [number, ...number[]] = [now - 15_000, 6, 7, 8, 9, 10];

    expect(pickClosedBar([bar1, bar2], now)).toBeNull();
  });

  it("returns null on an empty array", async () => {
    const { pickClosedBar } = await import("./stream.js");
    expect(pickClosedBar([], 1_700_000_000_000)).toBeNull();
  });

  it("skips bars with null timestamps", async () => {
    const { pickClosedBar } = await import("./stream.js");
    const now = 1_700_000_000_000;
    const goodBar = [now - 120_000, 1, 2, 3, 4, 5] as [number, ...number[]];
    // Defensive: ccxt typing says ts is a number, but test the runtime guard
    // anyway in case an adapter returns a malformed row.
    const badBar = [null, 6, 7, 8, 9, 10] as unknown as [number, ...number[]];

    expect(pickClosedBar([goodBar, badBar], now)).toBe(goodBar);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: when the same closeTime is seen twice in a row, the loop's
// in-memory `coinbaseLastCloseTime` map should short-circuit the second
// write. We exercise this with fake timers so two polling cycles fire
// deterministically without a real 30s wall-clock wait.
// ---------------------------------------------------------------------------

describe("MarketStreamManager — Coinbase backfill idempotency", () => {
  it("does not re-write the same closed bar across two polling cycles", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      // Two already-closed bars (well past the open-window). Using bars far
      // enough in the past that the 30s fake-time advance below doesn't
      // change which bar `pickClosedBar` selects — it should return the
      // newer one in both cycles.
      const olderBar = [now - 600_000, 50000, 50100, 49900, 50050, 1.5];
      const newerBar = [now - 540_000, 50050, 50200, 49950, 50100, 1.8];

      watchOHLCVMock.mockReturnValue(new Promise(() => {}));
      watchTickerMock.mockReturnValue(new Promise(() => {}));
      fetchOHLCVMock.mockResolvedValue([olderBar, newerBar]);

      const { MarketStreamManager } = await import("./stream.js");
      const manager = new MarketStreamManager();
      await manager.start();

      // Cycle 1: flush microtasks so each pair's first fetchOHLCV resolves
      // and runs through to storeCandles + the closeTime-map update.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchOHLCVMock.mock.calls.length).toBe(COINBASE_PAIR_COUNT);
      expect(storeCandelsMock.mock.calls.length).toBe(COINBASE_PAIR_COUNT);

      // Cycle 2: advance past the 30s sleep so each pair's loop fires its
      // second fetchOHLCV. The response is identical, `pickClosedBar` returns
      // the same newerBar, and closeTime matches the stored lastCloseTime —
      // the idempotent-skip branch must fire so storeCandles is NOT called
      // again.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchOHLCVMock.mock.calls.length).toBe(COINBASE_PAIR_COUNT * 2);
      expect(storeCandelsMock.mock.calls.length).toBe(COINBASE_PAIR_COUNT); // unchanged

      // Stop wakes abortableSleep immediately so shutdown is prompt.
      await manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Watchdog auto-reconnect tests
//
// Build a manager, manipulate a stream's lastDataAt to simulate staleness,
// then fire the watchdog manually and observe restart behaviour. We expose
// the private watchdog via bracket-notation casting.
// ---------------------------------------------------------------------------

describe("MarketStreamManager — watchdog auto-reconnect", () => {
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
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`Restarting stream ${targetKey}`));

    // Verify per-stream abort controller was replaced (old one aborted, new one fresh).
    expect(originalAbortController.signal.aborted).toBe(true);
    expect(targetState.abortController).not.toBe(originalAbortController);
    expect(targetState.abortController.signal.aborted).toBe(false);

    // lastDataAt should be reset to 0 so the loop starts fresh.
    expect(targetState.lastDataAt).toBe(0);

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
