/**
 * Tests for cache.ts — DDB-backed ratification cache (Phase 6a).
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
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  process.env.TABLE_RATIFICATION_CACHE = "test-ratification-cache";
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSignal(): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "hold",
    confidence: 0.55,
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
  };
}

function makeContext(): RatifyContext {
  const candidate = makeSignal();
  return {
    pair: "BTC/USDT",
    candidate: { ...candidate, type: "buy", confidence: 0.75 },
    perTimeframe: candidate.perTimeframe,
    sentiment: {
      pair: "BTC/USDT",
      assembledAt: new Date().toISOString(),
      windows: {
        "4h": {
          pair: "BTC/USDT",
          window: "4h",
          computedAt: new Date().toISOString(),
          articleCount: 5,
          meanScore: 0.6,
          meanMagnitude: 0.4,
          fearGreedTrend24h: 5,
          fearGreedLatest: 65,
        },
        "24h": {
          pair: "BTC/USDT",
          window: "24h",
          computedAt: new Date().toISOString(),
          articleCount: 10,
          meanScore: 0.55,
          meanMagnitude: 0.38,
          fearGreedTrend24h: 5,
          fearGreedLatest: 65,
        },
      },
      fearGreed: {
        value: 65,
        classification: "Greed",
        lastTimestamp: new Date().toISOString(),
        history: [],
        trend24h: 5,
      },
    },
    whaleSummary: null,
    pricePoints: [],
    fearGreed: { value: 65, trend24h: 5 },
  };
}

// ---------------------------------------------------------------------------
// deriveCacheKey
// ---------------------------------------------------------------------------

describe("deriveCacheKey", () => {
  it("returns a 64-char hex string", async () => {
    const { deriveCacheKey } = await import("./cache.js");
    const key = deriveCacheKey(makeContext());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same context values", async () => {
    const { deriveCacheKey } = await import("./cache.js");
    const ctx = makeContext();
    expect(deriveCacheKey(ctx)).toBe(deriveCacheKey(ctx));
  });

  it("differs when pair changes", async () => {
    const { deriveCacheKey } = await import("./cache.js");
    const ctx1 = makeContext();
    const ctx2 = { ...makeContext(), pair: "ETH/USDT" };
    ctx2.candidate = { ...ctx2.candidate, pair: "ETH/USDT" };
    expect(deriveCacheKey(ctx1)).not.toBe(deriveCacheKey(ctx2));
  });

  it("bins confidence to 0.02 steps", async () => {
    const { deriveCacheKey } = await import("./cache.js");
    const ctx1 = makeContext();
    ctx1.candidate = { ...ctx1.candidate, confidence: 0.74 };
    const ctx2 = makeContext();
    ctx2.candidate = { ...ctx2.candidate, confidence: 0.75 };
    // 0.74 and 0.75 both bin to 0.74 (floor(0.74/0.02)*0.02 = 0.74, floor(0.75/0.02)*0.02 = 0.74)
    expect(deriveCacheKey(ctx1)).toBe(deriveCacheKey(ctx2));
  });

  it("differs for different F&G values beyond bin size", async () => {
    const { deriveCacheKey } = await import("./cache.js");
    const ctx1 = makeContext(); // fearGreed.value = 65
    const ctx2 = { ...makeContext(), fearGreed: { value: 70, trend24h: 5 } };
    expect(deriveCacheKey(ctx1)).not.toBe(deriveCacheKey(ctx2));
  });
});

// ---------------------------------------------------------------------------
// getCachedRatification
// ---------------------------------------------------------------------------

describe("getCachedRatification", () => {
  it("returns null on cache miss", async () => {
    const { getCachedRatification } = await import("./cache.js");
    sendMock.mockResolvedValueOnce({ Item: null });
    const result = await getCachedRatification("deadbeef");
    expect(result).toBeNull();
  });

  it("returns the cached signal on hit", async () => {
    const { getCachedRatification } = await import("./cache.js");
    const signal = makeSignal();
    sendMock.mockResolvedValueOnce({ Item: { signal } });
    const result = await getCachedRatification("deadbeef");
    expect(result).toEqual(signal);
  });

  it("returns null when Item exists but has no signal field", async () => {
    const { getCachedRatification } = await import("./cache.js");
    sendMock.mockResolvedValueOnce({ Item: { cacheKey: "deadbeef" } });
    const result = await getCachedRatification("deadbeef");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// putCachedRatification
// ---------------------------------------------------------------------------

describe("putCachedRatification", () => {
  it("writes to DDB with correct table and ttl field", async () => {
    const { putCachedRatification } = await import("./cache.js");
    sendMock.mockResolvedValueOnce({});
    const signal = makeSignal();
    await putCachedRatification("mykey", signal, 300);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0] as {
      input: { TableName: string; Item: { ttl: number; cacheKey: string } };
    };
    expect(call.input.TableName).toBe("test-ratification-cache");
    expect(call.input.Item.cacheKey).toBe("mykey");
    expect(typeof call.input.Item.ttl).toBe("number");
  });

  it("uses default TTL of 300 seconds when not specified", async () => {
    const { putCachedRatification, CACHE_TTL_SEC } = await import("./cache.js");
    sendMock.mockResolvedValueOnce({});
    const nowSec = Math.floor(Date.now() / 1000);
    await putCachedRatification("key2", makeSignal());
    const call = sendMock.mock.calls[0][0] as { input: { Item: { ttl: number } } };
    expect(call.input.Item.ttl).toBeGreaterThanOrEqual(nowSec + CACHE_TTL_SEC - 5);
    expect(call.input.Item.ttl).toBeLessThanOrEqual(nowSec + CACHE_TTL_SEC + 5);
  });
});
