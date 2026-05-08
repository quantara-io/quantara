/**
 * Tests for news/aggregator.ts
 *
 * Covers:
 * - computeTrend24h pure-function math
 * - recomputeSentimentAggregate (mocked SDK) — the integration-style SQS → DDB path
 *   is exercised in aggregator-handler.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FearGreedHistoryEntry } from "./fear-greed.js";

// ---- SDK mocks (must be hoisted before any module import) ----

const ddbSendMock = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({ send: ddbSendMock }),
  },
  GetCommand: vi.fn().mockImplementation((input) => input),
  PutCommand: vi.fn().mockImplementation((input) => input),
}));

// news-by-pair-store is also mocked so we control what the aggregator "sees"
const queryNewsByPairMock = vi.fn();
vi.mock("../lib/news-by-pair-store.js", () => ({
  queryNewsByPair: queryNewsByPairMock,
}));

beforeEach(() => {
  vi.resetModules();
  ddbSendMock.mockReset();
  queryNewsByPairMock.mockReset();
});

// ---- computeTrend24h tests (pure function) ----

describe("computeTrend24h", () => {
  it("returns null when history is empty", async () => {
    const { computeTrend24h } = await import("./aggregator.js");
    expect(computeTrend24h([])).toBeNull();
  });

  it("returns null when only one entry exists", async () => {
    const { computeTrend24h } = await import("./aggregator.js");
    const history: FearGreedHistoryEntry[] = [
      { value: 50, classification: "Neutral", timestamp: new Date().toISOString() },
    ];
    expect(computeTrend24h(history)).toBeNull();
  });

  it("returns difference between most-recent and 24h-ago baseline", async () => {
    const { computeTrend24h } = await import("./aggregator.js");
    const now = Date.now();
    // baseline is ~25h ago (older than 24h cutoff)
    const baseline: FearGreedHistoryEntry = {
      value: 40,
      classification: "Fear",
      timestamp: new Date(now - 25 * 3600 * 1000).toISOString(),
    };
    // latest is 30 minutes ago
    const latest: FearGreedHistoryEntry = {
      value: 55,
      classification: "Neutral",
      timestamp: new Date(now - 30 * 60 * 1000).toISOString(),
    };
    const result = computeTrend24h([baseline, latest]);
    expect(result).toBe(15); // 55 - 40
  });

  it("falls back to oldest entry when nothing is older than 24h", async () => {
    const { computeTrend24h } = await import("./aggregator.js");
    const now = Date.now();
    const history: FearGreedHistoryEntry[] = [
      { value: 45, classification: "Fear", timestamp: new Date(now - 2 * 3600 * 1000).toISOString() },
      { value: 60, classification: "Greed", timestamp: new Date(now - 1 * 3600 * 1000).toISOString() },
      { value: 65, classification: "Greed", timestamp: new Date(now - 30 * 60 * 1000).toISOString() },
    ];
    // No entry is 24h old, so baseline = history[0] (value=45), latest = history[2] (value=65)
    const result = computeTrend24h(history);
    expect(result).toBe(20); // 65 - 45
  });

  it("picks the most-recent entry that is still >=24h old as baseline", async () => {
    const { computeTrend24h } = await import("./aggregator.js");
    const now = Date.now();
    const history: FearGreedHistoryEntry[] = [
      { value: 30, classification: "Extreme Fear", timestamp: new Date(now - 30 * 3600 * 1000).toISOString() },
      { value: 38, classification: "Fear",         timestamp: new Date(now - 25 * 3600 * 1000).toISOString() },
      { value: 70, classification: "Greed",        timestamp: new Date(now - 1 * 3600 * 1000).toISOString() },
    ];
    // Both index 0 and index 1 are >=24h old; we keep the most recent baseline = index 1 (38)
    const result = computeTrend24h(history);
    expect(result).toBe(32); // 70 - 38
  });
});

// ---- recomputeSentimentAggregate tests (mocked DDB + store) ----

describe("recomputeSentimentAggregate", () => {
  it("returns articleCount=0 and meanScore=null when no articles exist in the window", async () => {
    queryNewsByPairMock.mockResolvedValue([]);
    // Stub the Fear & Greed GetCommand
    ddbSendMock.mockResolvedValue({ Item: null });

    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    const result = await recomputeSentimentAggregate("BTC", "4h");

    expect(result.pair).toBe("BTC");
    expect(result.window).toBe("4h");
    expect(result.articleCount).toBe(0);
    expect(result.meanScore).toBeNull();
    expect(result.meanMagnitude).toBeNull();
  });

  it("computes correct meanScore excluding duplicate articles", async () => {
    queryNewsByPairMock.mockResolvedValue([
      { articleId: "a1", publishedAt: "2026-05-07T10:00:00Z", sentimentScore: 0.8, sentimentMagnitude: 0.9, duplicateOf: null },
      { articleId: "a2", publishedAt: "2026-05-07T10:30:00Z", sentimentScore: 0.4, sentimentMagnitude: 0.5, duplicateOf: null },
      { articleId: "a3", publishedAt: "2026-05-07T11:00:00Z", sentimentScore: 0.6, sentimentMagnitude: 0.7, duplicateOf: "a1" }, // duplicate — excluded
    ]);
    ddbSendMock.mockResolvedValue({ Item: null });

    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    const result = await recomputeSentimentAggregate("ETH", "24h");

    expect(result.articleCount).toBe(2); // a3 excluded
    expect(result.meanScore).toBeCloseTo(0.6, 5); // (0.8 + 0.4) / 2
    expect(result.meanMagnitude).toBeCloseTo(0.7, 5); // (0.9 + 0.5) / 2
  });

  it("writes the aggregate to DynamoDB (PutCommand called once)", async () => {
    queryNewsByPairMock.mockResolvedValue([
      { articleId: "a1", publishedAt: "2026-05-07T10:00:00Z", sentimentScore: 0.5, sentimentMagnitude: 0.5, duplicateOf: null },
    ]);
    ddbSendMock.mockResolvedValue({ Item: null });

    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    await recomputeSentimentAggregate("SOL", "4h");

    // First call = GetCommand for Fear & Greed, second call = PutCommand for aggregate
    expect(ddbSendMock).toHaveBeenCalledTimes(2);
    const putCall = ddbSendMock.mock.calls[1][0];
    expect(putCall.Item?.pair).toBe("SOL");
    expect(putCall.Item?.window).toBe("4h");
  });

  it("includes fearGreedLatest when the metadata record exists", async () => {
    queryNewsByPairMock.mockResolvedValue([]);
    ddbSendMock.mockResolvedValueOnce({
      Item: { value: 72, history: [], classification: "Greed" },
    });
    ddbSendMock.mockResolvedValueOnce({}); // PutCommand

    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    const result = await recomputeSentimentAggregate("BTC", "24h");

    expect(result.fearGreedLatest).toBe(72);
  });
});
