/**
 * Tests for users.ts — PATCH /me/settings route.
 *
 * Covers:
 *   - Happy path: full riskProfiles + blendProfiles patch → 200 with merged UserProfile
 *   - Partial merge: only patched pairs change; untouched pairs are preserved
 *   - Validation rejection: unknown trading pair → 400
 *   - Validation rejection: invalid profile value → 400
 *   - Auth rejection: missing Authorization header → 401
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked profile returned by getOrCreateUserRecord.
const existingProfile = {
  userId: "user_test_1",
  email: "test@example.com",
  displayName: "Test User",
  userType: "retail" as const,
  tier: "free" as const,
  riskProfiles: {
    "BTC/USDT": "conservative",
    "ETH/USDT": "conservative",
    "SOL/USDT": "conservative",
    "XRP/USDT": "conservative",
    "DOGE/USDT": "conservative",
  },
  blendProfiles: {
    "BTC/USDT": "strict",
    "ETH/USDT": "strict",
    "SOL/USDT": "strict",
    "XRP/USDT": "strict",
    "DOGE/USDT": "strict",
  },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const getOrCreateUserRecordMock = vi.fn();
const putUserUncheckedMock = vi.fn();

vi.mock("../lib/user-store.js", () => ({
  getOrCreateUserRecord: getOrCreateUserRecordMock,
  putUserUnchecked: putUserUncheckedMock,
}));

// Inject fake auth context.
const fakeAuth = {
  userId: "user_test_1",
  email: "test@example.com",
  emailVerified: true,
  authMethod: "password",
  sessionId: "sess_test",
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
  getOrCreateUserRecordMock.mockReset();
  putUserUncheckedMock.mockReset();
  getOrCreateUserRecordMock.mockResolvedValue({ ...existingProfile });
  putUserUncheckedMock.mockResolvedValue(undefined);
});

async function loadApp() {
  const { users } = await import("./users.js");
  return users;
}

function jsonRequest(body: unknown) {
  return {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("PATCH /me/settings — happy path", () => {
  it("returns 200 with full UserProfile on valid riskProfiles patch", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ riskProfiles: { "BTC/USDT": "aggressive" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.riskProfiles["BTC/USDT"]).toBe("aggressive");
    expect(body.data.userId).toBe("user_test_1");
  });

  it("returns 200 with full UserProfile on valid blendProfiles patch", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ blendProfiles: { "ETH/USDT": "balanced" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.blendProfiles["ETH/USDT"]).toBe("balanced");
  });

  it("returns 200 when patching both riskProfiles and blendProfiles", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({
        riskProfiles: { "SOL/USDT": "moderate" },
        blendProfiles: { "SOL/USDT": "aggressive" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.riskProfiles["SOL/USDT"]).toBe("moderate");
    expect(body.data.blendProfiles["SOL/USDT"]).toBe("aggressive");
  });

  it("calls putUserUnchecked with the merged profile", async () => {
    const app = await loadApp();
    await app.request("/me/settings", jsonRequest({ riskProfiles: { "BTC/USDT": "aggressive" } }));
    expect(putUserUncheckedMock).toHaveBeenCalledOnce();
    const saved = putUserUncheckedMock.mock.calls[0][0];
    expect(saved.riskProfiles["BTC/USDT"]).toBe("aggressive");
    expect(saved.userId).toBe("user_test_1");
  });

  it("sets updatedAt to a new ISO timestamp", async () => {
    const app = await loadApp();
    const before = new Date().toISOString();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ riskProfiles: { "BTC/USDT": "moderate" } }),
    );
    const after = new Date().toISOString();
    const body = (await res.json()) as any;
    expect(body.data.updatedAt >= before).toBe(true);
    expect(body.data.updatedAt <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Partial merge — untouched pairs must be preserved
// ---------------------------------------------------------------------------

describe("PATCH /me/settings — partial merge", () => {
  it("preserves riskProfile pairs not mentioned in the patch", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ riskProfiles: { "BTC/USDT": "aggressive" } }),
    );
    const body = (await res.json()) as any;
    expect(body.data.riskProfiles["ETH/USDT"]).toBe("conservative");
    expect(body.data.riskProfiles["SOL/USDT"]).toBe("conservative");
    expect(body.data.riskProfiles["XRP/USDT"]).toBe("conservative");
    expect(body.data.riskProfiles["DOGE/USDT"]).toBe("conservative");
  });

  it("preserves blendProfile pairs not mentioned in the patch", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ blendProfiles: { "BTC/USDT": "balanced" } }),
    );
    const body = (await res.json()) as any;
    expect(body.data.blendProfiles["ETH/USDT"]).toBe("strict");
    expect(body.data.blendProfiles["SOL/USDT"]).toBe("strict");
    expect(body.data.blendProfiles["XRP/USDT"]).toBe("strict");
    expect(body.data.blendProfiles["DOGE/USDT"]).toBe("strict");
  });

  it("preserves riskProfiles when only blendProfiles is patched", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ blendProfiles: { "SOL/USDT": "aggressive" } }),
    );
    const body = (await res.json()) as any;
    // All risk profiles should still be "conservative" (unchanged)
    for (const pair of ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"]) {
      expect(body.data.riskProfiles[pair]).toBe("conservative");
    }
  });

  it("handles user with no blendProfiles (pre-302 record) — seeds from empty", async () => {
    getOrCreateUserRecordMock.mockResolvedValue({
      ...existingProfile,
      blendProfiles: undefined,
    });
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ blendProfiles: { "BTC/USDT": "aggressive" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.blendProfiles["BTC/USDT"]).toBe("aggressive");
  });
});

// ---------------------------------------------------------------------------
// Validation rejection — unknown pair
// ---------------------------------------------------------------------------

describe("PATCH /me/settings — unknown pair validation", () => {
  it("returns 400 for an unknown riskProfiles key", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ riskProfiles: { "FAKE/PAIR": "conservative" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("returns 400 for an unknown blendProfiles key", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ blendProfiles: { "NOTREAL/COIN": "strict" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation rejection — invalid profile value
// ---------------------------------------------------------------------------

describe("PATCH /me/settings — invalid profile value", () => {
  it("returns 400 for an invalid riskProfile value", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ riskProfiles: { "BTC/USDT": "yolo" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });

  it("returns 400 for an invalid blendProfile value", async () => {
    const app = await loadApp();
    const res = await app.request(
      "/me/settings",
      jsonRequest({ blendProfiles: { "ETH/USDT": "turbo" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth rejection
// ---------------------------------------------------------------------------

describe("PATCH /me/settings — auth rejection", () => {
  it("returns 401 when requireAuth rejects (no token)", async () => {
    // Override requireAuth for this test to simulate a rejection.
    vi.doMock("../middleware/require-auth.js", () => ({
      requireAuth: async (c: any, _next: any) => {
        return c.json(
          { success: false, error: { code: "UNAUTHORIZED", message: "Missing token" } },
          401,
        );
      },
    }));
    // Reload the app with the new mock.
    vi.resetModules();
    // Re-wire user-store mock after resetModules.
    vi.doMock("../lib/user-store.js", () => ({
      getOrCreateUserRecord: getOrCreateUserRecordMock,
      putUserUnchecked: putUserUncheckedMock,
    }));
    const { users: freshApp } = await import("./users.js");
    const res = await freshApp.request(
      "/me/settings",
      jsonRequest({ riskProfiles: { "BTC/USDT": "moderate" } }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
