import { describe, it, expect, vi, beforeEach } from "vitest";

import type { NewsRecord } from "./types.js";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
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
    currencies: [],
    rawSentiment: "neutral",
    status: "raw",
    ttl: Math.floor(Date.now() / 1000) + 86400,
  };
}

describe("storeNewsRecords", () => {
  it("returns 0 immediately when called with an empty list", async () => {
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords([]);
    expect(stored).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("skips records that already exist (Get returns Item)", async () => {
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") return { Item: { newsId: "exists" } };
      return {};
    });
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords([record("exists")]);
    expect(stored).toBe(0);
    // Only the Get; no BatchWrite when nothing is new.
    const cmds = send.mock.calls.map((c) => c[0].__cmd);
    expect(cmds).toEqual(["Get"]);
  });

  it("writes new records via BatchWrite and returns the new count", async () => {
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") return {}; // not found
      return {};
    });
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords([record("new-1"), record("new-2")]);
    expect(stored).toBe(2);
    const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
    expect(writes).toHaveLength(1);
    const items = writes[0][0].input.RequestItems["test-news-events"];
    expect(items).toHaveLength(2);
    expect(items[0].PutRequest.Item.newsId).toBe("new-1");
  });

  it("chunks BatchWrite calls into batches of 25", async () => {
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") return {};
      return {};
    });
    const records = Array.from({ length: 30 }, (_, i) => record(`r-${i}`));
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords(records);
    expect(stored).toBe(30);
    const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
    expect(writes).toHaveLength(2);
    expect(writes[0][0].input.RequestItems["test-news-events"]).toHaveLength(25);
    expect(writes[1][0].input.RequestItems["test-news-events"]).toHaveLength(5);
  });

  it("only writes the new subset when some records pre-exist", async () => {
    let i = 0;
    send.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") {
        // first record exists, second doesn't
        return i++ === 0 ? { Item: { newsId: "old" } } : {};
      }
      return {};
    });
    const { storeNewsRecords } = await import("./news-store.js");
    const stored = await storeNewsRecords([record("old"), record("new")]);
    expect(stored).toBe(1);
    const writes = send.mock.calls.filter((c) => c[0].__cmd === "BatchWrite");
    expect(writes[0][0].input.RequestItems["test-news-events"]).toHaveLength(1);
    expect(writes[0][0].input.RequestItems["test-news-events"][0].PutRequest.Item.newsId).toBe(
      "new",
    );
  });
});
