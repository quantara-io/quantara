import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_SENTIMENT_AGGREGATES = "test-sentiment-aggregates";
});

describe("putSentimentAggregate", () => {
  it("calls PutCommand with a ttl field set to ~1 hour from now", async () => {
    send.mockResolvedValue({});
    const { putSentimentAggregate } = await import("./sentiment-store.js");

    const before = Math.floor(Date.now() / 1000);
    await putSentimentAggregate({
      pair: "BTC",
      window: "4h",
      score: 0.5,
      magnitude: 0.8,
      articleCount: 3,
      sourceCounts: { alpaca: 2, coindesk: 1 },
      computedAt: new Date().toISOString(),
    });
    const after = Math.floor(Date.now() / 1000);

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Put");
    const item = cmd.input.Item;
    expect(item.pair).toBe("BTC");
    expect(item.window).toBe("4h");
    expect(item.score).toBe(0.5);
    expect(item.articleCount).toBe(3);
    expect(item.ttl).toBeGreaterThanOrEqual(before + 3600);
    expect(item.ttl).toBeLessThanOrEqual(after + 3600);
  });

  it("uses the TABLE_SENTIMENT_AGGREGATES env var as the table name", async () => {
    send.mockResolvedValue({});
    const { putSentimentAggregate } = await import("./sentiment-store.js");

    await putSentimentAggregate({
      pair: "ETH",
      window: "24h",
      score: 0,
      magnitude: 0,
      articleCount: 0,
      sourceCounts: {},
      computedAt: new Date().toISOString(),
    });

    const cmd = send.mock.calls[0][0];
    expect(cmd.input.TableName).toBe("test-sentiment-aggregates");
  });
});

describe("getSentimentAggregate", () => {
  it("returns the item cast to SentimentAggregateRecord when found", async () => {
    const fixture = {
      pair: "BTC",
      window: "4h",
      score: 0.3,
      magnitude: 0.6,
      articleCount: 5,
      sourceCounts: {},
      computedAt: "2026-05-07T00:00:00Z",
      ttl: 9999999,
    };
    send.mockResolvedValue({ Item: fixture });
    const { getSentimentAggregate } = await import("./sentiment-store.js");

    const result = await getSentimentAggregate("BTC", "4h");
    expect(result).toEqual(fixture);

    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Get");
    expect(cmd.input.Key).toEqual({ pair: "BTC", window: "4h" });
  });

  it("returns null when the item does not exist", async () => {
    send.mockResolvedValue({});
    const { getSentimentAggregate } = await import("./sentiment-store.js");

    const result = await getSentimentAggregate("SOL", "24h");
    expect(result).toBeNull();
  });
});
