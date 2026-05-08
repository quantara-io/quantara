import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  BatchWriteCommand: vi.fn().mockImplementation((input) => ({ __cmd: "BatchWrite", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  send.mockReset();
  process.env.TABLE_NEWS_EVENTS_BY_PAIR = "test-news-by-pair";
});

afterEach(() => {
  vi.useRealTimers();
});

function makeRecord(overrides: Partial<{ pair: string; articleId: string }> = {}) {
  return {
    pair: "BTC",
    articleId: "art-001",
    publishedAt: "2026-05-08T10:00:00.000Z",
    title: "Bitcoin hits new ATH",
    sentimentScore: 0.8,
    sentimentMagnitude: 1.2,
    source: "cryptopanic",
    url: "https://example.com/art-001",
    duplicateOf: null,
    ...overrides,
  };
}

describe("writePairFanout", () => {
  it("does not call DynamoDB when given an empty list", async () => {
    const { writePairFanout } = await import("./news-by-pair-store.js");
    await writePairFanout([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("writes records in BatchWrite calls of up to 25", async () => {
    send.mockResolvedValue({});
    const records = Array.from({ length: 30 }, (_, i) =>
      makeRecord({ articleId: `art-${i}` }),
    );
    const { writePairFanout } = await import("./news-by-pair-store.js");
    await writePairFanout(records);
    const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
    expect(writes).toHaveLength(2);
    expect(writes[0][0].input.RequestItems["test-news-by-pair"]).toHaveLength(25);
    expect(writes[1][0].input.RequestItems["test-news-by-pair"]).toHaveLength(5);
  });

  it("builds the sort key as publishedAt#articleId", async () => {
    send.mockResolvedValue({});
    const { writePairFanout } = await import("./news-by-pair-store.js");
    await writePairFanout([makeRecord()]);
    const item =
      send.mock.calls[0][0].input.RequestItems["test-news-by-pair"][0].PutRequest.Item;
    expect(item.pair).toBe("BTC");
    expect(item.sk).toBe("2026-05-08T10:00:00.000Z#art-001");
  });

  it("sets a 30-day TTL on each item", async () => {
    send.mockResolvedValue({});
    const now = 1746691200; // fixed epoch seconds
    vi.setSystemTime(now * 1000);
    const { writePairFanout } = await import("./news-by-pair-store.js");
    await writePairFanout([makeRecord()]);
    const item =
      send.mock.calls[0][0].input.RequestItems["test-news-by-pair"][0].PutRequest.Item;
    expect(item.ttl).toBe(now + 86400 * 30);
  });

  it("retries on UnprocessedItems and succeeds on second attempt", async () => {
    // Attempt 1 returns one unprocessed item; attempt 2 clears it.
    const unprocessedItem = {
      PutRequest: {
        Item: { pair: "BTC", sk: "2026-05-08T10:00:00.000Z#art-001" },
      },
    };
    send
      .mockResolvedValueOnce({ UnprocessedItems: { "test-news-by-pair": [unprocessedItem] } })
      .mockResolvedValueOnce({});

    const { writePairFanout } = await import("./news-by-pair-store.js");

    // Run the fanout — need to advance timers for the backoff sleep.
    const promise = writePairFanout([makeRecord()]);
    await vi.runAllTimersAsync();
    await promise;

    expect(send).toHaveBeenCalledTimes(2);
    // Second call should contain only the one unprocessed item.
    const secondCall = send.mock.calls[1][0].input.RequestItems["test-news-by-pair"];
    expect(secondCall).toEqual([unprocessedItem]);
  });

  it("throws after 5 failed attempts when items remain unprocessed", async () => {
    const unprocessedItem = {
      PutRequest: {
        Item: { pair: "BTC", sk: "2026-05-08T10:00:00.000Z#art-001" },
      },
    };
    // All 5 attempts return the item as unprocessed.
    send.mockResolvedValue({ UnprocessedItems: { "test-news-by-pair": [unprocessedItem] } });

    const { writePairFanout } = await import("./news-by-pair-store.js");

    // Catch the rejection immediately so it's never unhandled.
    let caughtError: Error | undefined;
    const promise = writePairFanout([makeRecord()]).catch((e: Error) => {
      caughtError = e;
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError?.message).toBe(
      "BatchWrite failed: 1 items remain unprocessed after 5 attempts",
    );
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("stores nulled duplicateOf as null (not undefined)", async () => {
    send.mockResolvedValue({});
    const { writePairFanout } = await import("./news-by-pair-store.js");
    await writePairFanout([makeRecord({ duplicateOf: null } as any)]);
    const item =
      send.mock.calls[0][0].input.RequestItems["test-news-by-pair"][0].PutRequest.Item;
    expect(item.duplicateOf).toBeNull();
  });
});

describe("queryNewsByPair", () => {
  it("queries with correct key condition and returns typed results", async () => {
    send.mockResolvedValue({
      Items: [
        {
          articleId: "art-001",
          publishedAt: "2026-05-08T10:00:00.000Z",
          sentimentScore: 0.5,
          sentimentMagnitude: 0.9,
          duplicateOf: null,
        },
      ],
    });
    const { queryNewsByPair } = await import("./news-by-pair-store.js");
    const results = await queryNewsByPair("BTC", "2026-05-01T00:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0].articleId).toBe("art-001");
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("Query");
    expect(cmd.input.ExpressionAttributeValues).toMatchObject({
      ":pair": "BTC",
      ":since": "2026-05-01T00:00:00.000Z",
    });
  });

  it("paginates through all pages when LastEvaluatedKey is set", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            articleId: "art-001",
            publishedAt: "2026-05-08T10:00:00.000Z",
            sentimentScore: 0.5,
            sentimentMagnitude: 0.9,
            duplicateOf: null,
          },
        ],
        LastEvaluatedKey: { pair: "BTC", sk: "2026-05-08T10:00:00.000Z#art-001" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            articleId: "art-002",
            publishedAt: "2026-05-08T11:00:00.000Z",
            sentimentScore: -0.3,
            sentimentMagnitude: 0.6,
            duplicateOf: null,
          },
        ],
      });

    const { queryNewsByPair } = await import("./news-by-pair-store.js");
    const results = await queryNewsByPair("BTC", "2026-05-01T00:00:00.000Z");
    expect(results).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
    // Second call should pass ExclusiveStartKey from first response.
    const secondCmd = send.mock.calls[1][0];
    expect(secondCmd.input.ExclusiveStartKey).toEqual({
      pair: "BTC",
      sk: "2026-05-08T10:00:00.000Z#art-001",
    });
  });

  it("returns [] when DynamoDB returns no items", async () => {
    send.mockResolvedValue({});
    const { queryNewsByPair } = await import("./news-by-pair-store.js");
    const results = await queryNewsByPair("ETH", "2026-05-01T00:00:00.000Z");
    expect(results).toEqual([]);
  });
});
