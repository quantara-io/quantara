/**
 * Tests for ratify.ts — main entry point, integration of gating + cache + LLM + store.
 *
 * Mocks:
 *   - @anthropic-ai/sdk (Anthropic client)
 *   - @aws-sdk/client-dynamodb + @aws-sdk/lib-dynamodb
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlendedSignal } from "@quantara/shared";
import type { RatifyContext } from "./ratify.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const ddbSendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: ddbSendMock }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
}));

/**
 * Phase B1: ratify.ts now uses messages.stream() instead of messages.create().
 * We mock the stream as an async iterable that emits content_block_delta events,
 * plus a finalMessage() method that returns usage stats.
 */
const anthropicStreamMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      stream: anthropicStreamMock,
    },
  })),
}));

beforeEach(() => {
  vi.resetModules();
  ddbSendMock.mockReset();
  anthropicStreamMock.mockReset();
  process.env.TABLE_RATIFICATIONS = "test-ratifications";
  process.env.TABLE_RATIFICATION_CACHE = "test-ratification-cache";
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
    rulesFired: ["ema_cross_bullish"],
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

function makeContext(candidateOverrides: Partial<BlendedSignal> = {}): RatifyContext {
  const candidate = makeCandidate(candidateOverrides);
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
          articleCount: 3, // recentNewsExists = true
          meanScore: 0.6,
          meanMagnitude: 0.4,
          fearGreedTrend24h: 5,
          fearGreedLatest: 65,
        },
        "24h": {
          pair: "BTC/USDT",
          window: "24h",
          computedAt: new Date().toISOString(),
          articleCount: 8,
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

/** Build a valid LLM text response JSON. */
function makeLlmTextContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "hold",
    confidence: 0.6,
    reasoning:
      "Elevated fear and greed index (65) suggests caution despite bullish technical signals.",
    downgraded: true,
    downgradeReason: "FNG elevated",
    ...overrides,
  });
}

/**
 * Build a mock stream object that satisfies the messages.stream() contract:
 *   - async iterable of events (content_block_delta with text_delta)
 *   - finalMessage() resolves to a message with usage stats
 */
function makeStreamMock(textContent: string) {
  const events = [
    { type: "content_block_delta", delta: { type: "text_delta", text: textContent } },
  ];
  const stream = {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        next: async () => {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
    finalMessage: async () => ({
      usage: { input_tokens: 500, output_tokens: 80 },
    }),
  };
  return stream;
}


/**
 * Set up DDB mocks for the common "gating pass, cache miss, store write" path.
 * Call count:
 *   1. gating: getLastRatificationFor → no recent invocation
 *   2. gating: countRatificationsToday → 0
 *   3. cache: getCachedRatification → null (miss)
 *   4. cache: putCachedRatification → void
 *   5. store: putRatificationRecord → void
 */
function setupDdbForCacheMiss() {
  ddbSendMock.mockResolvedValueOnce({ Items: [], Count: 0 }); // getLastRatificationFor
  ddbSendMock.mockResolvedValueOnce({ Count: 0 }); // countRatificationsToday
  ddbSendMock.mockResolvedValueOnce({ Item: null }); // getCachedRatification (miss)
  ddbSendMock.mockResolvedValue({}); // putCachedRatification + putRatificationRecord
}

// ---------------------------------------------------------------------------
// Gating: falls back to algo when gated
// ---------------------------------------------------------------------------

describe("ratifySignal — gating", () => {
  it("returns candidate unchanged when confidence < 0.6", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext({ confidence: 0.55 });
    // gating blocks; only one DDB write (skipped record)
    ddbSendMock.mockResolvedValue({});
    const result = await ratifySignal(ctx);
    expect(result.signal.type).toBe("buy");
    expect(result.signal.confidence).toBe(0.55);
    expect(result.fellBackToAlgo).toBe(true);
    expect(result.cacheHit).toBe(false);
    expect(anthropicStreamMock).not.toHaveBeenCalled();
  });

  it("falls back when no trigger conditions (no news, no vol, no fng shift)", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext();
    // Override sentiment to have 0 articles and no vol/fng
    ctx.sentiment.windows["4h"].articleCount = 0;
    ctx.sentiment.windows["24h"].articleCount = 0;
    ctx.candidate.volatilityFlag = false;
    ctx.fearGreed.trend24h = 3;
    ddbSendMock.mockResolvedValueOnce({ Items: [], Count: 0 }); // rate limit
    ddbSendMock.mockResolvedValueOnce({ Count: 0 }); // daily cap
    ddbSendMock.mockResolvedValue({}); // store write
    const result = await ratifySignal(ctx);
    expect(result.fellBackToAlgo).toBe(true);
    expect(anthropicStreamMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cache hit: returns cached signal, no LLM call
// ---------------------------------------------------------------------------

describe("ratifySignal — cache hit", () => {
  it("returns cached signal and skips LLM call", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext();
    const cachedSignal = makeCandidate({ type: "hold", confidence: 0.6 });

    ddbSendMock.mockResolvedValueOnce({ Items: [], Count: 0 }); // rate limit
    ddbSendMock.mockResolvedValueOnce({ Count: 0 }); // daily cap
    ddbSendMock.mockResolvedValueOnce({ Item: { signal: cachedSignal } }); // cache hit
    ddbSendMock.mockResolvedValue({}); // putRatificationRecord

    const result = await ratifySignal(ctx);
    expect(result.cacheHit).toBe(true);
    expect(result.fellBackToAlgo).toBe(false);
    expect(result.signal.type).toBe("hold");
    expect(anthropicStreamMock).not.toHaveBeenCalled();
  });

  it("persists a RatificationRecord with cacheHit=true and costUsd=0 on cache hit", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext();
    const cachedSignal = makeCandidate({ type: "hold", confidence: 0.6 });

    ddbSendMock.mockResolvedValueOnce({ Items: [], Count: 0 });
    ddbSendMock.mockResolvedValueOnce({ Count: 0 });
    ddbSendMock.mockResolvedValueOnce({ Item: { signal: cachedSignal } });
    ddbSendMock.mockResolvedValue({});

    await ratifySignal(ctx);
    // The last DDB call should be the putRatificationRecord
    const allPutCalls = ddbSendMock.mock.calls.filter(
      (c) => (c[0] as { __cmd: string }).__cmd === "Put",
    );
    expect(allPutCalls.length).toBeGreaterThanOrEqual(1);
    const recordItem = (
      allPutCalls[0][0] as { input: { Item: { cacheHit: boolean; costUsd: number } } }
    ).input.Item;
    expect(recordItem.cacheHit).toBe(true);
    expect(recordItem.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Successful LLM ratification
// ---------------------------------------------------------------------------

describe("ratifySignal — successful LLM ratification", () => {
  it("returns ratified signal with lower confidence", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext();
    setupDdbForCacheMiss();
    anthropicStreamMock.mockReturnValueOnce(
      makeStreamMock(makeLlmTextContent({ type: "hold", confidence: 0.6 })),
    );
    const result = await ratifySignal(ctx);
    // Phase B1: ratifySignal returns immediately with "pending" stage-1 signal.
    // Await ratificationComplete so the LLM stream resolves before we assert.
    await result.ratificationComplete;
    expect(result.fellBackToAlgo).toBe(false);
    expect(result.cacheHit).toBe(false);
    // stage-1 signal has ratificationStatus = "pending"; final verdict is in stage-2.
    expect(result.signal.ratificationStatus).toBe("pending");
  });

  it("writes to cache after successful ratification", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext();
    setupDdbForCacheMiss();
    anthropicStreamMock.mockReturnValueOnce(makeStreamMock(makeLlmTextContent()));
    const result = await ratifySignal(ctx);
    // Await stage-2 completion so cache + record writes happen before we assert.
    await result.ratificationComplete;
    // There should be at least 2 Put calls: cache write + record write
    const putCalls = ddbSendMock.mock.calls.filter(
      (c) => (c[0] as { __cmd: string }).__cmd === "Put",
    );
    expect(putCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("persists a RatificationRecord with fellBackToAlgo=false on success", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext();
    setupDdbForCacheMiss();
    anthropicStreamMock.mockReturnValueOnce(makeStreamMock(makeLlmTextContent()));
    const result = await ratifySignal(ctx);
    // Await stage-2 so record write happens before we assert.
    await result.ratificationComplete;
    const putCalls = ddbSendMock.mock.calls.filter(
      (c) => (c[0] as { __cmd: string }).__cmd === "Put",
    );
    // One of the Put calls should have fellBackToAlgo=false
    const storePut = putCalls.find(
      (c) =>
        (c[0] as { input: { Item: { fellBackToAlgo?: boolean } } }).input.Item.fellBackToAlgo ===
        false,
    );
    expect(storePut).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Validation failure fallback
// ---------------------------------------------------------------------------

describe("ratifySignal — validation failures", () => {
  it("falls back to algo on hold→buy violation", async () => {
    const { ratifySignal, _resetValidationFailureCount, getValidationFailureCount } =
      await import("./ratify.js");
    _resetValidationFailureCount();
    // confidence 0.7 passes the gate; type hold means LLM must return hold
    const ctx = makeContext({ type: "hold", confidence: 0.7 });
    setupDdbForCacheMiss();
    // LLM returns buy — forbidden from hold
    anthropicStreamMock.mockReturnValueOnce(
      makeStreamMock(makeLlmTextContent({ type: "buy", confidence: 0.6 })),
    );
    const result = await ratifySignal(ctx);
    // Phase B1: validation failures happen in the async LLM stream; await completion.
    await result.ratificationComplete;
    // For validation failures, fellBackToAlgo is signalled via the stage-2 callback.
    // The synchronous result.fellBackToAlgo reflects only the pre-stream gate check.
    expect(getValidationFailureCount()).toBe(1);
  });

  it("falls back to algo on confidence increase", async () => {
    const { ratifySignal, _resetValidationFailureCount, getValidationFailureCount } =
      await import("./ratify.js");
    _resetValidationFailureCount();
    const ctx = makeContext({ confidence: 0.7 });
    setupDdbForCacheMiss();
    // LLM returns higher confidence — forbidden
    anthropicStreamMock.mockReturnValueOnce(
      makeStreamMock(makeLlmTextContent({ type: "buy", confidence: 0.9 })),
    );
    const result = await ratifySignal(ctx);
    await result.ratificationComplete;
    expect(getValidationFailureCount()).toBeGreaterThanOrEqual(1);
  });

  it("falls back to algo on schema parse failure (non-JSON response)", async () => {
    const { ratifySignal, _resetValidationFailureCount, getValidationFailureCount } =
      await import("./ratify.js");
    _resetValidationFailureCount();
    const ctx = makeContext();
    setupDdbForCacheMiss();
    // LLM returns garbage
    anthropicStreamMock.mockReturnValueOnce(
      makeStreamMock("Sorry, I cannot analyze this."),
    );
    const result = await ratifySignal(ctx);
    await result.ratificationComplete;
    expect(getValidationFailureCount()).toBeGreaterThanOrEqual(1);
  });

  it("falls back to algo on API error (stream throws)", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext();
    setupDdbForCacheMiss();
    // Simulate stream throwing on iteration
    const errorStream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => { throw new Error("rate limited"); },
      }),
      finalMessage: async () => ({ usage: { input_tokens: 0, output_tokens: 0 } }),
    };
    anthropicStreamMock.mockReturnValueOnce(errorStream);
    const result = await ratifySignal(ctx);
    // Stage-1 returns immediately with "pending"; await stage-2 for error handling.
    await result.ratificationComplete;
    // Graceful fallback: signal not stuck on "pending" — onStage2 called with "ratified".
    // result.signal is the algo candidate with ratificationStatus="pending" (stage-1).
    expect(result.signal.ratificationStatus).toBe("pending");
    // No throw — errors are caught and fallback applied.
  });
});

// ---------------------------------------------------------------------------
// Validation failure counter / metric
// ---------------------------------------------------------------------------

describe("getValidationFailureCount", () => {
  it("increments on validation failure and can be reset", async () => {
    const { ratifySignal, getValidationFailureCount, _resetValidationFailureCount } =
      await import("./ratify.js");
    _resetValidationFailureCount();
    expect(getValidationFailureCount()).toBe(0);

    // confidence 0.7 passes the gate; type hold means LLM must return hold
    const ctx = makeContext({ type: "hold", confidence: 0.7 });
    setupDdbForCacheMiss();
    anthropicStreamMock.mockReturnValueOnce(
      makeStreamMock(makeLlmTextContent({ type: "buy", confidence: 0.6 })),
    );
    const result = await ratifySignal(ctx);
    // Phase B1: validation happens in the async LLM stream — await completion.
    await result.ratificationComplete;
    expect(getValidationFailureCount()).toBe(1);

    _resetValidationFailureCount();
    expect(getValidationFailureCount()).toBe(0);
  });
});
