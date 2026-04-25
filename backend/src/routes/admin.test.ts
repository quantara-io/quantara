import { describe, it, expect, vi, beforeEach } from "vitest";

const getStatusMock = vi.fn();
const getMarketMock = vi.fn();
const getNewsMock = vi.fn();
const getWhitelistMock = vi.fn();
const setWhitelistMock = vi.fn();

vi.mock("../services/admin.service.js", () => ({
  getStatus: getStatusMock,
  getMarket: getMarketMock,
  getNews: getNewsMock,
  getWhitelist: getWhitelistMock,
  setWhitelist: setWhitelistMock,
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
    getMarketMock.mockResolvedValue({ pair: "BTC/USDT", exchange: "binanceus", prices: [], candles: [], fearGreed: null });
    const app = await loadApp();
    const res = await app.request("/market");
    expect(res.status).toBe(200);
    expect(getMarketMock).toHaveBeenCalledWith("BTC/USDT", "binanceus");
  });

  it("forwards pair and exchange query params", async () => {
    getMarketMock.mockResolvedValue({ pair: "ETH/USDT", exchange: "kraken", prices: [], candles: [], fearGreed: null });
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
