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
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
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
  publishedAt: string
) {
  return {
    newsId: id,
    title: `Title ${id}`,
    source,
    publishedAt,
    url: `https://example.com/${id}`,
    sentiment: { score, magnitude },
    duplicateOf: null,
    mentionedPairs: ["BTC"],
    currency: "BTC",
    status: "enriched",
  };
}

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_NEWS_EVENTS = "test-news-events";
  process.env.TABLE_SENTIMENT_AGGREGATES = "test-sentiment-aggregates";
  process.env.TABLE_METADATA = "test-metadata";
});

// ---------------------------------------------------------------------------
// computeTrend24h
// ---------------------------------------------------------------------------

describe("computeTrend24h", () => {
  it("returns 0 when history is empty", async () => {
    const { computeTrend24h } = await import("./bundle.js");
    expect(computeTrend24h([])).toBe(0);
  });

  it("returns 0 when history has only one entry", async () => {
    const { computeTrend24h } = await import("./bundle.js");
    expect(computeTrend24h([{ value: 50, timestamp: Date.now() }])).toBe(0);
  });

  it("returns latest minus 24h-ago value when history spans > 24h", async () => {
    const { computeTrend24h } = await import("./bundle.js");
    const now = Date.now();
    const history = [
      { value: 70, timestamp: now },
      { value: 55, timestamp: now - 24 * 3600 * 1000 - 1 }, // just over 24h ago
      { value: 40, timestamp: now - 48 * 3600 * 1000 },
    ];
    const trend = computeTrend24h(history);
    expect(trend).toBe(70 - 55); // 15
  });

  it("uses the oldest entry when history is shorter than 24h", async () => {
    const { computeTrend24h } = await import("./bundle.js");
    const now = Date.now();
    const history = [
      { value: 60, timestamp: now },
      { value: 45, timestamp: now - 12 * 3600 * 1000 }, // only 12h ago
    ];
    const trend = computeTrend24h(history);
    expect(trend).toBe(60 - 45); // 15
  });
});

// ---------------------------------------------------------------------------
// buildSentimentBundle
// ---------------------------------------------------------------------------

describe("buildSentimentBundle", () => {
  it("returns the §6.8 SentimentBundle shape", async () => {
    // Mock: getSentimentAggregate (Get for 4h and 24h), queryRecentNewsEvents (Query), getFearGreed (Get)
    const agg4h = { pair: "BTC", window: "4h", score: 0.3, magnitude: 0.6, articleCount: 2, sourceCounts: { alpaca: 2 }, computedAt: "2026-05-07T00:00:00Z", ttl: 9999 };
    const agg24h = { pair: "BTC", window: "24h", score: 0.1, magnitude: 0.4, articleCount: 5, sourceCounts: { alpaca: 3, coindesk: 2 }, computedAt: "2026-05-07T00:00:00Z", ttl: 9999 };
    const fng = { metaKey: "market:fear-greed", value: 65, classification: "Greed", history: [] };

    const articles = [
      makeArticle("a1", "alpaca", 0.5, 0.8, "2026-05-07T02:00:00Z"),
      makeArticle("a2", "coindesk", 0.3, 0.5, "2026-05-07T01:00:00Z"),
      makeArticle("a3", "alpaca", -0.1, 0.2, "2026-05-07T00:00:00Z"),
    ];

    let getCallCount = 0;
    send.mockImplementation(async (cmd: { __cmd: string; input: Record<string, unknown> }) => {
      if (cmd.__cmd === "Get") {
        getCallCount++;
        const key = cmd.input.Key as Record<string, unknown>;
        if (key.pair === "BTC" && key.window === "4h") return { Item: agg4h };
        if (key.pair === "BTC" && key.window === "24h") return { Item: agg24h };
        if (key.metaKey === "market:fear-greed") return { Item: fng };
        return {};
      }
      if (cmd.__cmd === "Query") return { Items: articles };
      return {};
    });

    const { buildSentimentBundle } = await import("./bundle.js");
    const bundle = await buildSentimentBundle("BTC");

    expect(bundle.pair).toBe("BTC");

    // Windows shape
    expect(bundle.windows["4h"].score).toBeCloseTo(0.3, 5);
    expect(bundle.windows["4h"].articleCount).toBe(2);
    expect(bundle.windows["24h"].score).toBeCloseTo(0.1, 5);
    expect(bundle.windows["24h"].articleCount).toBe(5);

    // recentArticles — top 5 sorted by publishedAt desc; only 3 articles here
    expect(bundle.recentArticles).toHaveLength(3);
    expect(bundle.recentArticles[0].source).toBe("alpaca");
    expect(bundle.recentArticles[0].sentiment).toBeCloseTo(0.5, 5);
    expect(bundle.recentArticles[0].publishedAt).toBe("2026-05-07T02:00:00Z");

    // fearGreed
    expect(bundle.fearGreed.value).toBe(65);
    expect(bundle.fearGreed.trend24h).toBe(0); // empty history
  });

  it("caps recentArticles at 5 when more are returned", async () => {
    const articles = Array.from({ length: 10 }, (_, i) =>
      makeArticle(`a${i}`, "alpaca", 0.1, 0.1, `2026-05-07T${String(i).padStart(2, "0")}:00:00Z`)
    );

    send.mockImplementation(async (cmd: { __cmd: string; input: Record<string, unknown> }) => {
      if (cmd.__cmd === "Get") {
        const key = cmd.input.Key as Record<string, unknown>;
        if (key.pair) return {}; // no aggregates
        if (key.metaKey === "market:fear-greed") return {}; // no fear-greed
        return {};
      }
      if (cmd.__cmd === "Query") return { Items: articles };
      return {};
    });

    const { buildSentimentBundle } = await import("./bundle.js");
    const bundle = await buildSentimentBundle("BTC");

    expect(bundle.recentArticles).toHaveLength(5);
  });

  it("returns zero windows when aggregates are not found", async () => {
    send.mockImplementation(async (cmd: { __cmd: string; input: Record<string, unknown> }) => {
      if (cmd.__cmd === "Get") return {}; // not found
      if (cmd.__cmd === "Query") return { Items: [] };
      return {};
    });

    const { buildSentimentBundle } = await import("./bundle.js");
    const bundle = await buildSentimentBundle("DOGE");

    expect(bundle.windows["4h"].score).toBe(0);
    expect(bundle.windows["4h"].articleCount).toBe(0);
    expect(bundle.windows["24h"].score).toBe(0);
    expect(bundle.recentArticles).toHaveLength(0);
    expect(bundle.fearGreed.value).toBe(50); // neutral fallback
  });

  it("excludes duplicate articles (duplicateOf filter is passed to query)", async () => {
    send.mockImplementation(async (cmd: { __cmd: string; input: Record<string, unknown> }) => {
      if (cmd.__cmd === "Get") return {};
      if (cmd.__cmd === "Query") {
        // Verify the FilterExpression includes duplicateOf guard
        const fe = cmd.input.FilterExpression as string;
        expect(fe).toContain("duplicateOf");
        return { Items: [] };
      }
      return {};
    });

    const { buildSentimentBundle } = await import("./bundle.js");
    await buildSentimentBundle("ETH");
  });
});
