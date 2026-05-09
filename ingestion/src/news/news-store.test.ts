import { describe, it, expect, vi, beforeEach } from "vitest";

import type { NewsRecord } from "./types.js";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  BatchWriteCommand: vi.fn().mockImplementation((input) => ({ __cmd: "BatchWrite", input })),
}));

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_NEWS_EVENTS = "test-news-events";
});

function record(id: string): NewsRecord {
  return {
    newsId: id,
    source: "test",
    title: `t-${id}`,
    url: "https://example.com",
    publishedAt: "2026-04-25T00:00:00Z",
    publishedDay: "2026-04-25",
    currencies: [],
    rawSentiment: "neutral",
    status: "raw",
    ttl: Math.floor(Date.now() / 1000) + 86400,
  };
}

describe("storeNewsRecords", () => {
  it("returns [] immediately when called with an empty list", async () => {
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords([]);
    expect(stored).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("skips records that already exist (Query returns Count > 0)", async () => {
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") return { Count: 1, Items: [{ newsId: "exists" }] };
      return {};
    });
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords([record("exists")]);
    expect(stored).toEqual([]);
    // Only the Query; no BatchWrite when nothing is new.
    const cmds = send.mock.calls.map((c) => c[0].__cmd);
    expect(cmds).toEqual(["Query"]);
  });

  it("writes new records via BatchWrite and returns the new records", async () => {
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") return { Count: 0, Items: [] }; // not found
      return {};
    });
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords([record("new-1"), record("new-2")]);
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.newsId)).toEqual(["new-1", "new-2"]);
    const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
    expect(writes).toHaveLength(1);
    const items = writes[0][0].input.RequestItems["test-news-events"];
    expect(items).toHaveLength(2);
    expect(items[0].PutRequest.Item.newsId).toBe("new-1");
  });

  it("chunks BatchWrite calls into batches of 25", async () => {
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") return { Count: 0, Items: [] };
      return {};
    });
    const records = Array.from({ length: 30 }, (_, i) => record(`r-${i}`));
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords(records);
    expect(stored).toHaveLength(30);
    const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
    expect(writes).toHaveLength(2);
    expect(writes[0][0].input.RequestItems["test-news-events"]).toHaveLength(25);
    expect(writes[1][0].input.RequestItems["test-news-events"]).toHaveLength(5);
  });

  it("only writes the new subset when some records pre-exist", async () => {
    let i = 0;
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") {
        // first record exists, second doesn't
        return i++ === 0 ? { Count: 1, Items: [{ newsId: "old" }] } : { Count: 0, Items: [] };
      }
      return {};
    });
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords([record("old"), record("new")]);
    expect(stored).toHaveLength(1);
    expect(stored[0].newsId).toBe("new");
    const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
    expect(writes[0][0].input.RequestItems["test-news-events"]).toHaveLength(1);
    expect(writes[0][0].input.RequestItems["test-news-events"][0].PutRequest.Item.newsId).toBe(
      "new",
    );
  });

  // Acceptance-criteria tests: idempotency and correct distinct-item handling.
  describe("idempotency", () => {
    it("same item polled twice results in exactly 1 stored row", async () => {
      // Simulate two successive calls: first poll finds nothing (new), second
      // poll finds the item (already stored).
      let callCount = 0;
      send.mockImplementation(async (cmd: { __cmd: string }) => {
        if (cmd.__cmd === "Query") {
          // First poll: item does not exist yet.
          // Second poll: item already exists.
          return callCount++ === 0
            ? { Count: 0, Items: [] }
            : { Count: 1, Items: [{ newsId: "art-1" }] };
        }
        return {};
      });

      const { storeNewsRecords } = await import("./news-store.js");
      const r = record("art-1");

      // First poll: should write 1 row.
      const firstPoll = await storeNewsRecords([r]);
      expect(firstPoll).toHaveLength(1);

      // Second poll (same record): Get now returns Item → should write 0 rows.
      const secondPoll = await storeNewsRecords([r]);
      expect(secondPoll).toHaveLength(0);

      // Total BatchWrite calls: exactly 1 (only from first poll).
      const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
      expect(writes).toHaveLength(1);
    });

    it("two distinct items result in exactly 2 stored rows", async () => {
      send.mockImplementation(async (cmd: { __cmd: string }) => {
        if (cmd.__cmd === "Query") return { Count: 0, Items: [] }; // neither item exists yet
        return {};
      });

      const { storeNewsRecords } = await import("./news-store.js");
      const stored = await storeNewsRecords([record("art-a"), record("art-b")]);

      expect(stored).toHaveLength(2);
      expect(stored.map((r) => r.newsId).sort()).toEqual(["art-a", "art-b"]);

      const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
      expect(writes).toHaveLength(1);
      expect(writes[0][0].input.RequestItems["test-news-events"]).toHaveLength(2);
    });

    it("deduplicates an undated article polled across a 15-min bucket boundary", async () => {
      // This is the core fix for issue #179.  An undated article produces a
      // fresh `publishedAt = new Date().toISOString()` on every poll.  If
      // dedup were keyed on (newsId, publishedAt), the shifted timestamp after
      // crossing a bucket boundary would look like a new row.  With newsId-only
      // dedup (Query on the partition key), the second poll always finds the
      // existing row regardless of publishedAt.
      //
      // Simulate: first poll at T=14:59 (bucket A), second poll at T=15:01
      // (bucket B). The article has the same newsId but a different publishedAt.
      const firstPublishedAt = "2026-05-09T14:59:30.000Z";
      const secondPublishedAt = "2026-05-09T15:01:10.000Z"; // crossed boundary

      let queryCallCount = 0;
      send.mockImplementation(async (cmd: { __cmd: string }) => {
        if (cmd.__cmd === "Query") {
          // First poll: row doesn't exist yet. Second poll: row exists (newsId match).
          return queryCallCount++ === 0
            ? { Count: 0, Items: [] }
            : { Count: 1, Items: [{ newsId: "undated-art-1" }] };
        }
        return {};
      });

      const { storeNewsRecords } = await import("./news-store.js");

      // First poll: new article, should be written.
      const firstResult = await storeNewsRecords([
        { ...record("undated-art-1"), publishedAt: firstPublishedAt },
      ]);
      expect(firstResult).toHaveLength(1);

      // Second poll: same newsId, different publishedAt (bucket boundary crossed).
      // newsId-only dedup should recognise it as existing and skip.
      const secondResult = await storeNewsRecords([
        { ...record("undated-art-1"), publishedAt: secondPublishedAt },
      ]);
      expect(secondResult).toHaveLength(0);

      // Exactly 1 BatchWrite total — one row in DDB, not two.
      const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
      expect(writes).toHaveLength(1);
    });

    it("collapses repeated newsId within a single batch to one row", async () => {
      // Same article appearing twice in one poll batch: without the
      // per-call seenInBatch guard, both Query calls would return Count: 0
      // (DDB doesn't see uncommitted writes from this call), and BatchWrite
      // would persist two PutRequest items with the same newsId — either
      // creating two sort-key rows or rejecting the batch on duplicate
      // primary keys. Only the first occurrence should hit DDB.
      send.mockImplementation(async (cmd: { __cmd: string }) => {
        if (cmd.__cmd === "Query") return { Count: 0, Items: [] }; // not in DDB
        return {};
      });

      const { storeNewsRecords } = await import("./news-store.js");
      const stored = await storeNewsRecords([record("dup-art"), record("dup-art")]);

      // Only the first duplicate is returned.
      expect(stored).toHaveLength(1);
      expect(stored[0].newsId).toBe("dup-art");

      // Only one BatchWrite, with one PutRequest item.
      const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
      expect(writes).toHaveLength(1);
      const items = writes[0][0].input.RequestItems["test-news-events"];
      expect(items).toHaveLength(1);
      expect(items[0].PutRequest.Item.newsId).toBe("dup-art");

      // Only the FIRST occurrence triggers a Query — the second is short-
      // circuited by the seenInBatch guard before the DDB call.
      const queries = send.mock.calls.filter((c) => c[0].__cmd === "Query");
      expect(queries).toHaveLength(1);
    });
  });

  describe("UnprocessedItems retry", () => {
    it("retries unprocessed items and ultimately returns all records", async () => {
      let batchCallCount = 0;
      send.mockImplementation(async (cmd: { __cmd: string; input?: unknown }) => {
        if (cmd.__cmd === "Query") return { Count: 0, Items: [] }; // both items new
        if (cmd.__cmd === "BatchWrite") {
          batchCallCount += 1;
          if (batchCallCount === 1) {
            // First attempt: one of the two items is unprocessed.
            return {
              UnprocessedItems: {
                "test-news-events": [
                  {
                    PutRequest: {
                      Item: { newsId: "art-b", publishedAt: "2026-04-25T00:00:00Z" },
                    },
                  },
                ],
              },
            };
          }
          // Second attempt: succeeds.
          return {};
        }
        return {};
      });

      const { storeNewsRecords } = await import("./news-store.js");
      const stored = await storeNewsRecords([record("art-a"), record("art-b")]);

      expect(stored).toHaveLength(2);
      expect(stored.map((r) => r.newsId).sort()).toEqual(["art-a", "art-b"]);

      const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
      expect(writes).toHaveLength(2);
      // Retry only carries the still-pending item.
      const retryItems = writes[1][0].input.RequestItems["test-news-events"];
      expect(retryItems).toHaveLength(1);
      expect(retryItems[0].PutRequest.Item.newsId).toBe("art-b");
    });

    it("excludes records that remain unprocessed after max retries", async () => {
      send.mockImplementation(async (cmd: { __cmd: string }) => {
        if (cmd.__cmd === "Query") return { Count: 0, Items: [] };
        if (cmd.__cmd === "BatchWrite") {
          // Always returns the same item as unprocessed.
          return {
            UnprocessedItems: {
              "test-news-events": [
                {
                  PutRequest: {
                    Item: { newsId: "art-stuck", publishedAt: "2026-04-25T00:00:00Z" },
                  },
                },
              ],
            },
          };
        }
        return {};
      });

      const { storeNewsRecords } = await import("./news-store.js");
      const stored = await storeNewsRecords([record("art-stuck")]);

      // After exhausted retries, the persistent unprocessed record is dropped.
      expect(stored).toHaveLength(0);
      // Exhausted: 1 initial + 3 retry attempts = 4 BatchWrite calls.
      const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
      expect(writes).toHaveLength(4);
    });
  });
});
