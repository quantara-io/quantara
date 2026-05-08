/**
 * Tests for genie.ts — trading signals route.
 *
 * Covers:
 *   - Valid pair → 200 with null signal
 *   - Invalid pair → 404 with UNKNOWN_PAIR error
 *   - getAllSignals → 200 with empty signals array
 *   - signal-service bootstrap is called (user record created on first read)
 *   - /history → 200 with paginated results from getSignalHistoryForUser
 *   - /history → passes cursor, pair, pageSize to service
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal response shapes for the test assertions.
type SignalsBody = {
  success: boolean;
  data: { signals: unknown[]; disclaimer: string };
};
type SignalByPairBody = {
  success: boolean;
  data: { signal: unknown | null; disclaimer: string };
  error?: { code: string; message?: string };
};
type HistoryBody = {
  success: boolean;
  data: {
    history: unknown[];
    meta: { total: number; hasMore: boolean; nextCursor?: string };
  };
};

// Mock signal-service so tests don't touch DynamoDB.
const getSignalForUserMock = vi.fn();
const getAllSignalsForUserMock = vi.fn();
const getSignalHistoryForUserMock = vi.fn();

vi.mock("../lib/signal-service.js", () => ({
  PAIRS: ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"] as const,
  getSignalForUser: getSignalForUserMock,
  getAllSignalsForUser: getAllSignalsForUserMock,
  getSignalHistoryForUser: getSignalHistoryForUserMock,
}));

// Inject fake auth context for all genie routes (protected by requireAuth).
const fakeAuth = {
  userId: "user_genie_1",
  email: "genie@b.com",
  emailVerified: true,
  authMethod: "password",
  sessionId: "sess_genie",
  role: "user",
};
vi.mock("../middleware/require-auth.js", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("auth", fakeAuth);
    await next();
  },
}));

beforeEach(() => {
  vi.resetModules();
  getSignalForUserMock.mockReset();
  getAllSignalsForUserMock.mockReset();
  getSignalHistoryForUserMock.mockReset();
  // Default: return empty history
  getSignalHistoryForUserMock.mockResolvedValue({
    history: [],
    total: 0,
    hasMore: false,
    nextCursor: undefined,
  });
});

async function loadApp() {
  const { genie } = await import("./genie.js");
  return genie;
}

// ---------------------------------------------------------------------------
// GET /signals
// ---------------------------------------------------------------------------

describe("GET /signals", () => {
  it("returns 200 with empty signals array when no signals are available", async () => {
    getAllSignalsForUserMock.mockResolvedValue([]);
    const app = await loadApp();
    const res = await app.request("/signals");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignalsBody;
    expect(body.success).toBe(true);
    expect(body.data.signals).toEqual([]);
    expect(typeof body.data.disclaimer).toBe("string");
  });

  it("calls getAllSignalsForUser with the authenticated userId and email", async () => {
    getAllSignalsForUserMock.mockResolvedValue([]);
    const app = await loadApp();
    await app.request("/signals");
    expect(getAllSignalsForUserMock).toHaveBeenCalledWith(fakeAuth.userId, fakeAuth.email);
  });
});

// ---------------------------------------------------------------------------
// GET /signals/:pair
// ---------------------------------------------------------------------------

describe("GET /signals/:pair — valid pair", () => {
  it("returns 200 with null signal for a known pair", async () => {
    getSignalForUserMock.mockResolvedValue(null);
    const app = await loadApp();
    const res = await app.request("/signals/BTC%2FUSDT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignalByPairBody & { data: { pair: string } };
    expect(body.success).toBe(true);
    expect(body.data.pair).toBe("BTC/USDT");
    expect(body.data.signal).toBeNull();
  });

  it("calls getSignalForUser with userId, pair, and email", async () => {
    getSignalForUserMock.mockResolvedValue(null);
    const app = await loadApp();
    await app.request("/signals/ETH%2FUSDT");
    expect(getSignalForUserMock).toHaveBeenCalledWith(fakeAuth.userId, "ETH/USDT", fakeAuth.email);
  });
});

describe("GET /signals/:pair — invalid pair", () => {
  it("returns 404 with UNKNOWN_PAIR code for an unrecognized pair", async () => {
    const app = await loadApp();
    const res = await app.request("/signals/FAKE%2FPAIR");
    expect(res.status).toBe(404);
    const body = (await res.json()) as SignalByPairBody;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("UNKNOWN_PAIR");
    expect(body.error?.message).toContain("FAKE/PAIR");
  });

  it("does NOT call getSignalForUser for invalid pairs", async () => {
    const app = await loadApp();
    await app.request("/signals/INVALID");
    expect(getSignalForUserMock).not.toHaveBeenCalled();
  });

  it("returns 404 for lowercase pair variations", async () => {
    const app = await loadApp();
    const res = await app.request("/signals/btc-usdt");
    expect(res.status).toBe(404);
    const body = (await res.json()) as SignalByPairBody;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("UNKNOWN_PAIR");
  });
});

// ---------------------------------------------------------------------------
// GET /history
// ---------------------------------------------------------------------------

describe("GET /history", () => {
  it("returns 200 with empty history when no records exist", async () => {
    const app = await loadApp();
    const res = await app.request("/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryBody;
    expect(body.success).toBe(true);
    expect(body.data.history).toEqual([]);
    expect(body.data.meta.total).toBe(0);
    expect(body.data.meta.hasMore).toBe(false);
  });

  it("calls getSignalHistoryForUser with authenticated user and pageSize", async () => {
    const app = await loadApp();
    await app.request("/history?pageSize=10");
    expect(getSignalHistoryForUserMock).toHaveBeenCalledWith(
      fakeAuth.userId,
      fakeAuth.email,
      expect.objectContaining({ pageSize: 10 }),
    );
  });

  it("passes pair filter when provided", async () => {
    const app = await loadApp();
    await app.request("/history?pair=BTC%2FUSDT");
    expect(getSignalHistoryForUserMock).toHaveBeenCalledWith(
      fakeAuth.userId,
      fakeAuth.email,
      expect.objectContaining({ pair: "BTC/USDT" }),
    );
  });

  it("returns history entries and meta from getSignalHistoryForUser", async () => {
    const historyEntry = {
      signalId: "sig-001",
      pair: "BTC/USDT",
      type: "buy",
      confidence: 0.72,
      createdAt: "2024-01-01T00:00:00.000Z",
      outcome: "correct",
      priceAtSignal: 45000,
      priceAtResolution: 46000,
    };
    getSignalHistoryForUserMock.mockResolvedValueOnce({
      history: [historyEntry],
      total: 1,
      hasMore: false,
      nextCursor: undefined,
    });

    const app = await loadApp();
    const res = await app.request("/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryBody;
    expect(body.data.history).toHaveLength(1);
    expect(body.data.meta.total).toBe(1);
    expect(body.data.meta.hasMore).toBe(false);
  });

  it("includes nextCursor in meta when hasMore is true", async () => {
    getSignalHistoryForUserMock.mockResolvedValueOnce({
      history: [],
      total: 0,
      hasMore: true,
      nextCursor: "abc123cursor",
    });

    const app = await loadApp();
    const res = await app.request("/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryBody;
    expect(body.data.meta.hasMore).toBe(true);
    expect(body.data.meta.nextCursor).toBe("abc123cursor");
  });

  it("accepts cursor query param and passes to getSignalHistoryForUser", async () => {
    const app = await loadApp();
    await app.request("/history?cursor=someCursor123");
    expect(getSignalHistoryForUserMock).toHaveBeenCalledWith(
      fakeAuth.userId,
      fakeAuth.email,
      expect.objectContaining({ cursor: "someCursor123" }),
    );
  });

  it("uses default pageSize of 20 when not specified", async () => {
    const app = await loadApp();
    await app.request("/history");
    expect(getSignalHistoryForUserMock).toHaveBeenCalledWith(
      fakeAuth.userId,
      fakeAuth.email,
      expect.objectContaining({ pageSize: 20 }),
    );
  });
});
