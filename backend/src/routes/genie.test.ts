/**
 * Tests for backend/src/routes/genie.ts — Phase 7 follow-up (issue #87)
 *
 * Verifies Correction 1 (read-time risk attach) and Correction 3 (optional
 * riskProfiles / getEffectiveRiskProfiles):
 *
 * 1. User WITHOUT riskProfiles on their DDB record still gets a valid risk
 *    recommendation on GET /api/genie/signals (tier-default kicks in).
 * 2. User WITH explicit riskProfiles gets their tailored recommendation.
 * 3. When indicator state is unavailable, signal is returned with risk: null
 *    (graceful degradation).
 * 4. Unauthenticated requests are rejected (401).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Mock AWS SDK — before any imports that trigger module init
// ---------------------------------------------------------------------------

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({ send: sendMock })),
  },
  QueryCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Query" })),
  GetCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Get" })),
  PutCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Put" })),
  UpdateCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Update" })),
}));

// ---------------------------------------------------------------------------
// Mock jose (JWT verification)
// ---------------------------------------------------------------------------

const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER_ID = "user_test_123";

function makeSignalItem(pair: string, type: "buy" | "sell" | "hold" = "buy") {
  const asOf = 1700000000000;
  return {
    pair,
    type,
    confidence: 0.72,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: ["ema_cross_bullish"],
    perTimeframe: {
      "1m": null, "5m": null, "15m": null, "1h": null, "4h": null, "1d": null,
    },
    weightsUsed: { "1m": 0, "5m": 0, "15m": 0.15, "1h": 0.20, "4h": 0.30, "1d": 0.35 },
    asOf,
    emittingTimeframe: "1h",
    risk: null,
    signalId: "000001947a1b2c3d-test-uuid",
    emittedAt: new Date(asOf).toISOString(),
  };
}

function makeIndicatorStateItem(pair: string): Record<string, unknown> {
  return {
    pair,
    exchange: "consensus",
    timeframe: "1h",
    asOfMs: 1700000000000,
    barsSinceStart: 200,
    rsi14: 55,
    ema20: 46000,
    ema50: 45000,
    ema200: 44000,
    macdLine: 100,
    macdSignal: 80,
    macdHist: 20,
    atr14: 500,
    bbUpper: 47500,
    bbMid: 46000,
    bbLower: 44500,
    bbWidth: 0.065,
    obv: 100000,
    obvSlope: 500,
    vwap: 46000,
    volZ: 1.2,
    realizedVolAnnualized: 0.6,
    fearGreed: 55,
    dispersion: 0.001,
    history: {
      rsi14: [52, 53, 54, 55, 55],
      macdHist: [15, 17, 19, 20, 20],
      ema20: [45800, 45900, 46000, 46000, 46000],
      ema50: [44900, 45000, 45000, 45000, 45000],
      close: [45800, 45900, 46000, 46100, 46200],
      volume: [1000, 1100, 1050, 1200, 1150],
    },
  };
}

function makeUserItem(
  userId: string,
  tierId = "111",
  riskProfiles?: Record<string, string>,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    userId,
    email: `${userId}@test.com`,
    displayName: "Test User",
    userType: "retail",
    tierId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (riskProfiles !== undefined) {
    item.riskProfiles = riskProfiles;
  }
  return item;
}

// ---------------------------------------------------------------------------
// App builder — minimal Hono with requireAuth + genie routes
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  jwtVerifyMock.mockReset();

  process.env.APP_ID = "test-app";
  process.env.CORS_ORIGIN = "*";
  process.env.SKIP_API_KEY = "true";

  // Default valid JWT
  jwtVerifyMock.mockResolvedValue({
    payload: {
      sub: TEST_USER_ID,
      email: `${TEST_USER_ID}@test.com`,
      email_verified: true,
    },
  });
});

async function buildApp() {
  const { requireAuth } = await import("../middleware/require-auth.js");
  const { genie } = await import("./genie.js");

  // Minimal test app: requireApiKey skipped (SKIP_API_KEY=true handles it), just genie
  const app = new Hono();
  app.route("/api/genie", genie);
  return app;
}

// ---------------------------------------------------------------------------
// DDB mock configuration helper
// ---------------------------------------------------------------------------

function configureDdbMocks(opts: {
  userItem?: Record<string, unknown> | null;
  signalItem?: Record<string, unknown> | null;
  indicatorStateItem?: Record<string, unknown> | null;
  pairSpecificSignal?: (pair: string) => Record<string, unknown> | null;
}) {
  sendMock.mockImplementation((cmd: Record<string, unknown>) => {
    const tableName = (cmd.TableName as string) ?? "";

    if (tableName.includes("users")) {
      return Promise.resolve({ Item: opts.userItem ?? null });
    }

    if (tableName.includes("signals-v2")) {
      const pair = (cmd.ExpressionAttributeValues as any)?.[":pair"] as string;
      const item = opts.pairSpecificSignal
        ? opts.pairSpecificSignal(pair)
        : (opts.signalItem ?? null);
      return Promise.resolve({ Items: item ? [item] : [] });
    }

    if (tableName.includes("indicator-state")) {
      const pk = (cmd.ExpressionAttributeValues as any)?.[":pk"] as string ?? "";
      const pair = pk.split("#")[0] ?? "BTC/USDT";
      const item = opts.indicatorStateItem ?? makeIndicatorStateItem(pair);
      return Promise.resolve({ Items: [item] });
    }

    // PutCommand (bootstrapUser) — succeed silently
    return Promise.resolve({});
  });
}

// ---------------------------------------------------------------------------
// Tests: GET /api/genie/signals/:pair
// ---------------------------------------------------------------------------

describe("GET /api/genie/signals/:pair — read-time risk attach", () => {
  it("returns risk recommendation for user WITH explicit riskProfiles (tailored)", async () => {
    const app = await buildApp();

    const userItem = makeUserItem(TEST_USER_ID, "222", {
      "BTC/USDT": "aggressive",
      "ETH/USDT": "conservative",
      "SOL/USDT": "moderate",
      "XRP/USDT": "moderate",
      "DOGE/USDT": "conservative",
    });
    const signalItem = makeSignalItem("BTC/USDT", "buy");
    const stateItem = makeIndicatorStateItem("BTC/USDT");

    configureDdbMocks({ userItem, signalItem, indicatorStateItem: stateItem });

    const res = await app.request("/api/genie/signals/BTC-USDT", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.signal).not.toBeNull();
    // User has "aggressive" for BTC/USDT → risk profile should be aggressive
    expect(body.data.signal.risk).not.toBeNull();
    expect(body.data.signal.risk.profile).toBe("aggressive");
  });

  it("returns risk recommendation for user WITHOUT riskProfiles (default at read time)", async () => {
    const app = await buildApp();

    // User record has NO riskProfiles (legacy record — Correction 3 scenario)
    const userItem = makeUserItem(TEST_USER_ID, "111"); // tierId 111 = free

    const signalItem = makeSignalItem("BTC/USDT", "buy");
    const stateItem = makeIndicatorStateItem("BTC/USDT");

    configureDdbMocks({ userItem, signalItem, indicatorStateItem: stateItem });

    const res = await app.request("/api/genie/signals/BTC-USDT", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.signal).not.toBeNull();
    // Tier 111 = "free" → getEffectiveRiskProfiles returns "conservative" for all pairs
    expect(body.data.signal.risk).not.toBeNull();
    expect(body.data.signal.risk.profile).toBe("conservative");
    expect(body.data.signal.risk.positionSizeModel).toBe("fixed");
  });

  it("returns risk: null when indicator state is unavailable (graceful degradation)", async () => {
    const app = await buildApp();

    const userItem = makeUserItem(TEST_USER_ID, "222", {
      "BTC/USDT": "moderate",
      "ETH/USDT": "moderate",
      "SOL/USDT": "moderate",
      "XRP/USDT": "moderate",
      "DOGE/USDT": "moderate",
    });
    const signalItem = makeSignalItem("BTC/USDT", "buy");

    sendMock.mockImplementation((cmd: Record<string, unknown>) => {
      const tableName = (cmd.TableName as string) ?? "";
      if (tableName.includes("users")) return Promise.resolve({ Item: userItem });
      if (tableName.includes("signals-v2")) return Promise.resolve({ Items: [signalItem] });
      // indicator-state returns no items
      if (tableName.includes("indicator-state")) return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    const res = await app.request("/api/genie/signals/BTC-USDT", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.signal).not.toBeNull();
    // No indicator state → risk: null (graceful degradation)
    expect(body.data.signal.risk).toBeNull();
  });

  it("returns risk: null for hold signals regardless of indicator state", async () => {
    const app = await buildApp();

    const userItem = makeUserItem(TEST_USER_ID, "222", {
      "BTC/USDT": "moderate",
      "ETH/USDT": "moderate",
      "SOL/USDT": "moderate",
      "XRP/USDT": "moderate",
      "DOGE/USDT": "moderate",
    });
    const signalItem = makeSignalItem("BTC/USDT", "hold");
    const stateItem = makeIndicatorStateItem("BTC/USDT");

    configureDdbMocks({ userItem, signalItem, indicatorStateItem: stateItem });

    const res = await app.request("/api/genie/signals/BTC-USDT", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.signal.risk).toBeNull();
  });

  it("returns null signal when no signal exists for the pair", async () => {
    const app = await buildApp();

    const userItem = makeUserItem(TEST_USER_ID, "111");
    sendMock.mockImplementation((cmd: Record<string, unknown>) => {
      const tableName = (cmd.TableName as string) ?? "";
      if (tableName.includes("users")) return Promise.resolve({ Item: userItem });
      if (tableName.includes("signals-v2")) return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    const res = await app.request("/api/genie/signals/BTC-USDT", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.signal).toBeNull();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = await buildApp();
    jwtVerifyMock.mockRejectedValue(new Error("invalid token"));

    const res = await app.request("/api/genie/signals/BTC-USDT");

    expect(res.status).toBe(401);
  });

  it("normalizes BTC-USDT to BTC/USDT in DDB query", async () => {
    const app = await buildApp();

    const userItem = makeUserItem(TEST_USER_ID, "111");
    const queriedPairs: string[] = [];

    sendMock.mockImplementation((cmd: Record<string, unknown>) => {
      const tableName = (cmd.TableName as string) ?? "";
      if (tableName.includes("users")) return Promise.resolve({ Item: userItem });
      if (tableName.includes("signals-v2")) {
        const pair = (cmd.ExpressionAttributeValues as any)?.[":pair"] as string;
        queriedPairs.push(pair);
        return Promise.resolve({ Items: [] });
      }
      return Promise.resolve({});
    });

    await app.request("/api/genie/signals/BTC-USDT", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    expect(queriedPairs).toContain("BTC/USDT");
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/genie/signals (all pairs)
// ---------------------------------------------------------------------------

describe("GET /api/genie/signals — all pairs", () => {
  it("returns signals for user WITHOUT riskProfiles using tier default (Correction 3)", async () => {
    const app = await buildApp();

    // No riskProfiles on DDB record
    const userItem = makeUserItem(TEST_USER_ID, "111");

    sendMock.mockImplementation((cmd: Record<string, unknown>) => {
      const tableName = (cmd.TableName as string) ?? "";
      if (tableName.includes("users")) return Promise.resolve({ Item: userItem });
      if (tableName.includes("signals-v2")) {
        const pair = (cmd.ExpressionAttributeValues as any)?.[":pair"] as string;
        return Promise.resolve({ Items: [makeSignalItem(pair, "buy")] });
      }
      if (tableName.includes("indicator-state")) {
        const pk = (cmd.ExpressionAttributeValues as any)?.[":pk"] as string ?? "";
        const pair = pk.split("#")[0] ?? "BTC/USDT";
        return Promise.resolve({ Items: [makeIndicatorStateItem(pair)] });
      }
      return Promise.resolve({});
    });

    const res = await app.request("/api/genie/signals", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.signals)).toBe(true);
    expect(body.data.signals.length).toBeGreaterThan(0);
    // All buy signals should have conservative profile (free tier 111 default)
    for (const signal of body.data.signals) {
      if (signal.type === "buy" && signal.risk !== null) {
        expect(signal.risk.profile).toBe("conservative");
      }
    }
    expect(body.data.disclaimer).toBeTruthy();
  });

  it("bootstraps a new user record when not found in DDB", async () => {
    const app = await buildApp();

    // No user in DDB → bootstrapUser should be called and return a new record
    sendMock.mockImplementation((cmd: Record<string, unknown>) => {
      const tableName = (cmd.TableName as string) ?? "";
      if (tableName.includes("users") && (cmd as any)._type === "Get") {
        return Promise.resolve({ Item: null }); // user not found
      }
      if (tableName.includes("users")) return Promise.resolve({});
      if (tableName.includes("signals-v2")) return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    const res = await app.request("/api/genie/signals", {
      headers: { Authorization: "Bearer test.jwt.token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    // No signals (empty table) but no crash
    expect(Array.isArray(body.data.signals)).toBe(true);
    expect(body.data.signals).toHaveLength(0);
  });
});
