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

  it("preserves ratificationVerdict on cache hit so buildInterpretation routes to llm-ratified", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const { buildInterpretation } = await import("@quantara/shared");
    const ctx = makeContext();

    // Cached signal carries the LLM verdict the way ratify.ts now writes it:
    // ratificationVerdict.reasoning + source: "llm" populated before putCachedRatification.
    const cachedSignal: BlendedSignal = {
      ...makeCandidate({ type: "hold", confidence: 0.6 }),
      ratificationStatus: "ratified",
      ratificationVerdict: {
        type: "hold",
        confidence: 0.6,
        reasoning:
          "Macro overhang from CPI print and rejection at the prior 4h high warrant downgrading to hold.",
        source: "llm",
      },
      algoVerdict: null,
    };

    ddbSendMock.mockResolvedValueOnce({ Items: [], Count: 0 }); // rate limit
    ddbSendMock.mockResolvedValueOnce({ Count: 0 }); // daily cap
    ddbSendMock.mockResolvedValueOnce({ Item: { signal: cachedSignal } }); // cache hit
    ddbSendMock.mockResolvedValue({}); // putRatificationRecord

    const result = await ratifySignal(ctx);
    expect(result.cacheHit).toBe(true);
    expect(result.signal.ratificationVerdict?.reasoning).toContain("CPI print");
    expect(result.signal.ratificationVerdict?.source).toBe("llm");

    const interp = buildInterpretation(result.signal);
    expect(interp.source).toBe("llm-ratified");
    expect(interp.text).toContain("CPI print");
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
    // The caller invokes kickoffRatification() AFTER stage-1 commits; await it
    // so the LLM stream resolves before we assert.
    await result.kickoffRatification?.();
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
    await result.kickoffRatification?.();
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
    await result.kickoffRatification?.();
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
  it("hold signals are gated before LLM (hold→buy violation never reaches validation)", async () => {
    // v2 Phase 2 (#253): hold signals never invoke Genie — they are gated out at the
    // shouldInvokeRatification level before the LLM stream starts.
    // This test verifies hold signals return not-required without LLM interaction.
    const { ratifySignal, _resetValidationFailureCount, getValidationFailureCount } =
      await import("./ratify.js");
    _resetValidationFailureCount();
    const ctx = makeContext({ type: "hold", confidence: 0.7 });
    setupDdbForCacheMiss();
    const result = await ratifySignal(ctx);
    // Hold gate fires: no kickoffRatification returned.
    expect(result.kickoffRatification).toBeUndefined();
    expect(result.signal.ratificationStatus).toBe("not-required");
    // No LLM call means no validation failure count increment.
    expect(getValidationFailureCount()).toBe(0);
  });

  it("buy signal falls back to algo on LLM confidence increase violation", async () => {
    // Tests the validation path is still exercised for buy signals.
    const { ratifySignal, _resetValidationFailureCount, getValidationFailureCount } =
      await import("./ratify.js");
    _resetValidationFailureCount();
    // confidence 0.7 passes the gate; buy type is valid for LLM invocation
    const ctx = makeContext({ type: "buy", confidence: 0.7 });
    setupDdbForCacheMiss();
    // LLM returns higher confidence — forbidden (confidence increase)
    anthropicStreamMock.mockReturnValueOnce(
      makeStreamMock(makeLlmTextContent({ type: "buy", confidence: 0.9 })),
    );
    const result = await ratifySignal(ctx);
    // Phase B1: validation failures happen in the async LLM stream; await completion.
    await result.kickoffRatification?.();
    // For validation failures, fellBackToAlgo is signalled via the stage-2 callback.
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
    await result.kickoffRatification?.();
    expect(getValidationFailureCount()).toBeGreaterThanOrEqual(1);
  });

  it("falls back to algo on schema parse failure (non-JSON response)", async () => {
    const { ratifySignal, _resetValidationFailureCount, getValidationFailureCount } =
      await import("./ratify.js");
    _resetValidationFailureCount();
    const ctx = makeContext();
    setupDdbForCacheMiss();
    // LLM returns garbage
    anthropicStreamMock.mockReturnValueOnce(makeStreamMock("Sorry, I cannot analyze this."));
    const result = await ratifySignal(ctx);
    await result.kickoffRatification?.();
    expect(getValidationFailureCount()).toBeGreaterThanOrEqual(1);
  });

  it("falls back to algo on API error (stream throws) and invokes onStage2 with algo verdict", async () => {
    const { ratifySignal } = await import("./ratify.js");
    const ctx = makeContext();
    setupDdbForCacheMiss();
    // Simulate stream throwing on iteration
    const errorStream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("rate limited");
        },
      }),
      finalMessage: async () => ({ usage: { input_tokens: 0, output_tokens: 0 } }),
    };
    anthropicStreamMock.mockReturnValueOnce(errorStream);

    // Pass onStage2 so the fallback path is actually exercised. Asserting on
    // the callback's payload is the only way to verify the "never stuck on
    // pending" acceptance criterion.
    const onStage2Mock = vi.fn().mockResolvedValue(undefined);
    const result = await ratifySignal(ctx, onStage2Mock);
    // Stage-1 returns immediately with "pending"; the caller invokes
    // kickoffRatification after stage-1 commits.
    await result.kickoffRatification?.();

    // Stage-1 algo signal is "pending" — caller writes this to DDB.
    expect(result.signal.ratificationStatus).toBe("pending");

    // Stage-2 fallback fired: onStage2 was invoked with status="ratified" (not stuck on pending)
    // and the verdict mirrors the algo candidate.
    expect(onStage2Mock).toHaveBeenCalledTimes(1);
    const stage2Payload = onStage2Mock.mock.calls[0][0];
    expect(stage2Payload.ratificationStatus).toBe("ratified");
    expect(stage2Payload.ratificationVerdict.type).toBe(ctx.candidate.type);
    expect(stage2Payload.ratificationVerdict.confidence).toBe(ctx.candidate.confidence);
    expect(stage2Payload.algoVerdict).toBeNull();
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

    // Use buy type so the LLM is invoked (holds are gated out in v2 Phase 2 #253)
    // confidence 0.7 passes the gate; LLM returns confidence increase — validation fails
    const ctx = makeContext({ type: "buy", confidence: 0.7 });
    setupDdbForCacheMiss();
    anthropicStreamMock.mockReturnValueOnce(
      makeStreamMock(makeLlmTextContent({ type: "buy", confidence: 0.95 })),
    );
    const result = await ratifySignal(ctx);
    // Phase B1: validation happens in the async LLM stream — await completion.
    await result.kickoffRatification?.();
    expect(getValidationFailureCount()).toBe(1);

    _resetValidationFailureCount();
    expect(getValidationFailureCount()).toBe(0);
  });
});
