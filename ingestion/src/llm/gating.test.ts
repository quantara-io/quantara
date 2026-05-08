/**
 * Tests for gating.ts — cost gating logic (Phase 6a).
 *
 * Mocks DynamoDB to test all gating rules without network access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlendedSignal } from "@quantara/shared";
import type { RatifyContext } from "./ratify.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: sendMock }) },
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  process.env.TABLE_RATIFICATIONS = "test-ratifications";
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<BlendedSignal> = {}): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "buy",
    confidence: 0.75,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: [],
    perTimeframe: {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
    },
    weightsUsed: {
      "1m": 0,
      "5m": 0,
      "15m": 0.15,
      "1h": 0.2,
      "4h": 0.3,
      "1d": 0.35,
    },
    asOf: 1700000000000,
    emittingTimeframe: "4h",
    risk: null,
    ...overrides,
  };
}

function makeContext(
  overrides: {
    candidate?: Partial<BlendedSignal>;
    articleCount4h?: number;
    articleCount24h?: number;
    volatilityFlag?: boolean;
    fngTrend24h?: number;
  } = {},
): RatifyContext {
  const candidate = makeCandidate(overrides.candidate ?? {});
  if (overrides.volatilityFlag !== undefined) {
    candidate.volatilityFlag = overrides.volatilityFlag;
  }
  return {
    pair: "BTC/USDT",
    candidate,
    perTimeframe: candidate.perTimeframe,
    sentiment: {
      pair: "BTC/USDT",
      assembledAt: new Date().toISOString(),
      windows: {
        "4h": {
          pair: "BTC/USDT",
          window: "4h",
          computedAt: new Date().toISOString(),
          articleCount: overrides.articleCount4h ?? 3,
          meanScore: 0.5,
          meanMagnitude: 0.4,
          fearGreedTrend24h: overrides.fngTrend24h ?? 5,
          fearGreedLatest: 60,
        },
        "24h": {
          pair: "BTC/USDT",
          window: "24h",
          computedAt: new Date().toISOString(),
          articleCount: overrides.articleCount24h ?? 5,
          meanScore: 0.5,
          meanMagnitude: 0.4,
          fearGreedTrend24h: overrides.fngTrend24h ?? 5,
          fearGreedLatest: 60,
        },
      },
      fearGreed: {
        value: 60,
        classification: "Greed",
        lastTimestamp: new Date().toISOString(),
        history: [],
        trend24h: overrides.fngTrend24h ?? 5,
      },
    },
    whaleSummary: null,
    pricePoints: [],
    fearGreed: { value: 60, trend24h: overrides.fngTrend24h ?? 5 },
  };
}

// ---------------------------------------------------------------------------
// Trigger helpers
// ---------------------------------------------------------------------------

describe("trigger helpers", () => {
  it("recentNewsExists: true when 4h articleCount > 0", async () => {
    const { recentNewsExists } = await import("./gating.js");
    expect(recentNewsExists(makeContext({ articleCount4h: 1 }))).toBe(true);
  });

  it("recentNewsExists: false when both windows have 0 articles", async () => {
    const { recentNewsExists } = await import("./gating.js");
    expect(recentNewsExists(makeContext({ articleCount4h: 0, articleCount24h: 0 }))).toBe(false);
  });

  it("volatilityFlagSet: true when candidate.volatilityFlag = true", async () => {
    const { volatilityFlagSet } = await import("./gating.js");
    expect(volatilityFlagSet(makeContext({ volatilityFlag: true }))).toBe(true);
  });

  it("volatilityFlagSet: false when candidate.volatilityFlag = false", async () => {
    const { volatilityFlagSet } = await import("./gating.js");
    expect(volatilityFlagSet(makeContext({ volatilityFlag: false }))).toBe(false);
  });

  it("fngShifted: true when |trend24h| >= 15", async () => {
    const { fngShifted } = await import("./gating.js");
    expect(fngShifted(makeContext({ fngTrend24h: 15 }))).toBe(true);
    expect(fngShifted(makeContext({ fngTrend24h: -20 }))).toBe(true);
  });

  it("fngShifted: false when |trend24h| < 15", async () => {
    const { fngShifted } = await import("./gating.js");
    expect(fngShifted(makeContext({ fngTrend24h: 5 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldInvokeRatification
// ---------------------------------------------------------------------------

describe("shouldInvokeRatification", () => {
  it("blocks when confidence < 0.6", async () => {
    const { shouldInvokeRatification } = await import("./gating.js");
    const ctx = makeContext({ candidate: { confidence: 0.55 } });
    // DDB won't be called — confidence gate fires first
    const result = await shouldInvokeRatification(ctx);
    expect(result.shouldInvoke).toBe(false);
    expect(result.reason).toMatch(/confidence/);
  });

  it("allows when confidence exactly 0.6 and has news + no rate limit", async () => {
    const { shouldInvokeRatification } = await import("./gating.js");
    const ctx = makeContext({ candidate: { confidence: 0.6 } });
    // No previous invocation, under daily cap
    sendMock.mockResolvedValueOnce({ Items: [], Count: 0 }); // getLastRatificationFor
    sendMock.mockResolvedValueOnce({ Count: 0 }); // countRatificationsToday
    const result = await shouldInvokeRatification(ctx);
    expect(result.shouldInvoke).toBe(true);
  });

  it("blocks when per-(pair, TF) rate limit active", async () => {
    const { shouldInvokeRatification } = await import("./gating.js");
    const ctx = makeContext();
    // Last invocation 60 seconds ago — within 5-minute window
    const recent = new Date(Date.now() - 60_000).toISOString();
    sendMock.mockResolvedValueOnce({ Items: [{ invokedAt: recent }], Count: 1 });
    const result = await shouldInvokeRatification(ctx);
    expect(result.shouldInvoke).toBe(false);
    expect(result.reason).toMatch(/rate limit/);
  });

  it("allows when last invocation was > 5 minutes ago", async () => {
    const { shouldInvokeRatification } = await import("./gating.js");
    const ctx = makeContext();
    const old = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    sendMock.mockResolvedValueOnce({ Items: [{ invokedAt: old }], Count: 1 });
    sendMock.mockResolvedValueOnce({ Count: 5 }); // daily count under 100
    const result = await shouldInvokeRatification(ctx);
    expect(result.shouldInvoke).toBe(true);
  });

  it("blocks when daily cap exceeded and not all conditions fire", async () => {
    const { shouldInvokeRatification } = await import("./gating.js");
    // Only news, no vol, no fng shift
    const ctx = makeContext({ volatilityFlag: false, fngTrend24h: 5, articleCount4h: 5 });
    sendMock.mockResolvedValueOnce({ Items: [], Count: 0 }); // no recent rate limit
    sendMock.mockResolvedValueOnce({ Count: 100 }); // at daily cap
    const result = await shouldInvokeRatification(ctx);
    expect(result.shouldInvoke).toBe(false);
    expect(result.reason).toMatch(/daily cap/);
  });

  it("allows when daily cap exceeded but ALL three conditions fire", async () => {
    const { shouldInvokeRatification } = await import("./gating.js");
    // All three: news + vol + fng shift
    const ctx = makeContext({ volatilityFlag: true, fngTrend24h: 20, articleCount4h: 5 });
    sendMock.mockResolvedValueOnce({ Items: [], Count: 0 }); // no rate limit
    sendMock.mockResolvedValueOnce({ Count: 100 }); // at daily cap
    const result = await shouldInvokeRatification(ctx);
    expect(result.shouldInvoke).toBe(true);
  });

  it("blocks when no trigger conditions fire (no news, no vol, no fng shift)", async () => {
    const { shouldInvokeRatification } = await import("./gating.js");
    const ctx = makeContext({
      articleCount4h: 0,
      articleCount24h: 0,
      volatilityFlag: false,
      fngTrend24h: 3,
    });
    sendMock.mockResolvedValueOnce({ Items: [], Count: 0 }); // no rate limit
    sendMock.mockResolvedValueOnce({ Count: 0 }); // daily count fine
    const result = await shouldInvokeRatification(ctx);
    expect(result.shouldInvoke).toBe(false);
    expect(result.reason).toMatch(/no trigger/);
  });
});
