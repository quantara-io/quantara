/**
 * Tests for signals-performance.ts — Phase 8 performance API routes.
 *
 * Covers:
 *   GET /history  — happy path, pagination cursor, empty result
 *   GET /accuracy — happy path, 404 when no aggregate exists
 *   GET /calibration — happy path, empty bins when no data
 *   GET /attribution — happy path, empty rules list
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the store module — prevents any DynamoDB calls
// ---------------------------------------------------------------------------

const getSignalHistoryMock = vi.fn();
const getAccuracyAggregateMock = vi.fn();
const getCalibrationDataMock = vi.fn();
const getRuleAttributionDataMock = vi.fn();

vi.mock("../lib/signals-performance-store.js", () => ({
  getSignalHistory: getSignalHistoryMock,
  getAccuracyAggregate: getAccuracyAggregateMock,
  getCalibrationData: getCalibrationDataMock,
  getRuleAttributionData: getRuleAttributionDataMock,
}));

// ---------------------------------------------------------------------------
// Inject fake auth context for all protected routes
// ---------------------------------------------------------------------------

const fakeAuth = {
  userId: "user_perf_1",
  email: "perf@b.com",
  emailVerified: true,
  authMethod: "password",
  sessionId: "sess_perf",
  role: "user",
};

vi.mock("../middleware/require-auth.js", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("auth", fakeAuth);
    await next();
  },
}));

// ---------------------------------------------------------------------------
// Reset mocks and modules before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  getSignalHistoryMock.mockReset();
  getAccuracyAggregateMock.mockReset();
  getCalibrationDataMock.mockReset();
  getRuleAttributionDataMock.mockReset();
});

async function loadApp() {
  const { signalsPerformance } = await import("./signals-performance.js");
  return signalsPerformance;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const outcomeEntry = {
  pair: "BTC/USDT",
  signalId: "sig-001",
  type: "buy" as const,
  confidence: 0.75,
  createdAt: "2024-01-01T00:00:00.000Z",
  expiresAt: "2024-01-02T00:00:00.000Z",
  resolvedAt: "2024-01-02T01:00:00.000Z",
  priceAtSignal: 45000,
  priceAtResolution: 46000,
  priceMovePct: 0.022,
  thresholdUsed: 0.01,
  outcome: "correct" as const,
  rulesFired: ["rsi_oversold"],
  emittingTimeframe: "1h",
  invalidatedExcluded: false,
};

const accuracyBadge = {
  pair: "BTC/USDT",
  timeframe: "1h",
  window: "30d" as const,
  totalResolved: 100,
  correctCount: 60,
  incorrectCount: 30,
  neutralCount: 10,
  invalidatedCount: 2,
  accuracyPct: 0.6666666666666666,
  brier: 0.18,
  ece: 0.04,
  computedAt: "2024-01-10T00:00:00.000Z",
};

const calibrationBin = {
  binLow: 0.7,
  binHigh: 0.8,
  count: 15,
  meanConfidence: 0.74,
  actualAccuracy: 0.73,
};

const ruleEntry = {
  rule: "rsi_oversold",
  fireCount: 40,
  correctCount: 28,
  incorrectCount: 10,
  neutralCount: 2,
  contribution: 0.7368421052631579,
  computedAt: "2024-01-10T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// GET /history
// ---------------------------------------------------------------------------

describe("GET /history", () => {
  it("returns 200 with outcomes and meta", async () => {
    getSignalHistoryMock.mockResolvedValue({
      outcomes: [outcomeEntry],
      hasMore: false,
      nextCursor: undefined,
    });

    const app = await loadApp();
    const res = await app.request("/history?pair=BTC%2FUSDT&window=30d&limit=50");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.outcomes).toHaveLength(1);
    expect(body.data.outcomes[0].signalId).toBe("sig-001");
    expect(body.data.meta.hasMore).toBe(false);
    expect(body.data.meta.nextCursor).toBeUndefined();
  });

  it("calls getSignalHistory with correct args", async () => {
    getSignalHistoryMock.mockResolvedValue({ outcomes: [], hasMore: false, nextCursor: undefined });

    const app = await loadApp();
    await app.request("/history?pair=ETH%2FUSDT&window=7d&limit=20");

    expect(getSignalHistoryMock).toHaveBeenCalledWith("ETH/USDT", "7d", 20, undefined);
  });

  it("passes cursor to getSignalHistory", async () => {
    getSignalHistoryMock.mockResolvedValue({ outcomes: [], hasMore: false, nextCursor: undefined });

    const app = await loadApp();
    await app.request("/history?pair=BTC%2FUSDT&cursor=abc123");

    expect(getSignalHistoryMock).toHaveBeenCalledWith(
      "BTC/USDT",
      expect.any(String),
      expect.any(Number),
      "abc123",
    );
  });

  it("returns hasMore=true and nextCursor when more pages exist", async () => {
    getSignalHistoryMock.mockResolvedValue({
      outcomes: [outcomeEntry],
      hasMore: true,
      nextCursor: "cursor_xyz",
    });

    const app = await loadApp();
    const res = await app.request("/history?pair=BTC%2FUSDT");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.meta.hasMore).toBe(true);
    expect(body.data.meta.nextCursor).toBe("cursor_xyz");
  });

  it("returns empty outcomes array when no data exists", async () => {
    getSignalHistoryMock.mockResolvedValue({ outcomes: [], hasMore: false, nextCursor: undefined });

    const app = await loadApp();
    const res = await app.request("/history?pair=BTC%2FUSDT");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.outcomes).toEqual([]);
  });

  it("uses default window of 30d when not specified", async () => {
    getSignalHistoryMock.mockResolvedValue({ outcomes: [], hasMore: false, nextCursor: undefined });

    const app = await loadApp();
    await app.request("/history?pair=BTC%2FUSDT");

    expect(getSignalHistoryMock).toHaveBeenCalledWith(
      "BTC/USDT",
      "30d",
      expect.any(Number),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// GET /accuracy
// ---------------------------------------------------------------------------

describe("GET /accuracy", () => {
  it("returns 200 with accuracy badge", async () => {
    getAccuracyAggregateMock.mockResolvedValue(accuracyBadge);

    const app = await loadApp();
    const res = await app.request("/accuracy?pair=BTC%2FUSDT&timeframe=1h&window=30d");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.accuracy.pair).toBe("BTC/USDT");
    expect(body.data.accuracy.timeframe).toBe("1h");
    expect(body.data.accuracy.totalResolved).toBe(100);
    expect(body.data.accuracy.correctCount).toBe(60);
    expect(body.data.accuracy.accuracyPct).toBeCloseTo(0.6667, 3);
    expect(body.data.accuracy.brier).toBe(0.18);
    expect(body.data.accuracy.ece).toBe(0.04);
  });

  it("calls getAccuracyAggregate with pair, timeframe, and window", async () => {
    getAccuracyAggregateMock.mockResolvedValue(accuracyBadge);

    const app = await loadApp();
    await app.request("/accuracy?pair=ETH%2FUSDT&timeframe=4h&window=90d");

    expect(getAccuracyAggregateMock).toHaveBeenCalledWith("ETH/USDT", "4h", "90d");
  });

  it("returns 404 when no aggregate exists for the pair+timeframe+window", async () => {
    getAccuracyAggregateMock.mockResolvedValue(null);

    const app = await loadApp();
    const res = await app.request("/accuracy?pair=BTC%2FUSDT&timeframe=1h&window=7d");
    expect(res.status).toBe(404);

    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("uses default window of 30d when only pair+timeframe provided", async () => {
    getAccuracyAggregateMock.mockResolvedValue(accuracyBadge);

    const app = await loadApp();
    await app.request("/accuracy?pair=BTC%2FUSDT&timeframe=1h");

    expect(getAccuracyAggregateMock).toHaveBeenCalledWith("BTC/USDT", "1h", "30d");
  });

  it("returns 400 when timeframe is omitted (now required)", async () => {
    const app = await loadApp();
    const res = await app.request("/accuracy?pair=BTC%2FUSDT&window=30d");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /calibration
// ---------------------------------------------------------------------------

describe("GET /calibration", () => {
  it("returns 200 with calibration bins", async () => {
    const bins = Array.from({ length: 10 }, (_, i) => ({
      ...calibrationBin,
      binLow: i / 10,
      binHigh: (i + 1) / 10,
      count: i === 7 ? 15 : 0,
    }));
    getCalibrationDataMock.mockResolvedValue({ totalUsed: 15, bins });

    const app = await loadApp();
    const res = await app.request("/calibration?pair=BTC%2FUSDT&timeframe=1h&window=90d");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.pair).toBe("BTC/USDT");
    expect(body.data.timeframe).toBe("1h");
    expect(body.data.window).toBe("90d");
    expect(body.data.totalUsed).toBe(15);
    expect(body.data.bins).toHaveLength(10);
  });

  it("calls getCalibrationData with correct args", async () => {
    getCalibrationDataMock.mockResolvedValue({ totalUsed: 0, bins: [] });

    const app = await loadApp();
    await app.request("/calibration?pair=ETH%2FUSDT&timeframe=4h&window=30d");

    expect(getCalibrationDataMock).toHaveBeenCalledWith("ETH/USDT", "4h", "30d");
  });

  it("uses default timeframe=1h and window=90d when not specified", async () => {
    getCalibrationDataMock.mockResolvedValue({ totalUsed: 0, bins: [] });

    const app = await loadApp();
    await app.request("/calibration?pair=BTC%2FUSDT");

    expect(getCalibrationDataMock).toHaveBeenCalledWith("BTC/USDT", "1h", "90d");
  });

  it("returns 200 with totalUsed=0 and empty bins when no data", async () => {
    getCalibrationDataMock.mockResolvedValue({ totalUsed: 0, bins: [] });

    const app = await loadApp();
    const res = await app.request("/calibration?pair=BTC%2FUSDT");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.totalUsed).toBe(0);
    expect(body.data.bins).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /attribution
// ---------------------------------------------------------------------------

describe("GET /attribution", () => {
  it("returns 200 with rules list", async () => {
    getRuleAttributionDataMock.mockResolvedValue([ruleEntry]);

    const app = await loadApp();
    const res = await app.request("/attribution?pair=BTC%2FUSDT&timeframe=1h&window=30d");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.pair).toBe("BTC/USDT");
    expect(body.data.timeframe).toBe("1h");
    expect(body.data.window).toBe("30d");
    expect(body.data.rules).toHaveLength(1);
    expect(body.data.rules[0].rule).toBe("rsi_oversold");
    expect(body.data.rules[0].fireCount).toBe(40);
    expect(body.data.rules[0].contribution).toBeCloseTo(0.7368, 3);
  });

  it("calls getRuleAttributionData with correct args", async () => {
    getRuleAttributionDataMock.mockResolvedValue([]);

    const app = await loadApp();
    await app.request("/attribution?pair=SOL%2FUSDT&timeframe=4h&window=90d");

    expect(getRuleAttributionDataMock).toHaveBeenCalledWith("SOL/USDT", "4h", "90d");
  });

  it("uses default timeframe=1h and window=30d when not specified", async () => {
    getRuleAttributionDataMock.mockResolvedValue([]);

    const app = await loadApp();
    await app.request("/attribution?pair=BTC%2FUSDT");

    expect(getRuleAttributionDataMock).toHaveBeenCalledWith("BTC/USDT", "1h", "30d");
  });

  it("returns empty rules array when no attribution data exists", async () => {
    getRuleAttributionDataMock.mockResolvedValue([]);

    const app = await loadApp();
    const res = await app.request("/attribution?pair=BTC%2FUSDT");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.rules).toEqual([]);
  });

  it("includes contribution=null for rules with no directional outcomes", async () => {
    getRuleAttributionDataMock.mockResolvedValue([{ ...ruleEntry, contribution: null }]);

    const app = await loadApp();
    const res = await app.request("/attribution?pair=BTC%2FUSDT");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.rules[0].contribution).toBeNull();
  });
});
