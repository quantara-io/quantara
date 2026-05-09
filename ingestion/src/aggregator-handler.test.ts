/**
 * aggregator-handler.test.ts
 *
 * Integration-style test for the SQS → aggregator → DDB path.
 * All AWS SDK calls and downstream collaborators (aggregator,
 * sentiment-shock, news/bundle's `getFearGreed`) are mocked at the module
 * boundary so no real AWS access is needed.
 *
 * This test exercises the failure mode that PR #75's unit tests missed:
 * the handler must fan out to all mentionedPairs and call recomputeSentimentAggregate
 * for each (pair, window) combination, using the news-events-by-pair table.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQSEvent, Context } from "aws-lambda";

// ---- Mock the aggregator module so we can spy on recompute calls ----
const recomputeMock = vi.fn();
vi.mock("./news/aggregator.js", () => ({
  recomputeSentimentAggregate: recomputeMock,
}));

// ---- Mock sentiment-shock so no DDB/LLM calls in handler tests ----
const maybeFireShockMock = vi.fn();
vi.mock("./news/sentiment-shock.js", () => ({
  maybeFireSentimentShockRatification: maybeFireShockMock,
}));

// ---- Mock news/bundle so getFearGreed doesn't hit the metadata table ----
// The handler reads F&G unconditionally before the shock-flag check,
// so even with the shock pipeline gated off this needs a stub.
const getFearGreedMock = vi.fn();
vi.mock("./news/bundle.js", () => ({
  getFearGreed: getFearGreedMock,
}));

beforeEach(() => {
  vi.resetModules();
  recomputeMock.mockReset();
  maybeFireShockMock.mockReset();
  getFearGreedMock.mockReset();
  // Return the shape the handler expects: { aggregate, previousAggregate }
  recomputeMock.mockResolvedValue({ aggregate: {}, previousAggregate: null });
  maybeFireShockMock.mockResolvedValue(undefined);
  getFearGreedMock.mockResolvedValue({
    value: 50,
    classification: "Neutral",
    lastTimestamp: "2026-05-09T00:00:00.000Z",
    history: [],
    trend24h: 0,
  });
});

function makeSqsEvent(
  articles: Array<{
    newsId?: string;
    mentionedPairs?: string[];
    duplicateOf?: string | null;
  }>,
): SQSEvent {
  return {
    Records: articles.map((a, i) => ({
      messageId: `msg-${i}`,
      receiptHandle: `rh-${i}`,
      body: JSON.stringify({
        type: "enriched_news",
        data: a,
        timestamp: new Date().toISOString(),
      }),
      attributes: {} as never,
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-west-2:123456789012:test-enriched-news",
      awsRegion: "us-west-2",
    })),
  };
}

const fakeContext = {} as Context;

// ---- Tests ----

describe("aggregator-handler — SQS path", () => {
  it("calls recomputeSentimentAggregate for each (pair, window) for a non-duplicate article", async () => {
    const { handler } = await import("./aggregator-handler.js");
    const event = makeSqsEvent([
      { newsId: "art-1", mentionedPairs: ["BTC", "ETH"], duplicateOf: null },
    ]);

    await handler(event, fakeContext);

    // 2 pairs × 2 windows = 4 calls
    expect(recomputeMock).toHaveBeenCalledTimes(4);
    expect(recomputeMock).toHaveBeenCalledWith("BTC", "4h");
    expect(recomputeMock).toHaveBeenCalledWith("BTC", "24h");
    expect(recomputeMock).toHaveBeenCalledWith("ETH", "4h");
    expect(recomputeMock).toHaveBeenCalledWith("ETH", "24h");
  });

  it("skips duplicate articles entirely", async () => {
    const { handler } = await import("./aggregator-handler.js");
    const event = makeSqsEvent([
      { newsId: "art-2", mentionedPairs: ["BTC"], duplicateOf: "art-1" },
    ]);

    await handler(event, fakeContext);

    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("skips articles with no mentionedPairs", async () => {
    const { handler } = await import("./aggregator-handler.js");
    const event = makeSqsEvent([{ newsId: "art-3", mentionedPairs: [], duplicateOf: null }]);

    await handler(event, fakeContext);

    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it("processes multiple records in one batch", async () => {
    const { handler } = await import("./aggregator-handler.js");
    const event = makeSqsEvent([
      { newsId: "art-4", mentionedPairs: ["SOL"], duplicateOf: null },
      { newsId: "art-5", mentionedPairs: ["XRP", "DOGE"], duplicateOf: null },
      { newsId: "art-6", mentionedPairs: ["BTC"], duplicateOf: "art-4" }, // duplicate — skip
    ]);

    await handler(event, fakeContext);

    // SOL×2 + XRP×2 + DOGE×2 = 6 calls (BTC duplicate is skipped)
    expect(recomputeMock).toHaveBeenCalledTimes(6);
  });

  it("continues processing other records when one recompute throws", async () => {
    recomputeMock
      .mockRejectedValueOnce(new Error("DDB timeout")) // first call fails
      .mockResolvedValue({}); // rest succeed

    const { handler } = await import("./aggregator-handler.js");
    const event = makeSqsEvent([{ newsId: "art-7", mentionedPairs: ["BTC"], duplicateOf: null }]);

    // Should not throw — errors are caught per-pair
    await expect(handler(event, fakeContext)).resolves.toBeUndefined();
    // All 2 calls were still attempted
    expect(recomputeMock).toHaveBeenCalledTimes(2);
  });

  it("handles malformed SQS body gracefully (continues, no throw)", async () => {
    const { handler } = await import("./aggregator-handler.js");
    const badEvent: SQSEvent = {
      Records: [
        {
          messageId: "bad-1",
          receiptHandle: "rh-bad",
          body: "not-json}}}",
          attributes: {} as never,
          messageAttributes: {},
          md5OfBody: "",
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:us-west-2:123456789012:test",
          awsRegion: "us-west-2",
        },
      ],
    };

    await expect(handler(badEvent, fakeContext)).resolves.toBeUndefined();
    expect(recomputeMock).not.toHaveBeenCalled();
  });
});

describe("aggregator-handler — EventBridge scheduled fallback", () => {
  it("recomputes all 5 default pairs × 2 windows when no Records present", async () => {
    const { handler } = await import("./aggregator-handler.js");
    // Simulate EventBridge scheduled event (no Records)
    const scheduledEvent = { source: "aws.events", "detail-type": "Scheduled Event" } as never;

    await handler(scheduledEvent, fakeContext);

    // 5 pairs × 2 windows = 10 calls
    expect(recomputeMock).toHaveBeenCalledTimes(10);
  });
});
