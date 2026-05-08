import { describe, it, expect, vi, beforeEach } from "vitest";

const getStatusMock = vi.fn();
const getMarketMock = vi.fn();
const getNewsMock = vi.fn();
const getWhitelistMock = vi.fn();
const setWhitelistMock = vi.fn();
const getSignalsMock = vi.fn();

vi.mock("../services/admin.service.js", () => ({
  getStatus: getStatusMock,
  getMarket: getMarketMock,
  getNews: getNewsMock,
  getWhitelist: getWhitelistMock,
  setWhitelist: setWhitelistMock,
  getSignals: getSignalsMock,
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
  getWhitelistMock.mockReset();
  setWhitelistMock.mockReset();
  getSignalsMock.mockReset();
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
