/**
 * admin-debug.service.test.ts
 *
 * Tests for the three admin debug service functions:
 *   - forceRatification
 *   - replayNewsEnrichment
 *   - injectSentimentShock
 *
 * All AWS SDK calls are mocked at the module boundary. No real AWS calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock DynamoDB
// ---------------------------------------------------------------------------

const dynamoSend = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({ send: dynamoSend }),
  },
  QueryCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Query" })),
  GetCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Get" })),
  PutCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Put" })),
}));

// ---------------------------------------------------------------------------
// Mock Bedrock
// ---------------------------------------------------------------------------

const bedrockSend = vi.fn();
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: bedrockSend })),
  InvokeModelCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "InvokeModel" })),
}));

// ---------------------------------------------------------------------------
// Mock crypto (randomUUID)
// ---------------------------------------------------------------------------

vi.mock("crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("test-uuid-1234"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a Bedrock response body for a given text output. */
function bedrockBody(text: string, inputTokens = 10, outputTokens = 20): Buffer {
  return Buffer.from(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  dynamoSend.mockReset();
  bedrockSend.mockReset();
  delete process.env.TABLE_SIGNALS_V2;
  delete process.env.TABLE_RATIFICATIONS;
  delete process.env.TABLE_NEWS_EVENTS;
  delete process.env.TABLE_SENTIMENT_AGGREGATES;
  delete process.env.TABLE_PREFIX;
});

// ---------------------------------------------------------------------------
// forceRatification
// ---------------------------------------------------------------------------

describe("forceRatification", () => {
  it("returns 429-equivalent when the daily cap is exceeded", async () => {
    // Cap check returns count >= 200
    dynamoSend.mockResolvedValueOnce({ Count: 200 });

    const { forceRatification } = await import("./admin-debug.service.js");
    const result = await forceRatification({ pair: "BTC/USDT", timeframe: "1h" });

    expect(result.capped).toBe(true);
    expect(result.capCount).toBe(200);
    expect(result.verdict).toBeNull();
    // DynamoDB should only have been called once (cap check)
    expect(dynamoSend).toHaveBeenCalledTimes(1);
  });

  it("throws when no signal exists in signals_v2", async () => {
    dynamoSend
      .mockResolvedValueOnce({ Count: 0 }) // cap check — not exceeded
      .mockResolvedValueOnce({ Items: [] }); // signals_v2 query — empty

    const { forceRatification } = await import("./admin-debug.service.js");
    await expect(forceRatification({ pair: "BTC/USDT", timeframe: "1h" })).rejects.toThrow(
      "No signal found",
    );
  });

  it("calls Bedrock and writes a ratification record on success", async () => {
    const fakeSignal = { type: "buy", confidence: 0.8, rulesFired: ["rsi_oversold"] };

    dynamoSend
      .mockResolvedValueOnce({ Count: 5 }) // cap check — under cap
      .mockResolvedValueOnce({ Items: [fakeSignal] }) // signals_v2 query
      .mockResolvedValueOnce({}); // PutCommand — ratification record

    bedrockSend.mockResolvedValueOnce({
      body: bedrockBody(
        '{"verdict":"ratify","confidence":0.82,"reasoning":"Signal is well-supported."}',
      ),
    });

    const { forceRatification } = await import("./admin-debug.service.js");
    const result = await forceRatification({ pair: "BTC/USDT", timeframe: "1h" });

    expect(result.verdict).toBe("ratify");
    expect(result.confidence).toBeCloseTo(0.82);
    expect(result.reasoning).toBe("Signal is well-supported.");
    expect(result.cacheHit).toBe(false);
    expect(result.fellBackToAlgo).toBe(false);
    expect(result.recordId).toBe("test-uuid-1234");
    expect(typeof result.latencyMs).toBe("number");
    expect(typeof result.costUsd).toBe("number");
    expect(result.costUsd).toBeGreaterThan(0);
    // DynamoDB: cap check + signals query + put record
    expect(dynamoSend).toHaveBeenCalledTimes(3);
    // Bedrock: one InvokeModel call
    expect(bedrockSend).toHaveBeenCalledTimes(1);
  });

  it("falls back to algo signal when Bedrock throws", async () => {
    const fakeSignal = { type: "hold", confidence: 0.5, rulesFired: [] };

    dynamoSend
      .mockResolvedValueOnce({ Count: 0 }) // cap check
      .mockResolvedValueOnce({ Items: [fakeSignal] }) // signals_v2 query
      .mockResolvedValueOnce({}); // put record

    bedrockSend.mockRejectedValueOnce(new Error("Bedrock timeout"));

    const { forceRatification } = await import("./admin-debug.service.js");
    const result = await forceRatification({ pair: "ETH/USDT", timeframe: "4h" });

    expect(result.fellBackToAlgo).toBe(true);
    expect(result.verdict).toBe("hold");
    expect(result.confidence).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// replayNewsEnrichment
// ---------------------------------------------------------------------------

describe("replayNewsEnrichment", () => {
  it("throws when the news record is not found", async () => {
    dynamoSend.mockResolvedValueOnce({ Items: [] });

    const { replayNewsEnrichment } = await import("./admin-debug.service.js");
    await expect(replayNewsEnrichment({ newsId: "nonexistent-id" })).rejects.toThrow(
      "News record not found",
    );
  });

  it("returns enrichment without mutating the stored row", async () => {
    const storedItem = {
      newsId: "news-123",
      title: "Bitcoin ETF approved by SEC",
      body: "The SEC has approved a spot Bitcoin ETF for the first time.",
      publishedAt: "2026-05-09T10:00:00Z",
      enrichment: { sentiment: "bullish", confidence: 0.9 },
    };

    dynamoSend.mockResolvedValueOnce({ Items: [storedItem] });

    // LLM pair-tagging response
    bedrockSend
      .mockResolvedValueOnce({
        body: bedrockBody('{"affectedPairs":["BTC","ETH"]}'),
      })
      // Sentiment response
      .mockResolvedValueOnce({
        body: bedrockBody('{"score":0.9,"magnitude":0.85,"topic":"ETF approval"}'),
      });

    const { replayNewsEnrichment } = await import("./admin-debug.service.js");
    const result = await replayNewsEnrichment({ newsId: "news-123" });

    expect(result.newsId).toBe("news-123");
    expect(result.title).toBe("Bitcoin ETF approved by SEC");
    // mutated must always be false
    expect(result.mutated).toBe(false);
    // storedEnrichment is not modified
    expect(result.storedEnrichment).toEqual({ sentiment: "bullish", confidence: 0.9 });
    // replayed enrichment has the new values
    expect(result.replayedEnrichment.mentionedPairs).toContain("BTC");
    expect(result.replayedEnrichment.sentiment.score).toBeCloseTo(0.9);
    expect(result.replayedEnrichment.sentiment.magnitude).toBeCloseTo(0.85);
    expect(result.replayedEnrichment.sentiment.model).toBe("anthropic.claude-haiku-4-5");
    // DynamoDB should NOT have been called with PutCommand (read-only path)
    const putCalls = dynamoSend.mock.calls.filter(
      (call: unknown[]) => (call[0] as { _type?: string })?._type === "Put",
    );
    expect(putCalls).toHaveLength(0);
  });

  it("still returns partial results when LLM pair-tagging fails", async () => {
    const storedItem = {
      newsId: "news-456",
      title: "Solana upgrade released",
      body: "The Solana network upgraded to v2.0 with 50k TPS.",
      publishedAt: "2026-05-09T09:00:00Z",
    };

    dynamoSend.mockResolvedValueOnce({ Items: [storedItem] });

    // LLM pair-tagging throws
    bedrockSend
      .mockRejectedValueOnce(new Error("LLM timeout"))
      // Sentiment succeeds
      .mockResolvedValueOnce({
        body: bedrockBody('{"score":0.6,"magnitude":0.7,"topic":"protocol upgrade"}'),
      });

    const { replayNewsEnrichment } = await import("./admin-debug.service.js");
    const result = await replayNewsEnrichment({ newsId: "news-456" });

    // Regex still catches SOL from the title
    expect(result.replayedEnrichment.mentionedPairs).toContain("SOL");
    expect(result.replayedEnrichment.sentiment.score).toBeCloseTo(0.6);
    expect(result.mutated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// injectSentimentShock
// ---------------------------------------------------------------------------

describe("injectSentimentShock", () => {
  it("returns skipped when the delta is below the threshold", async () => {
    // DynamoDB: sentiment aggregate read
    dynamoSend.mockResolvedValueOnce({ Item: { meanScore: 0.1, meanMagnitude: 0.6 } });

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    // deltaScore=0.1 → next=0.2, actualDelta=0.1 < 0.3 threshold
    const result = await injectSentimentShock({
      pair: "BTC/USDT",
      deltaScore: 0.1,
      deltaMagnitude: 0,
    });

    expect(result.decision).toBe("skipped");
    expect(result.reasons.some((r) => r.includes("threshold"))).toBe(true);
    expect(result.shockRecord).toBeNull();
  });

  it("returns skipped when magnitude is below floor", async () => {
    dynamoSend.mockResolvedValueOnce({ Item: { meanScore: 0.0, meanMagnitude: 0.1 } });

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    // deltaScore=0.5 → delta=0.5 >= 0.3 ✓, nextMagnitude=0.1+0.0=0.1 < 0.5 floor
    const result = await injectSentimentShock({
      pair: "ETH/USDT",
      deltaScore: 0.5,
      deltaMagnitude: 0,
    });

    expect(result.decision).toBe("skipped");
    expect(result.reasons.some((r) => r.includes("floor"))).toBe(true);
  });

  it("returns gated when the hourly cap is exceeded", async () => {
    // No base aggregate → defaults (meanScore=0, meanMagnitude=0.5)
    dynamoSend
      .mockResolvedValueOnce({ Item: null }) // base aggregate — not found
      .mockResolvedValueOnce({ Count: 6 }); // hourly cap check — at limit

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    const result = await injectSentimentShock({
      pair: "BTC/USDT",
      deltaScore: 0.5,
      deltaMagnitude: 0.1,
    });

    expect(result.decision).toBe("gated");
    expect(result.reasons.some((r) => r.includes("hourly cap"))).toBe(true);
    expect(result.shockRecord).toBeNull();
  });

  it("writes a shock record and returns fired when conditions are met", async () => {
    dynamoSend
      .mockResolvedValueOnce({ Item: { meanScore: 0.0, meanMagnitude: 0.6 } }) // base aggregate
      .mockResolvedValueOnce({ Count: 2 }) // hourly cap check — under cap
      .mockResolvedValueOnce({}); // PutCommand — shock record

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    const result = await injectSentimentShock({
      pair: "SOL/USDT",
      deltaScore: 0.5,
      deltaMagnitude: 0.1,
    });

    expect(result.decision).toBe("fired");
    expect(result.shockRecord).not.toBeNull();
    expect(result.shockRecord?.["triggerReason"]).toBe("sentiment_shock");
    expect(result.shockRecord?.["pair"]).toBe("SOL/USDT");
    expect(result.reasons.some((r) => r.includes("shock conditions met"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("recordId"))).toBe(true);
    // Bedrock must NOT be called — no LLM for shock injection
    expect(bedrockSend).not.toHaveBeenCalled();
    // DynamoDB: aggregate read + cap check + put record
    expect(dynamoSend).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid deltaScore outside [-2, 2]", async () => {
    const { injectSentimentShock } = await import("./admin-debug.service.js");
    await expect(
      injectSentimentShock({ pair: "BTC/USDT", deltaScore: 3, deltaMagnitude: 0 }),
    ).rejects.toThrow("deltaScore must be");
  });

  it("rejects invalid deltaMagnitude outside [-1, 1]", async () => {
    const { injectSentimentShock } = await import("./admin-debug.service.js");
    await expect(
      injectSentimentShock({ pair: "BTC/USDT", deltaScore: 0.5, deltaMagnitude: 1.5 }),
    ).rejects.toThrow("deltaMagnitude must be");
  });
});
