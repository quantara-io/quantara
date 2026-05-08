import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass-through requireAuth — the real middleware is covered by require-auth.test.ts
vi.mock("../middleware/require-auth.js", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("auth", { userId: "user_123", email: "a@b.com" });
    await next();
  },
}));

beforeEach(() => {
  vi.resetModules();
});

async function loadApp() {
  const { genie } = await import("./genie.js");
  return genie;
}

describe("GET /signals", () => {
  it("returns an empty signals array with disclaimer", async () => {
    const app = await loadApp();
    const res = await app.request("/signals", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.signals)).toBe(true);
    expect(typeof body.data.disclaimer).toBe("string");
  });
});

describe("GET /signals/:pair — pair whitelisting", () => {
  it("returns signal=null for a valid pair in BTC/USDT form", async () => {
    const app = await loadApp();
    const res = await app.request("/signals/BTC%2FUSDT", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.signal).toBeNull();
    expect(body.data.pair).toBe("BTC/USDT");
  });

  it("accepts the dash-separated form BTC-USDT and normalises it", async () => {
    const app = await loadApp();
    const res = await app.request("/signals/BTC-USDT", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.pair).toBe("BTC/USDT");
  });

  it("returns 404 INVALID_PAIR for an unknown pair", async () => {
    const app = await loadApp();
    const res = await app.request("/signals/UNKNOWN-COIN", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INVALID_PAIR");
    expect(body.error.message).toContain("BTC/USDT");
  });

  it("returns 404 for a pair that is almost right but not in the list", async () => {
    const app = await loadApp();
    const res = await app.request("/signals/ETH-BTC", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_PAIR");
  });

  it("accepts all known pairs", async () => {
    const app = await loadApp();
    // Test a selection of known pairs in dash form
    for (const pair of ["ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"]) {
      const res = await app.request(`/signals/${pair}`, {
        headers: { Authorization: "Bearer user-jwt" },
      });
      expect(res.status, `expected 200 for ${pair}`).toBe(200);
    }
  });
});

describe("GET /history", () => {
  it("returns empty history with pagination meta", async () => {
    const app = await loadApp();
    const res = await app.request("/history", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.history)).toBe(true);
    expect(body.data.meta.page).toBe(1);
    expect(body.data.meta.pageSize).toBe(20);
  });
});
