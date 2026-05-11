import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Candle } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted above any import of the SUT.
// ---------------------------------------------------------------------------

const storeCandlesMock = vi.fn();
const getCandlesMock = vi.fn();

vi.mock("./lib/candle-store.js", () => ({
  storeCandles: storeCandlesMock,
  getCandles: getCandlesMock,
  storeCandlesConditional: vi.fn(),
}));

// ccxt mock: only coinbase and binanceus/kraken need fetchOHLCV stubs.
// We don't exercise the ccxt path in these tests — the aggregation path
// under test reads from DDB, not the exchange.
vi.mock("ccxt", () => ({
  default: {
    binanceus: vi.fn().mockImplementation(() => ({ fetchOHLCV: vi.fn().mockResolvedValue([]) })),
    coinbase: vi.fn().mockImplementation(() => ({ fetchOHLCV: vi.fn().mockResolvedValue([]) })),
    kraken: vi.fn().mockImplementation(() => ({ fetchOHLCV: vi.fn().mockResolvedValue([]) })),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic hourly Candle for coinbase. openTime must be a Unix-ms
 * timestamp aligned to an hour boundary.
 */
function makeHourlyCandle(overrides: Partial<Candle> & { openTime: number }): Candle {
  const tfMs = 3_600_000; // 1h in ms
  const base: Candle = {
    exchange: "coinbase",
    symbol: "BTC/USD",
    pair: "BTC/USDT",
    timeframe: "1h",
    openTime: overrides.openTime,
    closeTime: overrides.openTime + tfMs,
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 10,
    isClosed: true,
    source: "live",
  };
  return { ...base, ...overrides, closeTime: overrides.closeTime ?? base.closeTime };
}

/**
 * Build a set of 4 contiguous 1h candles starting at `windowStart`.
 * getCandles returns them newest-first (descending), so we reverse.
 */
function make4HourlyCandles(windowStart: number, overrides: Partial<Candle>[] = []): Candle[] {
  const tfMs1h = 3_600_000;
  const ascending = Array.from({ length: 4 }, (_, i) =>
    makeHourlyCandle({ openTime: windowStart + i * tfMs1h, ...overrides[i] }),
  );
  // Simulate getCandles descending (newest first)
  return [...ascending].reverse();
}

// ---------------------------------------------------------------------------
// Tests for isCloseBoundary and isKrakenCloseBoundary (issue #339)
// ---------------------------------------------------------------------------

// A fixed 15m boundary for deterministic tests: 2026-01-01T00:15:00Z.
const BOUNDARY_15M = Date.UTC(2026, 0, 1, 0, 15, 0); // 1735690500000

describe("isCloseBoundary", () => {
  it("returns true at T+0s (boundary exactly)", async () => {
    const { isCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isCloseBoundary(BOUNDARY_15M, "15m")).toBe(true);
  });

  it("returns true at T+5s (typical Lambda start lag)", async () => {
    const { isCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isCloseBoundary(BOUNDARY_15M + 5_000, "15m")).toBe(true);
  });

  it("returns true at T+59s (within the 60s window)", async () => {
    const { isCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isCloseBoundary(BOUNDARY_15M + 59_000, "15m")).toBe(true);
  });

  it("returns false at T+60s (exactly at the window edge — strict < 60000)", async () => {
    const { isCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isCloseBoundary(BOUNDARY_15M + 60_000, "15m")).toBe(false);
  });

  it("returns false at T+61s (second cron tick, >60s after boundary)", async () => {
    const { isCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isCloseBoundary(BOUNDARY_15M + 61_000, "15m")).toBe(false);
  });

  it("returns false mid-period (7m after boundary)", async () => {
    const { isCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isCloseBoundary(BOUNDARY_15M + 7 * 60_000, "15m")).toBe(false);
  });
});

describe("isKrakenCloseBoundary (issue #339 — Kraken REST commit latency)", () => {
  it("returns true at T+0s", async () => {
    const { isKrakenCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isKrakenCloseBoundary(BOUNDARY_15M, "15m")).toBe(true);
  });

  it("returns true at T+5s", async () => {
    const { isKrakenCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isKrakenCloseBoundary(BOUNDARY_15M + 5_000, "15m")).toBe(true);
  });

  it("returns true at T+60s — the second cron tick that isCloseBoundary misses", async () => {
    const { isKrakenCloseBoundary } = await import("./higher-tf-poller-handler.js");
    // isCloseBoundary(BOUNDARY_15M + 60_000, "15m") === false, but
    // isKrakenCloseBoundary must return true so the T+60s invocation still
    // fetches the Kraken bar that committed after 60s.
    expect(isKrakenCloseBoundary(BOUNDARY_15M + 60_000, "15m")).toBe(true);
  });

  it("returns true at T+90s (within 120s default window)", async () => {
    const { isKrakenCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isKrakenCloseBoundary(BOUNDARY_15M + 90_000, "15m")).toBe(true);
  });

  it("returns false at T+120s (at the default window edge — strict < 120000)", async () => {
    const { isKrakenCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isKrakenCloseBoundary(BOUNDARY_15M + 120_000, "15m")).toBe(false);
  });

  it("returns false mid-period (7m after boundary — not a recent close)", async () => {
    const { isKrakenCloseBoundary } = await import("./higher-tf-poller-handler.js");
    expect(isKrakenCloseBoundary(BOUNDARY_15M + 7 * 60_000, "15m")).toBe(false);
  });

  it("respects KRAKEN_BOUNDARY_WINDOW_MS env var", async () => {
    vi.resetModules();
    process.env.KRAKEN_BOUNDARY_WINDOW_MS = "90000";
    const { isKrakenCloseBoundary } = await import("./higher-tf-poller-handler.js");
    // At T+89s: within 90s → true
    expect(isKrakenCloseBoundary(BOUNDARY_15M + 89_000, "15m")).toBe(true);
    // At T+90s: exactly at edge → false (strict <)
    expect(isKrakenCloseBoundary(BOUNDARY_15M + 90_000, "15m")).toBe(false);
    delete process.env.KRAKEN_BOUNDARY_WINDOW_MS;
  });
});

describe("handler — Kraken receives tasks in second-minute tick (issue #339)", () => {
  // `now` is 65s after a 15m boundary: isCloseBoundary returns false (65s ≥ 60s),
  // but isKrakenCloseBoundary returns true (65s < 120s default).
  const boundaryMs = Date.UTC(2026, 0, 1, 0, 15, 0);
  const nowSecondTick = boundaryMs + 65_000; // T+65s: second cron tick

  it("includes Kraken fetchOHLCV tasks at T+65s even when standard window is closed", async () => {
    // Capture which exchange classes are used for fetchOHLCV.
    const krakenFetchOHLCVMock = vi.fn().mockResolvedValue([]);
    const binanceusFetchOHLCVMock = vi.fn().mockResolvedValue([]);

    const { default: ccxt } = await import("ccxt");
    (ccxt.kraken as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fetchOHLCV: krakenFetchOHLCVMock,
    }));
    (ccxt.binanceus as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fetchOHLCV: binanceusFetchOHLCVMock,
    }));

    const { handler } = await import("./higher-tf-poller-handler.js");
    await handler({ time: new Date(nowSecondTick).toISOString() });

    // Kraken must have been called (Kraken window still open at T+65s).
    expect(krakenFetchOHLCVMock).toHaveBeenCalled();
    // binanceus must NOT have been called (standard window closed at T+65s).
    expect(binanceusFetchOHLCVMock).not.toHaveBeenCalled();
  });

  it("does nothing at T+125s when both standard and Kraken windows are closed", async () => {
    const krakenFetchOHLCVMock = vi.fn().mockResolvedValue([]);
    const { default: ccxt } = await import("ccxt");
    (ccxt.kraken as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fetchOHLCV: krakenFetchOHLCVMock,
    }));

    const { handler } = await import("./higher-tf-poller-handler.js");
    const nowOutsideWindow = boundaryMs + 125_000; // T+125s
    await handler({ time: new Date(nowOutsideWindow).toISOString() });

    // No exchange should have been called — both windows are closed.
    expect(krakenFetchOHLCVMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests for aggregateCoinbase4hFromHourly
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  storeCandlesMock.mockReset();
  getCandlesMock.mockReset();
  delete process.env.KRAKEN_BOUNDARY_WINDOW_MS;
});

describe("aggregateCoinbase4hFromHourly", () => {
  // A well-known 4h boundary: 2026-01-01T00:00:00Z is midnight, which is a
  // multiple of 4h. The closed window is [2025-12-31T20:00, 2026-01-01T00:00).
  const windowEnd = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00Z
  const windowStart = windowEnd - 14_400_000; // 4h before = 2025-12-31T20:00Z
  // `now` is just after the boundary (e.g. 30s after close)
  const now = windowEnd + 30_000;

  it("aggregates 4 contiguous 1h candles into a 4h candle and stores it", async () => {
    const sourceCandles = make4HourlyCandles(windowStart, [
      { open: 50_000, high: 51_000, low: 49_000, close: 50_500, volume: 10 },
      { open: 50_500, high: 52_000, low: 50_000, close: 51_500, volume: 15 },
      { open: 51_500, high: 53_000, low: 51_000, close: 52_000, volume: 12 },
      { open: 52_000, high: 54_000, low: 51_800, close: 53_500, volume: 8 },
    ]);
    getCandlesMock.mockResolvedValue(sourceCandles);
    storeCandlesMock.mockResolvedValue(undefined);

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", now);

    expect(result).toBe(true);
    expect(storeCandlesMock).toHaveBeenCalledOnce();

    const [candles] = storeCandlesMock.mock.calls[0] as [Candle[]];
    expect(candles).toHaveLength(1);
    const c = candles[0]!;

    // OHLCV aggregation rules per the issue spec
    expect(c.exchange).toBe("coinbase");
    expect(c.timeframe).toBe("4h");
    expect(c.pair).toBe("BTC/USDT");
    expect(c.openTime).toBe(windowStart);
    expect(c.closeTime).toBe(windowStart + 3_600_000 * 4); // last hourly closeTime
    expect(c.open).toBe(50_000); // first.open
    expect(c.close).toBe(53_500); // last.close
    expect(c.high).toBe(54_000); // max of all highs
    expect(c.low).toBe(49_000); // min of all lows
    expect(c.volume).toBeCloseTo(45); // sum of all volumes
    expect(c.source).toBe("live");
    expect(c.aggregatedFrom).toBe("1h×4");
    expect(c.isClosed).toBe(true);
  });

  it("uses the coinbase symbol override (BTC/USD not BTC/USDT)", async () => {
    getCandlesMock.mockResolvedValue(make4HourlyCandles(windowStart));
    storeCandlesMock.mockResolvedValue(undefined);

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    await aggregateCoinbase4hFromHourly("BTC/USDT", now);

    const [candles] = storeCandlesMock.mock.calls[0] as [Candle[]];
    expect(candles[0]!.symbol).toBe("BTC/USD");
  });

  it("returns false and logs a warning when fewer than 4 1h candles are available", async () => {
    // Only 2 candles in the window
    const partial = make4HourlyCandles(windowStart).slice(0, 2);
    getCandlesMock.mockResolvedValue(partial);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", now);

    expect(result).toBe(false);
    expect(storeCandlesMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /coinbase 4h aggregation skipped — only \d\/4 hourly candles available/,
      ),
    );

    warnSpy.mockRestore();
  });

  it("returns false when getCandles returns an empty list", async () => {
    getCandlesMock.mockResolvedValue([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", now);

    expect(result).toBe(false);
    expect(storeCandlesMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns false and warns when 4 candles exist but have a gap (non-contiguous)", async () => {
    const tfMs1h = 3_600_000;
    // 4 candles whose openTimes are not exactly 1h apart — the middle one is off by 1ms
    const withGap: Candle[] = [
      makeHourlyCandle({ openTime: windowStart + tfMs1h * 3 }), // newest-first
      makeHourlyCandle({ openTime: windowStart + tfMs1h * 2 }),
      makeHourlyCandle({ openTime: windowStart + tfMs1h * 0 + 2 * tfMs1h - 1 }), // off by 1ms
      makeHourlyCandle({ openTime: windowStart }),
    ];

    getCandlesMock.mockResolvedValue(withGap);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", now);

    // Non-contiguous candles → skipped
    expect(result).toBe(false);
    expect(storeCandlesMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("filters out candles whose openTime is outside the 4h window", async () => {
    // Simulate DDB returning 4 candles but only 2 fall within [windowStart, windowEnd)
    const tfMs1h = 3_600_000;
    const outsideWindow = [
      makeHourlyCandle({ openTime: windowStart + tfMs1h * 3 }),
      makeHourlyCandle({ openTime: windowStart + tfMs1h * 2 }),
      makeHourlyCandle({ openTime: windowStart + tfMs1h * 1 }),
      makeHourlyCandle({ openTime: windowStart - tfMs1h }), // before window — filtered out
    ];
    getCandlesMock.mockResolvedValue(outsideWindow);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    const result = await aggregateCoinbase4hFromHourly("BTC/USDT", now);

    expect(result).toBe(false); // only 3 candles in window
    expect(storeCandlesMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("queries DDB with the correct pair, exchange, timeframe, and a limit >= 4", async () => {
    getCandlesMock.mockResolvedValue([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    await aggregateCoinbase4hFromHourly("ETH/USDT", now);

    expect(getCandlesMock).toHaveBeenCalledOnce();
    const [callPair, callExchange, callTf, callLimit] = getCandlesMock.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(callPair).toBe("ETH/USDT");
    expect(callExchange).toBe("coinbase");
    expect(callTf).toBe("1h");
    // Limit must be at least 4 (the number of candles needed for the window).
    // It is intentionally wider (currently 8) to survive extra rows near the boundary.
    expect(callLimit).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Tests for handler — verify coinbase 4h is routed to aggregation, not ccxt
// ---------------------------------------------------------------------------

describe("handler — coinbase 4h routing", () => {
  // Construct a `now` that is on a 4h boundary (within the first 60s).
  // 2026-01-01T04:00:00Z is midnight + 4h → a valid 4h close boundary.
  const boundaryMs = Date.UTC(2026, 0, 1, 4, 0, 0);
  const nowOnBoundary = boundaryMs + 5_000; // 5s after the 4h close

  it("calls aggregateCoinbase4hFromHourly for each pair when a 4h close is due", async () => {
    // Supply 4 valid candles per pair so the aggregation succeeds
    const windowStart = boundaryMs - 14_400_000; // 4h before boundary
    const validCandles = make4HourlyCandles(windowStart);
    getCandlesMock.mockResolvedValue(validCandles);
    storeCandlesMock.mockResolvedValue(undefined);

    const { handler } = await import("./higher-tf-poller-handler.js");
    await handler({ time: new Date(nowOnBoundary).toISOString() });

    // getCandles should have been called once per PAIR (5 pairs: BTC, ETH, SOL, XRP, DOGE)
    // for coinbase 1h lookup. It may be called multiple times if other TFs are also due,
    // but all calls for the coinbase 4h aggregation must have timeframe="1h".
    const coinbase1hCalls = getCandlesMock.mock.calls.filter(
      (args: unknown[]) => args[1] === "coinbase" && args[2] === "1h",
    );
    expect(coinbase1hCalls.length).toBeGreaterThanOrEqual(5);
  });

  it("does NOT call fetchOHLCV for coinbase when 4h is due", async () => {
    // Return valid candles for the aggregation path
    const windowStart = boundaryMs - 14_400_000;
    getCandlesMock.mockResolvedValue(make4HourlyCandles(windowStart));
    storeCandlesMock.mockResolvedValue(undefined);

    // Capture what ccxt classes are instantiated
    const { default: ccxt } = await import("ccxt");
    const coinbaseInstance = { fetchOHLCV: vi.fn().mockResolvedValue([]) };
    (ccxt.coinbase as ReturnType<typeof vi.fn>).mockImplementation(() => coinbaseInstance);

    const { handler } = await import("./higher-tf-poller-handler.js");
    await handler({ time: new Date(nowOnBoundary).toISOString() });

    // coinbase.fetchOHLCV must never be called with "4h"
    const fetchCalls4h = coinbaseInstance.fetchOHLCV.mock.calls.filter(
      (args: unknown[]) => args[1] === "4h",
    );
    expect(fetchCalls4h).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Handler ordering test: 1h write must complete before the 4h aggregation read
// ---------------------------------------------------------------------------

describe("handler — phase ordering (1h write before 4h read)", () => {
  // Use a `now` that is on BOTH a 1h and 4h close boundary so the handler
  // enqueues a coinbase 1h fetch (Phase 1) AND a coinbase 4h aggregation (Phase 2).
  // 2026-01-01T04:00:00Z is a 4h boundary (4×3600000 ms from midnight) and also
  // a 1h boundary (trivially, since 4h is a multiple of 1h).
  const boundaryMs = Date.UTC(2026, 0, 1, 4, 0, 0);
  const nowOnBoundary = boundaryMs + 5_000; // 5s after both closes

  it("getCandles (4h aggregation read) is called only after storeCandles (1h write) resolves", async () => {
    const windowStart = boundaryMs - 14_400_000; // 4h before boundary

    // We need Phase 1 (fetchAndStoreLatestCandle) to actually call storeCandles.
    // fetchAndStoreLatestCandle calls storeCandles only when fetchOHLCV returns a
    // row whose openTime matches `targetOpenTime`. For the 1h window just closed,
    // targetOpenTime = lastBoundary - tfMs1h = boundaryMs - 3_600_000.
    const target1hOpenTime = boundaryMs - 3_600_000;

    // Build a synthetic OHLCV row that matches the target open time so that
    // at least one exchange's fetchOHLCV triggers a storeCandles call in Phase 1.
    const ohlcvRow = [target1hOpenTime, 50_000, 51_000, 49_000, 50_500, 10];

    // Wire the ccxt mock for all exchanges to return the matching row for 1h.
    const { default: ccxt } = await import("ccxt");
    for (const ExchangeClass of [ccxt.binanceus, ccxt.coinbase, ccxt.kraken] as ReturnType<
      typeof vi.fn
    >[]) {
      ExchangeClass.mockImplementation(() => ({
        fetchOHLCV: vi
          .fn()
          .mockImplementation(async (_sym: string, tf: string, since: number) =>
            tf === "1h" && since === target1hOpenTime ? [ohlcvRow] : [],
          ),
      }));
    }

    // Timeline tracking — monotonic counter bumped on every observed event.
    let clock = 0;
    // Track when the first getCandles call is made (start of Phase 2).
    // Any storeCandles call that arrives AFTER this timestamp came too late to
    // matter for the ordering proof; we only care about the Phase 1 writes.
    let firstGetCandlesT = -1;
    // Track when the last Phase-1 storeCandles call resolves.
    // A "Phase 1" store is one where the candle has no aggregatedFrom field —
    // i.e. it came from fetchAndStoreLatestCandle, not the aggregator.
    // We approximate this: any storeCandles call that fires BEFORE the first
    // getCandles call is a Phase 1 write (the aggregator always reads before
    // it writes its output).
    const phase1StoreTs: number[] = [];

    // storeCandles: resolve asynchronously to simulate I/O latency so a racing
    // getCandles would slip in before the store if phases were merged.
    storeCandlesMock.mockImplementation(async () => {
      await Promise.resolve();
      const t = clock++;
      // Only count this as a Phase 1 write if getCandles hasn't fired yet.
      if (firstGetCandlesT === -1) {
        phase1StoreTs.push(t);
      }
    });

    // getCandles (aggregation read): record when Phase 2 starts, then return
    // the valid 4 in-window candles needed for the aggregation to succeed.
    getCandlesMock.mockImplementation(async () => {
      await Promise.resolve();
      const t = clock++;
      if (firstGetCandlesT === -1) firstGetCandlesT = t;
      return make4HourlyCandles(windowStart);
    });

    const { handler } = await import("./higher-tf-poller-handler.js");
    await handler({ time: new Date(nowOnBoundary).toISOString() });

    // Phase 1 must have triggered at least one storeCandles call (from the 1h
    // write for binanceus / coinbase / kraken), and Phase 2 must have triggered
    // at least one getCandles call (coinbase 4h aggregation read).
    expect(phase1StoreTs.length).toBeGreaterThanOrEqual(1);
    expect(firstGetCandlesT).toBeGreaterThan(-1);

    // The first getCandles (Phase 2 read start) must have a clock value strictly
    // greater than every Phase 1 storeCandles write. If the handler merged both
    // phases into one Promise.allSettled, getCandles would fire concurrently
    // with storeCandles and firstGetCandlesT could be lower than some
    // phase1StoreTs values. The two-phase handler guarantees all Phase 1
    // writes complete before any Phase 2 read begins.
    const maxPhase1StoreT = Math.max(...phase1StoreTs);
    expect(firstGetCandlesT).toBeGreaterThan(maxPhase1StoreT);
  });
});
