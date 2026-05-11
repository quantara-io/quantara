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
// Tests for aggregateCoinbase4hFromHourly
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  storeCandlesMock.mockReset();
  getCandlesMock.mockReset();
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

  it("queries DDB with the correct pair, exchange, and timeframe", async () => {
    getCandlesMock.mockResolvedValue([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { aggregateCoinbase4hFromHourly } = await import("./higher-tf-poller-handler.js");
    await aggregateCoinbase4hFromHourly("ETH/USDT", now);

    expect(getCandlesMock).toHaveBeenCalledWith("ETH/USDT", "coinbase", "1h", 4);
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
