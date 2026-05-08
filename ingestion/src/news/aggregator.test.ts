import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// AWS SDK mocks
// ---------------------------------------------------------------------------

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArticle(
  id: string,
  source: string,
  score: number,
  magnitude: number,
  publishedAt?: string
) {
  return {
    newsId: id,
    title: `Title ${id}`,
    source,
    publishedAt: publishedAt ?? new Date().toISOString(),
    url: `https://example.com/${id}`,
    sentiment: { score, magnitude },
    duplicateOf: null,
    mentionedPairs: ["BTC"],
  };
}

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_NEWS_EVENTS = "test-news-events";
  process.env.TABLE_SENTIMENT_AGGREGATES = "test-sentiment-aggregates";
});

// ---------------------------------------------------------------------------
// queryNewsEventsByPair
// ---------------------------------------------------------------------------

describe("queryNewsEventsByPair", () => {
  it("queries the currency-index GSI with the correct pair and cutoff", async () => {
    send.mockResolvedValue({ Items: [] });
    const { queryNewsEventsByPair } = await import("./aggregator.js");

    const since = Date.now() - 4 * 3600 * 1000;
    await queryNewsEventsByPair("BTC", { since, deduped: true });

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Query");
    expect(cmd.input.TableName).toBe("test-news-events");
    expect(cmd.input.IndexName).toBe("currency-index");
    expect(cmd.input.ExpressionAttributeValues[":pair"]).toBe("BTC");
    expect(cmd.input.ExpressionAttributeValues[":cutoff"]).toBe(new Date(since).toISOString());
    expect(cmd.input.ExpressionAttributeValues[":enriched"]).toBe("enriched");
  });

  it("returns an empty array when no items are found", async () => {
    send.mockResolvedValue({ Items: [] });
    const { queryNewsEventsByPair } = await import("./aggregator.js");

    const result = await queryNewsEventsByPair("XRP", { since: Date.now() - 3600_000 });
    expect(result).toEqual([]);
  });

  it("returns items from the DynamoDB response", async () => {
    const articles = [makeArticle("a1", "alpaca", 0.5, 0.8), makeArticle("a2", "coindesk", -0.2, 0.4)];
    send.mockResolvedValue({ Items: articles });
    const { queryNewsEventsByPair } = await import("./aggregator.js");

    const result = await queryNewsEventsByPair("BTC", { since: Date.now() - 3600_000 });
    expect(result).toHaveLength(2);
    expect(result[0].newsId).toBe("a1");
  });
});

// ---------------------------------------------------------------------------
// recomputeSentimentAggregate
// ---------------------------------------------------------------------------

describe("recomputeSentimentAggregate", () => {
  it("writes a zeroed entry when no articles are found (empty window)", async () => {
    // Query returns empty, Put succeeds
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") return { Items: [] };
      return {}; // Put
    });

    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    await recomputeSentimentAggregate("BTC", "4h");

    const puts = send.mock.calls.filter((c) => c[0].__cmd === "Put");
    expect(puts).toHaveLength(1);
    const item = puts[0][0].input.Item;
    expect(item.pair).toBe("BTC");
    expect(item.window).toBe("4h");
    expect(item.score).toBe(0);
    expect(item.magnitude).toBe(0);
    expect(item.articleCount).toBe(0);
    expect(item.sourceCounts).toEqual({});
  });

  it("computes equal-weight mean score and magnitude across multiple articles", async () => {
    const articles = [
      makeArticle("a1", "alpaca", 0.6, 0.8, "2026-05-07T01:00:00Z"),
      makeArticle("a2", "alpaca", 0.2, 0.4, "2026-05-07T00:30:00Z"),
      makeArticle("a3", "coindesk", -0.4, 0.6, "2026-05-07T00:00:00Z"),
    ];
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") return { Items: articles };
      return {};
    });

    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    await recomputeSentimentAggregate("BTC", "4h");

    const puts = send.mock.calls.filter((c) => c[0].__cmd === "Put");
    expect(puts).toHaveLength(1);
    const item = puts[0][0].input.Item;

    // Equal-weight mean: (0.6 + 0.2 + -0.4) / 3 = 0.4/3 ≈ 0.1333
    expect(item.score).toBeCloseTo((0.6 + 0.2 - 0.4) / 3, 5);
    // magnitude: (0.8 + 0.4 + 0.6) / 3 = 0.6
    expect(item.magnitude).toBeCloseTo((0.8 + 0.4 + 0.6) / 3, 5);
    expect(item.articleCount).toBe(3);
  });

  it("counts sources correctly", async () => {
    const articles = [
      makeArticle("a1", "alpaca", 0.5, 0.5),
      makeArticle("a2", "alpaca", 0.5, 0.5),
      makeArticle("a3", "coindesk", 0.1, 0.1),
    ];
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") return { Items: articles };
      return {};
    });

    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    await recomputeSentimentAggregate("ETH", "24h");

    const puts = send.mock.calls.filter((c) => c[0].__cmd === "Put");
    const item = puts[0][0].input.Item;
    expect(item.sourceCounts).toEqual({ alpaca: 2, coindesk: 1 });
  });

  it("handles a single article correctly", async () => {
    const articles = [makeArticle("a1", "decrypt", 0.75, 0.9)];
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") return { Items: articles };
      return {};
    });

    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    await recomputeSentimentAggregate("SOL", "4h");

    const puts = send.mock.calls.filter((c) => c[0].__cmd === "Put");
    const item = puts[0][0].input.Item;
    expect(item.score).toBeCloseTo(0.75, 5);
    expect(item.magnitude).toBeCloseTo(0.9, 5);
    expect(item.articleCount).toBe(1);
  });

  it("uses a 4h cutoff for the '4h' window", async () => {
    send.mockResolvedValue({ Items: [] });
    const before = Date.now();
    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    await recomputeSentimentAggregate("BTC", "4h");
    const after = Date.now();

    const queryCall = send.mock.calls.find((c) => c[0].__cmd === "Query");
    expect(queryCall).toBeDefined();
    const cutoffIso = queryCall![0].input.ExpressionAttributeValues[":cutoff"];
    const cutoffMs = Date.parse(cutoffIso);
    const expected4h = 4 * 3600 * 1000;
    expect(cutoffMs).toBeGreaterThanOrEqual(before - expected4h);
    expect(cutoffMs).toBeLessThanOrEqual(after - expected4h + 100);
  });

  it("uses a 24h cutoff for the '24h' window", async () => {
    send.mockResolvedValue({ Items: [] });
    const before = Date.now();
    const { recomputeSentimentAggregate } = await import("./aggregator.js");
    await recomputeSentimentAggregate("BTC", "24h");
    const after = Date.now();

    const queryCall = send.mock.calls.find((c) => c[0].__cmd === "Query");
    expect(queryCall).toBeDefined();
    const cutoffIso = queryCall![0].input.ExpressionAttributeValues[":cutoff"];
    const cutoffMs = Date.parse(cutoffIso);
    const expected24h = 24 * 3600 * 1000;
    expect(cutoffMs).toBeGreaterThanOrEqual(before - expected24h);
    expect(cutoffMs).toBeLessThanOrEqual(after - expected24h + 100);
  });
});
