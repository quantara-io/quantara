import { describe, it, expect, vi, beforeEach } from "vitest";

const getStatusMock = vi.fn();
const getMarketMock = vi.fn();
const getNewsMock = vi.fn();
const getNewsUsageMock = vi.fn();
const getWhitelistMock = vi.fn();
const setWhitelistMock = vi.fn();
const getSignalsMock = vi.fn();
const getGenieMetricsMock = vi.fn();
const getPipelineStateMock = vi.fn();

vi.mock("../services/admin.service.js", () => ({
  getStatus: getStatusMock,
  getMarket: getMarketMock,
  getNews: getNewsMock,
  getNewsUsage: getNewsUsageMock,
  getWhitelist: getWhitelistMock,
  setWhitelist: setWhitelistMock,
  getSignals: getSignalsMock,
  getGenieMetrics: getGenieMetricsMock,
}));

vi.mock("../services/pipeline-state.service.js", () => ({
  getPipelineState: getPipelineStateMock,
}));

let currentAuth: Record<string, unknown> = {
  userId: "user_admin",
  email: "admin@example.com",
  emailVerified: true,
  authMethod: "password",
  sessionId: "sess_admin",
  role: "admin",
};

vi.mock("../middleware/require-auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("auth", currentAuth);
    await next();
  },
}));

beforeEach(() => {
  vi.resetModules();
  getStatusMock.mockReset();
  getMarketMock.mockReset();
  getNewsMock.mockReset();
  getNewsUsageMock.mockReset();
  getWhitelistMock.mockReset();
  setWhitelistMock.mockReset();
  getSignalsMock.mockReset();
  getGenieMetricsMock.mockReset();
  getPipelineStateMock.mockReset();
  currentAuth = {
    userId: "user_admin",
    email: "admin@example.com",
    emailVerified: true,
    authMethod: "password",
    sessionId: "sess_admin",
    role: "admin",
  };
});

async function loadApp() {
  const { admin } = await import("./admin.js");
  return admin;
}

describe("admin route auth", () => {
  it("returns 403 when the auth context's role is not admin", async () => {
    currentAuth = { ...currentAuth, role: "user" };
    const app = await loadApp();
    const res = await app.request("/status");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

describe("GET /status", () => {
  it("returns wrapped service result", async () => {
    getStatusMock.mockResolvedValue({ tableCounts: [], timestamp: "2026-04-25T00:00:00Z" });
    const app = await loadApp();
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { tableCounts: [], timestamp: "2026-04-25T00:00:00Z" },
    });
  });
});

describe("GET /market", () => {
  it("uses default pair and exchange when no query params are given", async () => {
    getMarketMock.mockResolvedValue({
      pair: "BTC/USDT",
      exchange: "binanceus",
      prices: [],
      candles: [],
      fearGreed: null,
    });
    const app = await loadApp();
    const res = await app.request("/market");
    expect(res.status).toBe(200);
    expect(getMarketMock).toHaveBeenCalledWith("BTC/USDT", "binanceus");
  });

  it("forwards pair and exchange query params", async () => {
    getMarketMock.mockResolvedValue({
      pair: "ETH/USDT",
      exchange: "kraken",
      prices: [],
      candles: [],
      fearGreed: null,
    });
    const app = await loadApp();
    const res = await app.request("/market?pair=ETH/USDT&exchange=kraken");
    expect(res.status).toBe(200);
    expect(getMarketMock).toHaveBeenCalledWith("ETH/USDT", "kraken");
  });
});

describe("GET /news", () => {
  it("defaults limit to 50", async () => {
    getNewsMock.mockResolvedValue({ news: [], fearGreed: null });
    const app = await loadApp();
    const res = await app.request("/news");
    expect(res.status).toBe(200);
    expect(getNewsMock).toHaveBeenCalledWith(50);
  });

  it("forwards a numeric limit query param", async () => {
    getNewsMock.mockResolvedValue({ news: [], fearGreed: null });
    const app = await loadApp();
    const res = await app.request("/news?limit=10");
    expect(res.status).toBe(200);
    expect(getNewsMock).toHaveBeenCalledWith(10);
  });
});

describe("GET /whitelist", () => {
  it("returns the wrapped ips array", async () => {
    getWhitelistMock.mockResolvedValue({ ips: ["1.2.3.4"] });
    const app = await loadApp();
    const res = await app.request("/whitelist");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { ips: ["1.2.3.4"] } });
  });
});

describe("PUT /whitelist", () => {
  it("rejects bodies missing 'ips'", async () => {
    const app = await loadApp();
    const res = await app.request("/whitelist", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(setWhitelistMock).not.toHaveBeenCalled();
  });

  it("rejects bodies where ips is not an array of strings", async () => {
    const app = await loadApp();
    const res = await app.request("/whitelist", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ips: ["1.1.1.1", 42] }),
    });
    expect(res.status).toBe(400);
    expect(setWhitelistMock).not.toHaveBeenCalled();
  });

  it("calls setWhitelist with valid input and returns the wrapped result", async () => {
    setWhitelistMock.mockResolvedValue({ ips: ["1.1.1.1", "2.2.2.0/24"] });
    const app = await loadApp();
    const res = await app.request("/whitelist", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ips: ["1.1.1.1", "2.2.2.0/24"] }),
    });
    expect(res.status).toBe(200);
    expect(setWhitelistMock).toHaveBeenCalledWith(["1.1.1.1", "2.2.2.0/24"]);
    expect(await res.json()).toEqual({
      success: true,
      data: { ips: ["1.1.1.1", "2.2.2.0/24"] },
    });
  });
});

describe("GET /signals", () => {
  it("returns 400 when pair is missing", async () => {
    const app = await loadApp();
    const res = await app.request("/signals");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(getSignalsMock).not.toHaveBeenCalled();
  });

  it("returns 400 when pair is not in PAIRS", async () => {
    const app = await loadApp();
    const res = await app.request("/signals?pair=INVALID/USDT");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(getSignalsMock).not.toHaveBeenCalled();
  });

  it("returns 400 when limit is out of range", async () => {
    const app = await loadApp();
    const res = await app.request("/signals?pair=BTC%2FUSDT&limit=0");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(getSignalsMock).not.toHaveBeenCalled();
  });

  it("returns 200 with empty signals array when DDB returns no items", async () => {
    getSignalsMock.mockResolvedValue([]);
    const app = await loadApp();
    const res = await app.request("/signals?pair=BTC%2FUSDT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { signals: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.signals).toEqual([]);
    expect(getSignalsMock).toHaveBeenCalled();
  });

  it("returns 200 with signal items passed through verbatim", async () => {
    const mockSignal = {
      pair: "BTC/USDT",
      type: "buy",
      confidence: 0.85,
      volatilityFlag: false,
      gateReason: null,
      rulesFired: ["ema_cross", "rsi_oversold"],
      perTimeframe: {},
      weightsUsed: {},
      asOf: 1700000000000,
      emittingTimeframe: "1m",
      signalId: "abc123",
      emittedAt: "2025-01-01T00:00:00.000Z",
    };
    getSignalsMock.mockResolvedValue([mockSignal]);
    const app = await loadApp();
    const res = await app.request("/signals?pair=BTC%2FUSDT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { signals: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.signals).toHaveLength(1);
    expect(body.data.signals[0]).toEqual(mockSignal);
  });
});

describe("GET /news/usage", () => {
  const mockUsage = {
    articlesEnriched: 42,
    totalInputTokens: 100_000,
    totalOutputTokens: 20_000,
    estimatedCostUsd: 0.16,
    byModel: {
      "anthropic.claude-haiku-4-5": {
        calls: 84,
        inputTokens: 100_000,
        outputTokens: 20_000,
        costUsd: 0.16,
      },
    },
  };

  it("returns usage data with default since (24h ago) when no query param given", async () => {
    getNewsUsageMock.mockResolvedValue(mockUsage);
    const app = await loadApp();
    const res = await app.request("/news/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: typeof mockUsage };
    expect(body.success).toBe(true);
    expect(body.data.articlesEnriched).toBe(42);
    expect(body.data.totalInputTokens).toBe(100_000);
    expect(body.data.estimatedCostUsd).toBe(0.16);
    expect(getNewsUsageMock).toHaveBeenCalledOnce();
    const calledWith = getNewsUsageMock.mock.calls[0][0] as Date;
    // Should default to ~24h ago, bounded on both sides — the previous
    // single-sided check (`< 24h + 5s`) would pass for any recent past time
    // including `now - 1s`, defeating the assertion.
    const ageMs = Date.now() - calledWith.getTime();
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    expect(ageMs).toBeGreaterThanOrEqual(TWENTY_FOUR_HOURS_MS - 5_000);
    expect(ageMs).toBeLessThanOrEqual(TWENTY_FOUR_HOURS_MS + 5_000);
  });

  it("forwards the since query param as a Date", async () => {
    getNewsUsageMock.mockResolvedValue(mockUsage);
    const app = await loadApp();
    const since = "2026-05-07T00:00:00.000Z";
    const res = await app.request(`/news/usage?since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
    const calledWith = getNewsUsageMock.mock.calls[0][0] as Date;
    expect(calledWith.toISOString()).toBe(since);
  });

  it("returns 400 when since is not a valid ISO date", async () => {
    const app = await loadApp();
    const res = await app.request("/news/usage?since=not-a-date");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(getNewsUsageMock).not.toHaveBeenCalled();
  });

  it("returns byModel breakdown in the response", async () => {
    getNewsUsageMock.mockResolvedValue(mockUsage);
    const app = await loadApp();
    const res = await app.request("/news/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof mockUsage };
    expect(Object.keys(body.data.byModel)).toContain("anthropic.claude-haiku-4-5");
    expect(body.data.byModel["anthropic.claude-haiku-4-5"].calls).toBe(84);
  });
});

describe("GET /market (extended)", () => {
  it("returns indicators as null when service returns null", async () => {
    getMarketMock.mockResolvedValue({
      pair: "BTC/USDT",
      exchange: "binanceus",
      prices: [],
      candles: [],
      fearGreed: null,
      indicators: null,
      dispersion: null,
    });
    const app = await loadApp();
    const res = await app.request("/market?pair=BTC/USDT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { indicators: unknown; dispersion: unknown } };
    expect(body.data.indicators).toBeNull();
  });

  it("returns full indicator state when present", async () => {
    const mockIndicators = {
      pair: "BTC/USDT",
      exchange: "binanceus",
      timeframe: "1m",
      asOf: 1700000000000,
      barsSinceStart: 100,
      rsi14: 55.2,
      ema20: 42000,
      ema50: 41000,
      ema200: 38000,
      macdLine: 100,
      macdSignal: 90,
      macdHist: 10,
      atr14: 500,
      bbUpper: 43000,
      bbMid: 42000,
      bbLower: 41000,
      bbWidth: 0.047,
      obv: 1000000,
      obvSlope: 500,
      vwap: 41800,
      volZ: 1.2,
      realizedVolAnnualized: 0.72,
      fearGreed: 55,
      dispersion: 0.0012,
      history: { rsi14: [], macdHist: [], ema20: [], ema50: [], close: [], volume: [] },
    };
    getMarketMock.mockResolvedValue({
      pair: "BTC/USDT",
      exchange: "binanceus",
      prices: [],
      candles: [],
      fearGreed: null,
      indicators: mockIndicators,
      dispersion: 0.0012,
    });
    const app = await loadApp();
    const res = await app.request("/market?pair=BTC/USDT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { indicators: unknown; dispersion: number } };
    expect(body.data.indicators).toEqual(mockIndicators);
    expect(body.data.dispersion).toBeCloseTo(0.0012);
  });

  it("returns dispersion as null when only one price returned", async () => {
    getMarketMock.mockResolvedValue({
      pair: "BTC/USDT",
      exchange: "binanceus",
      prices: [
        {
          pair: "BTC/USDT",
          exchange: "binanceus",
          price: 42000,
          stale: false,
          timestamp: "2025-01-01T00:00:00Z",
        },
      ],
      candles: [],
      fearGreed: null,
      indicators: null,
      dispersion: null,
    });
    const app = await loadApp();
    const res = await app.request("/market?pair=BTC/USDT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { dispersion: unknown } };
    expect(body.data.dispersion).toBeNull();
  });

  it("returns correct dispersion when multiple prices returned", async () => {
    const dispersion = (43000 - 41000) / 42000;
    getMarketMock.mockResolvedValue({
      pair: "BTC/USDT",
      exchange: "binanceus",
      prices: [
        {
          pair: "BTC/USDT",
          exchange: "binanceus",
          price: 43000,
          stale: false,
          timestamp: "2025-01-01T00:00:00Z",
        },
        {
          pair: "BTC/USDT",
          exchange: "kraken",
          price: 41000,
          stale: false,
          timestamp: "2025-01-01T00:00:00Z",
        },
      ],
      candles: [],
      fearGreed: null,
      indicators: null,
      dispersion,
    });
    const app = await loadApp();
    const res = await app.request("/market?pair=BTC/USDT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { dispersion: number } };
    expect(body.data.dispersion).toBeCloseTo(dispersion);
  });
});

describe("GET /genie-metrics", () => {
  const mockMetrics = {
    windowStart: "2026-05-02T00:00:00.000Z",
    windowEnd: "2026-05-09T00:00:00.000Z",
    total: {
      signalCount: 10,
      ratifiedCount: 6,
      downgradedCount: 1,
      gatedCount: 3,
      fallbackCount: 0,
    },
    outcomes: { tp: 4, sl: 2, neutral: 1, pending: 3 },
    winRate: { overall: 0.667, algoOnly: 0.5, llmRatified: 0.8, llmDowngraded: 0.4 },
    cost: { totalUsd: 0.12, avgPerSignalUsd: 0.012, avgPerTpUsd: 0.03, cacheHitRate: 0.2 },
    gating: {
      skipLowConfidence: 1,
      skipRateLimit: 1,
      skipDailyCap: 1,
      skipNotRequired: 0,
      invoked: 7,
    },
  };

  it("returns metrics from service with default params", async () => {
    getGenieMetricsMock.mockResolvedValue(mockMetrics);
    const app = await loadApp();
    const res = await app.request("/genie-metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: typeof mockMetrics };
    expect(body.success).toBe(true);
    expect(body.data.total.signalCount).toBe(10);
    expect(body.data.outcomes.tp).toBe(4);
    expect(getGenieMetricsMock).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it("forwards since, pair, and timeframe query params to the service", async () => {
    getGenieMetricsMock.mockResolvedValue(mockMetrics);
    const app = await loadApp();
    const since = "2026-05-01T00:00:00.000Z";
    const res = await app.request(
      `/genie-metrics?since=${encodeURIComponent(since)}&pair=ETH%2FUSDT&timeframe=1h`,
    );
    expect(res.status).toBe(200);
    expect(getGenieMetricsMock).toHaveBeenCalledWith(since, "ETH/USDT", "1h");
  });

  it("returns 400 when since is not a valid ISO date", async () => {
    const app = await loadApp();
    const res = await app.request("/genie-metrics?since=not-a-date");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(getGenieMetricsMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not admin", async () => {
    currentAuth = { ...currentAuth, role: "user" };
    const app = await loadApp();
    const res = await app.request("/genie-metrics");
    expect(res.status).toBe(403);
    expect(getGenieMetricsMock).not.toHaveBeenCalled();
  });
});

describe("GET /pipeline-state", () => {
  it("returns 200 with cells from the service", async () => {
    getPipelineStateMock.mockResolvedValue({
      cells: [],
      generatedAt: "2026-05-09T00:00:00Z",
    });
    const app = await loadApp();
    const res = await app.request("/pipeline-state");
    expect(res.status).toBe(200);
    expect(getPipelineStateMock).toHaveBeenCalledWith(undefined);
    const body = (await res.json()) as { success: boolean; data: { cells: unknown[] } };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.cells)).toBe(true);
  });

  it("forwards a valid pair to the service", async () => {
    getPipelineStateMock.mockResolvedValue({ cells: [], generatedAt: "2026-05-09T00:00:00Z" });
    const app = await loadApp();
    const res = await app.request("/pipeline-state?pair=BTC/USDT");
    expect(res.status).toBe(200);
    expect(getPipelineStateMock).toHaveBeenCalledWith("BTC/USDT");
  });

  it("returns 400 when pair is not in PAIRS", async () => {
    const app = await loadApp();
    const res = await app.request("/pipeline-state?pair=FOO/BAR");
    expect(res.status).toBe(400);
    expect(getPipelineStateMock).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects non-admin auth context with 403", async () => {
    currentAuth = { ...currentAuth, role: "user" };
    const app = await loadApp();
    const res = await app.request("/pipeline-state");
    expect(res.status).toBe(403);
    expect(getPipelineStateMock).not.toHaveBeenCalled();
  });
});
