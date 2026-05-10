/**
 * admin-debug.service.test.ts
 *
 * Tests for the admin debug service functions:
 *   - forceRatification
 *   - previewNewsEnrichment (formerly replayNewsEnrichment)
 *   - reenrichNews
 *   - injectSentimentShock
 *
 * All AWS SDK calls are mocked at the module boundary. No real AWS calls.
 *
 * Each public call now starts with an idempotency-reservation Put against the
 * ingestion-metadata table — those calls are mocked first in each test.
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
  UpdateCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Update" })),
}));

// ---------------------------------------------------------------------------
// Mock SQS
// ---------------------------------------------------------------------------

const sqsSend = vi.fn();
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sqsSend })),
  SendMessageCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "SendMessage" })),
}));

// ---------------------------------------------------------------------------
// Mock Lambda
// ---------------------------------------------------------------------------

const lambdaSend = vi.fn();
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSend })),
  InvokeCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "Invoke" })),
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
// Mock crypto (randomUUID stable for assertions; createHash needs to be real
// because the idempotency key uses sha256 — fall through to the real impl).
// ---------------------------------------------------------------------------

vi.mock("crypto", async () => {
  const actual = await vi.importActual<typeof import("crypto")>("crypto");
  return { ...actual, randomUUID: vi.fn().mockReturnValue("test-uuid-1234") };
});

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

/**
 * Successful idempotency reservation (Conditional Put returns no error).
 * Every public call starts with this in production, so every test queues
 * it first unless explicitly testing the duplicate path.
 */
function mockIdempotencyOk(): void {
  dynamoSend.mockResolvedValueOnce({});
}

beforeEach(() => {
  vi.resetModules();
  dynamoSend.mockReset();
  bedrockSend.mockReset();
  sqsSend.mockReset();
  lambdaSend.mockReset();
  delete process.env.TABLE_SIGNALS_V2;
  delete process.env.TABLE_RATIFICATIONS;
  delete process.env.TABLE_NEWS_EVENTS;
  delete process.env.TABLE_SENTIMENT_AGGREGATES;
  delete process.env.TABLE_INGESTION_METADATA;
  delete process.env.TABLE_CANDLES;
  delete process.env.TABLE_PREFIX;
  delete process.env.ENRICHMENT_QUEUE_URL;
  delete process.env.AWS_ACCOUNT_ID;
  delete process.env.AWS_REGION;
  delete process.env.INDICATOR_HANDLER_FUNCTION_NAME;
});

// ---------------------------------------------------------------------------
// forceRatification
// ---------------------------------------------------------------------------

describe("forceRatification", () => {
  it("returns 429-equivalent when the daily cap is exceeded", async () => {
    mockIdempotencyOk();
    dynamoSend.mockResolvedValueOnce({ Count: 200 }); // cap check

    const { forceRatification } = await import("./admin-debug.service.js");
    const result = await forceRatification({
      pair: "BTC/USDT",
      timeframe: "1h",
      userId: "user_admin",
    });

    expect(result.capped).toBe(true);
    expect(result.capCount).toBe(200);
    expect(result.verdictKind).toBeNull();
    expect(dynamoSend).toHaveBeenCalledTimes(2); // idempotency + cap check
  });

  it("returns duplicate=true when idempotency reservation fails", async () => {
    // Conditional Put fails with ConditionalCheckFailedException
    const err = Object.assign(new Error("conditional"), {
      name: "ConditionalCheckFailedException",
    });
    dynamoSend.mockRejectedValueOnce(err);

    const { forceRatification } = await import("./admin-debug.service.js");
    const result = await forceRatification({
      pair: "BTC/USDT",
      timeframe: "1h",
      userId: "user_admin",
    });

    expect(result.duplicate).toBe(true);
    expect(result.verdictKind).toBeNull();
    expect(dynamoSend).toHaveBeenCalledTimes(1); // only the idempotency Put
  });

  it("fails closed when the cap-check DDB query throws", async () => {
    mockIdempotencyOk();
    dynamoSend.mockRejectedValueOnce(new Error("DDB unavailable"));

    const { forceRatification } = await import("./admin-debug.service.js");
    await expect(
      forceRatification({ pair: "BTC/USDT", timeframe: "1h", userId: "user_admin" }),
    ).rejects.toThrow("DDB unavailable");
  });

  it("throws when no signal exists in signals_v2", async () => {
    mockIdempotencyOk();
    dynamoSend
      .mockResolvedValueOnce({ Count: 0 }) // cap check — not exceeded
      .mockResolvedValueOnce({ Items: [] }); // signals_v2 query — empty

    const { forceRatification } = await import("./admin-debug.service.js");
    await expect(
      forceRatification({ pair: "BTC/USDT", timeframe: "1h", userId: "user_admin" }),
    ).rejects.toThrow("No signal found");
  });

  it("calls Bedrock and writes a ratification record on success", async () => {
    const fakeSignal = { type: "buy", confidence: 0.8, rulesFired: ["rsi_oversold"] };

    mockIdempotencyOk();
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
    const result = await forceRatification({
      pair: "BTC/USDT",
      timeframe: "1h",
      userId: "user_admin",
    });

    expect(result.verdictKind).toBe("ratify");
    expect(result.algoSignalType).toBe("buy");
    expect(result.algoConfidence).toBeCloseTo(0.8);
    expect(result.ratifiedConfidence).toBeCloseTo(0.82);
    expect(result.reasoning).toBe("Signal is well-supported.");
    expect(result.cacheHit).toBe(false);
    expect(result.fellBackToAlgo).toBe(false);
    expect(result.recordId).toBe("test-uuid-1234");
    expect(result.costUsd).toBeGreaterThan(0);
    // DynamoDB: idempotency Put + cap check + signals query + put record
    expect(dynamoSend).toHaveBeenCalledTimes(4);
    expect(bedrockSend).toHaveBeenCalledTimes(1);
  });

  it("writes verdictKind=fallback when Bedrock throws (does NOT smuggle algo type)", async () => {
    const fakeSignal = { type: "hold", confidence: 0.5, rulesFired: [] };

    mockIdempotencyOk();
    dynamoSend
      .mockResolvedValueOnce({ Count: 0 }) // cap check
      .mockResolvedValueOnce({ Items: [fakeSignal] }) // signals_v2 query
      .mockResolvedValueOnce({}); // put record

    bedrockSend.mockRejectedValueOnce(new Error("Bedrock timeout"));

    const { forceRatification } = await import("./admin-debug.service.js");
    const result = await forceRatification({
      pair: "ETH/USDT",
      timeframe: "4h",
      userId: "user_admin",
    });

    expect(result.fellBackToAlgo).toBe(true);
    // verdictKind is the explicit fallback marker, NOT the algo signal type.
    expect(result.verdictKind).toBe("fallback");
    expect(result.algoSignalType).toBe("hold");
    expect(result.algoConfidence).toBe(0.5);
    expect(result.ratifiedConfidence).toBe(0.5);
  });

  it("persists canonical schema: ratified=null + validation.ok=false on fallback path", async () => {
    const fakeSignal = { type: "buy", confidence: 0.7, rulesFired: ["x"] };

    mockIdempotencyOk();
    dynamoSend
      .mockResolvedValueOnce({ Count: 0 })
      .mockResolvedValueOnce({ Items: [fakeSignal] })
      .mockResolvedValueOnce({});

    bedrockSend.mockRejectedValueOnce(new Error("Bedrock timeout"));

    const { forceRatification } = await import("./admin-debug.service.js");
    await forceRatification({ pair: "BTC/USDT", timeframe: "1h", userId: "user_admin" });

    // Index 3 = PutCommand for the ratification record (idem, cap, query, put).
    const putItem = dynamoSend.mock.calls[3][0].Item as Record<string, unknown>;
    expect(putItem.ratified).toBeNull();
    expect(putItem.validation).toEqual({ ok: false, reason: "bedrock_fallback" });
    expect(putItem.fellBackToAlgo).toBe(true);
    // Legacy field must NOT be present (admin.service.ts:toRatificationRow reads validation.ok).
    expect(putItem).not.toHaveProperty("validationOk");
    // 30-day TTL alignment with ingestion/src/lib/ratification-store.ts.
    const nowSec = Math.floor(Date.now() / 1000);
    expect(putItem.ttl).toBeGreaterThan(nowSec + 29 * 24 * 60 * 60);
  });

  it("persists canonical schema: ratified non-null + validation.ok=true on success path", async () => {
    const fakeSignal = { type: "buy", confidence: 0.8, rulesFired: ["rsi"] };

    mockIdempotencyOk();
    dynamoSend
      .mockResolvedValueOnce({ Count: 0 })
      .mockResolvedValueOnce({ Items: [fakeSignal] })
      .mockResolvedValueOnce({});

    bedrockSend.mockResolvedValueOnce({
      body: bedrockBody(
        '{"verdict":"downgrade","confidence":0.6,"reasoning":"Confidence too high."}',
      ),
    });

    const { forceRatification } = await import("./admin-debug.service.js");
    await forceRatification({ pair: "BTC/USDT", timeframe: "1h", userId: "user_admin" });

    const putItem = dynamoSend.mock.calls[3][0].Item as Record<string, unknown>;
    expect(putItem.validation).toEqual({ ok: true });
    expect(putItem.ratified).toMatchObject({
      type: "buy",
      confidence: 0.6,
      verdictKind: "downgrade",
    });
    expect(putItem).not.toHaveProperty("validationOk");
  });
});

// ---------------------------------------------------------------------------
// previewNewsEnrichment (formerly replayNewsEnrichment)
// ---------------------------------------------------------------------------

describe("previewNewsEnrichment", () => {
  it("returns duplicate=true when idempotency reservation fails", async () => {
    const err = Object.assign(new Error("conditional"), {
      name: "ConditionalCheckFailedException",
    });
    dynamoSend.mockRejectedValueOnce(err);

    const { previewNewsEnrichment } = await import("./admin-debug.service.js");
    const result = await previewNewsEnrichment({ newsId: "news-123", userId: "user_admin" });

    expect(result.duplicate).toBe(true);
  });

  it("throws when the news record is not found", async () => {
    mockIdempotencyOk();
    dynamoSend.mockResolvedValueOnce({ Items: [] });

    const { previewNewsEnrichment } = await import("./admin-debug.service.js");
    await expect(
      previewNewsEnrichment({ newsId: "nonexistent-id", userId: "user_admin" }),
    ).rejects.toThrow("News record not found");
  });

  it("returns enrichment without mutating the stored row", async () => {
    const storedItem = {
      newsId: "news-123",
      title: "Bitcoin ETF approved by SEC",
      body: "The SEC has approved a spot Bitcoin ETF for the first time.",
      publishedAt: "2026-05-09T10:00:00Z",
      enrichment: { sentiment: "bullish", confidence: 0.9 },
    };

    mockIdempotencyOk();
    dynamoSend.mockResolvedValueOnce({ Items: [storedItem] });

    bedrockSend
      .mockResolvedValueOnce({
        body: bedrockBody('{"affectedPairs":["BTC","ETH"]}'),
      })
      .mockResolvedValueOnce({
        body: bedrockBody('{"score":0.9,"magnitude":0.85,"topic":"ETF approval"}'),
      });

    const { previewNewsEnrichment } = await import("./admin-debug.service.js");
    const result = await previewNewsEnrichment({ newsId: "news-123", userId: "user_admin" });

    expect(result.newsId).toBe("news-123");
    expect(result.title).toBe("Bitcoin ETF approved by SEC");
    expect(result.mutated).toBe(false);
    expect(result.storedEnrichment).toEqual({ sentiment: "bullish", confidence: 0.9 });
    expect(result.previewedEnrichment.mentionedPairs).toContain("BTC");
    expect(result.previewedEnrichment.sentiment.score).toBeCloseTo(0.9);
    expect(result.previewedEnrichment.sentiment.magnitude).toBeCloseTo(0.85);
    expect(result.previewedEnrichment.sentiment.model).toBe("anthropic.claude-haiku-4-5");

    // Only the idempotency Put + the news Query should hit DDB; no record-level
    // mutation. Filter out the idempotency Put (`metaKey` field) when checking.
    const productionPuts = dynamoSend.mock.calls.filter((call: unknown[]) => {
      const cmd = call[0] as { _type?: string; Item?: Record<string, unknown> };
      return (
        cmd?._type === "Put" && !(cmd.Item?.["metaKey"] as string)?.startsWith("admin-debug-idem#")
      );
    });
    expect(productionPuts).toHaveLength(0);
  });

  it("still returns partial results when LLM pair-tagging fails", async () => {
    const storedItem = {
      newsId: "news-456",
      title: "Solana upgrade released",
      body: "The Solana network upgraded to v2.0 with 50k TPS.",
      publishedAt: "2026-05-09T09:00:00Z",
    };

    mockIdempotencyOk();
    dynamoSend.mockResolvedValueOnce({ Items: [storedItem] });

    bedrockSend.mockRejectedValueOnce(new Error("LLM timeout")).mockResolvedValueOnce({
      body: bedrockBody('{"score":0.6,"magnitude":0.7,"topic":"protocol upgrade"}'),
    });

    const { previewNewsEnrichment } = await import("./admin-debug.service.js");
    const result = await previewNewsEnrichment({ newsId: "news-456", userId: "user_admin" });

    expect(result.previewedEnrichment.mentionedPairs).toContain("SOL");
    expect(result.previewedEnrichment.sentiment.score).toBeCloseTo(0.6);
    expect(result.mutated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reenrichNews
// ---------------------------------------------------------------------------

describe("reenrichNews", () => {
  it("returns duplicate=true when idempotency reservation fails", async () => {
    const err = Object.assign(new Error("conditional"), {
      name: "ConditionalCheckFailedException",
    });
    dynamoSend.mockRejectedValueOnce(err);

    const { reenrichNews } = await import("./admin-debug.service.js");
    const result = await reenrichNews({
      newsId: "news-123",
      publishedAt: "2026-05-01T12:00:00Z",
      userId: "user_admin",
    });

    expect(result.duplicate).toBe(true);
    expect(result.messageId).toBe("");
    // No DDB UpdateItem or SQS SendMessage should have been called.
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("resets status to raw and sends SQS message on success", async () => {
    process.env.ENRICHMENT_QUEUE_URL = "https://sqs.us-west-2.amazonaws.com/123/test-enrichment";
    mockIdempotencyOk();
    // UpdateItem succeeds
    dynamoSend.mockResolvedValueOnce({});
    // SQS SendMessage succeeds
    sqsSend.mockResolvedValueOnce({ MessageId: "sqs-msg-id-abc" });

    const { reenrichNews } = await import("./admin-debug.service.js");
    const result = await reenrichNews({
      newsId: "news-123",
      publishedAt: "2026-05-01T12:00:00Z",
      userId: "user_admin",
    });

    expect(result.newsId).toBe("news-123");
    expect(result.messageId).toBe("sqs-msg-id-abc");
    expect(result.hint).toMatch(/queued/i);
    expect(result.duplicate).toBeUndefined();

    // DDB: idempotency Put + UpdateItem
    expect(dynamoSend).toHaveBeenCalledTimes(2);
    const updateCall = dynamoSend.mock.calls[1][0] as {
      _type: string;
      UpdateExpression: string;
    };
    expect(updateCall._type).toBe("Update");
    expect(updateCall.UpdateExpression).toContain(":raw");

    // SQS: SendMessage
    expect(sqsSend).toHaveBeenCalledTimes(1);
    const sqsCall = sqsSend.mock.calls[0][0] as {
      QueueUrl: string;
      MessageBody: string;
    };
    expect(sqsCall.QueueUrl).toBe("https://sqs.us-west-2.amazonaws.com/123/test-enrichment");
    const sqsBody = JSON.parse(sqsCall.MessageBody) as {
      type: string;
      data: { newsId: string; publishedAt: string };
    };
    expect(sqsBody.type).toBe("enrich_news");
    expect(sqsBody.data.newsId).toBe("news-123");
    expect(sqsBody.data.publishedAt).toBe("2026-05-01T12:00:00Z");
  });

  it("propagates DynamoDB UpdateItem errors", async () => {
    mockIdempotencyOk();
    dynamoSend.mockRejectedValueOnce(new Error("DDB access denied"));

    const { reenrichNews } = await import("./admin-debug.service.js");
    await expect(
      reenrichNews({
        newsId: "news-123",
        publishedAt: "2026-05-01T12:00:00Z",
        userId: "user_admin",
      }),
    ).rejects.toThrow("DDB access denied");

    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("propagates SQS SendMessage errors", async () => {
    process.env.ENRICHMENT_QUEUE_URL = "https://sqs.us-west-2.amazonaws.com/123/test-enrichment";
    mockIdempotencyOk();
    dynamoSend.mockResolvedValueOnce({});
    sqsSend.mockRejectedValueOnce(new Error("SQS access denied"));

    const { reenrichNews } = await import("./admin-debug.service.js");
    await expect(
      reenrichNews({
        newsId: "news-123",
        publishedAt: "2026-05-01T12:00:00Z",
        userId: "user_admin",
      }),
    ).rejects.toThrow("SQS access denied");
  });
});

// ---------------------------------------------------------------------------
// injectSentimentShock
// ---------------------------------------------------------------------------

describe("injectSentimentShock", () => {
  it("returns duplicate=true when idempotency reservation fails", async () => {
    const err = Object.assign(new Error("conditional"), {
      name: "ConditionalCheckFailedException",
    });
    dynamoSend.mockRejectedValueOnce(err);

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    const result = await injectSentimentShock({
      pair: "BTC/USDT",
      deltaScore: 0.5,
      deltaMagnitude: 0,
      userId: "user_admin",
    });

    expect(result.duplicate).toBe(true);
  });

  it("returns skipped when the delta is below the threshold", async () => {
    mockIdempotencyOk();
    dynamoSend.mockResolvedValueOnce({ Item: { meanScore: 0.1, meanMagnitude: 0.6 } });

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    const result = await injectSentimentShock({
      pair: "BTC/USDT",
      deltaScore: 0.1,
      deltaMagnitude: 0,
      userId: "user_admin",
    });

    expect(result.decision).toBe("skipped");
    expect(result.reasons.some((r) => r.includes("threshold"))).toBe(true);
    expect(result.shockRecord).toBeNull();
  });

  it("returns skipped when magnitude is below floor", async () => {
    mockIdempotencyOk();
    dynamoSend.mockResolvedValueOnce({ Item: { meanScore: 0.0, meanMagnitude: 0.1 } });

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    const result = await injectSentimentShock({
      pair: "ETH/USDT",
      deltaScore: 0.5,
      deltaMagnitude: 0,
      userId: "user_admin",
    });

    expect(result.decision).toBe("skipped");
    expect(result.reasons.some((r) => r.includes("floor"))).toBe(true);
  });

  it("returns gated when the hourly cap is exceeded", async () => {
    mockIdempotencyOk();
    dynamoSend
      .mockResolvedValueOnce({ Item: null }) // base aggregate — not found
      .mockResolvedValueOnce({ Count: 6 }); // hourly cap check — at limit

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    const result = await injectSentimentShock({
      pair: "BTC/USDT",
      deltaScore: 0.5,
      deltaMagnitude: 0.1,
      userId: "user_admin",
    });

    expect(result.decision).toBe("gated");
    expect(result.reasons.some((r) => r.includes("hourly cap"))).toBe(true);
    expect(result.shockRecord).toBeNull();
  });

  it("writes a shock record and returns fired when conditions are met", async () => {
    mockIdempotencyOk();
    dynamoSend
      .mockResolvedValueOnce({ Item: { meanScore: 0.0, meanMagnitude: 0.6 } }) // base aggregate
      .mockResolvedValueOnce({ Count: 2 }) // hourly cap check — under cap
      .mockResolvedValueOnce({}); // PutCommand — shock record

    const { injectSentimentShock } = await import("./admin-debug.service.js");
    const result = await injectSentimentShock({
      pair: "SOL/USDT",
      deltaScore: 0.5,
      deltaMagnitude: 0.1,
      userId: "user_admin",
    });

    expect(result.decision).toBe("fired");
    expect(result.shockRecord).not.toBeNull();
    expect(result.shockRecord?.["triggerReason"]).toBe("sentiment_shock");
    // pair on the persisted shock is the canonical trading pair (not the bare
    // symbol used to read sentiment-aggregates) — Finding #4 in the review.
    expect(result.shockRecord?.["pair"]).toBe("SOL/USDT");
    // No top-level `syntheticShock` key — Finding #5; metadata moved into
    // `algoCandidate` so the row schema matches real shock rows.
    expect(result.shockRecord?.["syntheticShock"]).toBeUndefined();
    const algoCandidate = result.shockRecord?.["algoCandidate"] as Record<string, unknown>;
    expect(algoCandidate?.["injectedBy"]).toBe("admin-debug");
    expect(algoCandidate?.["baseSymbol"]).toBe("SOL");
    expect(result.reasons.some((r) => r.includes("recordId"))).toBe(true);
    expect(bedrockSend).not.toHaveBeenCalled();
    // DynamoDB: idempotency + aggregate read + cap check + put record
    expect(dynamoSend).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid deltaScore outside [-2, 2]", async () => {
    const { injectSentimentShock } = await import("./admin-debug.service.js");
    await expect(
      injectSentimentShock({
        pair: "BTC/USDT",
        deltaScore: 3,
        deltaMagnitude: 0,
        userId: "user_admin",
      }),
    ).rejects.toThrow("deltaScore must be");
  });

  it("rejects invalid deltaMagnitude outside [-1, 1]", async () => {
    const { injectSentimentShock } = await import("./admin-debug.service.js");
    await expect(
      injectSentimentShock({
        pair: "BTC/USDT",
        deltaScore: 0.5,
        deltaMagnitude: 1.5,
        userId: "user_admin",
      }),
    ).rejects.toThrow("deltaMagnitude must be");
  });
});

// ---------------------------------------------------------------------------
// forceIndicators (service-level — payload shape regression tests)
// ---------------------------------------------------------------------------

describe("forceIndicators", () => {
  const FAKE_CLOSE_TIME = 1715187600000;

  it("includes force=true and the queried closeTime in the Lambda payload", async () => {
    process.env.INDICATOR_HANDLER_FUNCTION_NAME = "quantara-dev-indicator-handler";

    // DDB Query for latest candle returns one item with a real closeTime.
    dynamoSend.mockResolvedValueOnce({
      Items: [{ closeTime: FAKE_CLOSE_TIME, exchange: "binanceus" }],
    });
    // Lambda invoke succeeds.
    lambdaSend.mockResolvedValueOnce({ FunctionError: undefined });

    const { forceIndicators } = await import("./admin-debug.service.js");
    const result = await forceIndicators({
      pair: "BTC/USDT",
      exchange: "binanceus",
      timeframe: "1h",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.ok).toBe(true);

    // Assert the Lambda was invoked exactly once.
    expect(lambdaSend).toHaveBeenCalledTimes(1);

    // Inspect the payload sent to the Lambda.
    const invokeCall = lambdaSend.mock.calls[0][0] as {
      Payload: Uint8Array;
      FunctionName: string;
      InvocationType: string;
    };
    expect(invokeCall.FunctionName).toBe("quantara-dev-indicator-handler");
    expect(invokeCall.InvocationType).toBe("RequestResponse");

    const payload = JSON.parse(new TextDecoder().decode(invokeCall.Payload)) as {
      Records: Array<{ dynamodb: { NewImage: Record<string, unknown> } }>;
    };
    const newImage = payload.Records[0]!.dynamodb.NewImage;

    // closeTime must match the real candle's closeTime, not Date.now().
    expect(newImage["closeTime"]).toEqual({ N: String(FAKE_CLOSE_TIME) });
    // force=true must be present so the handler bypasses quorum + dedup.
    expect(newImage["force"]).toEqual({ BOOL: true });
    // pair, exchange, timeframe must be set.
    expect(newImage["pair"]).toEqual({ S: "BTC/USDT" });
    expect(newImage["exchange"]).toEqual({ S: "binanceus" });
    expect(newImage["timeframe"]).toEqual({ S: "1h" });
  });

  it("returns ok=false with error when no candles exist for the tuple", async () => {
    process.env.INDICATOR_HANDLER_FUNCTION_NAME = "quantara-dev-indicator-handler";

    // DDB Query returns empty Items (no candle stored yet).
    dynamoSend.mockResolvedValueOnce({ Items: [] });

    const { forceIndicators } = await import("./admin-debug.service.js");
    const result = await forceIndicators({
      pair: "BTC/USDT",
      exchange: "binanceus",
      timeframe: "15m",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.ok).toBe(false);
    expect(result.results[0]!.error).toMatch(/no live candles found/);

    // Lambda must NOT have been invoked — no point computing on empty candles.
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("returns ok=false when INDICATOR_HANDLER_FUNCTION_NAME env var is missing", async () => {
    // env var not set (deleted in beforeEach).
    // DDB query would not even be reached.

    const { forceIndicators } = await import("./admin-debug.service.js");
    const result = await forceIndicators({
      pair: "BTC/USDT",
      exchange: "binanceus",
      timeframe: "1h",
    });

    expect(result.results[0]!.ok).toBe(false);
    expect(result.results[0]!.error).toMatch(/INDICATOR_HANDLER_FUNCTION_NAME/);
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("returns ok=false (with error) when Lambda returns FunctionError", async () => {
    process.env.INDICATOR_HANDLER_FUNCTION_NAME = "quantara-dev-indicator-handler";

    dynamoSend.mockResolvedValueOnce({
      Items: [{ closeTime: FAKE_CLOSE_TIME }],
    });
    lambdaSend.mockResolvedValueOnce({
      FunctionError: "Unhandled",
      Payload: new TextEncoder().encode(JSON.stringify({ errorMessage: "handler exploded" })),
    });

    const { forceIndicators } = await import("./admin-debug.service.js");
    const result = await forceIndicators({
      pair: "BTC/USDT",
      exchange: "binanceus",
      timeframe: "4h",
    });

    expect(result.results[0]!.ok).toBe(false);
    expect(result.results[0]!.error).toMatch(/Lambda error/);
  });
});
