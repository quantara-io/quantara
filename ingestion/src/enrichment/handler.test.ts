/**
 * Tests for enrichment/handler.ts — Gap 4 (issue #115).
 *
 * Covers:
 *   - processNewsEventForInvalidation is called after enrichment completes
 *   - Invalidation errors are non-fatal (handler does not throw)
 *   - Skips enrichment when record not found
 *   - Skips enrichment when already enriched
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// AWS SDK mock
// ---------------------------------------------------------------------------

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: vi.fn().mockReturnValue({ send: sendMock }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  UpdateCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Update", input })),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const enrichNewsItemMock = vi.fn();
vi.mock("./bedrock.js", () => ({
  enrichNewsItem: enrichNewsItemMock,
}));

const enrichArticleMock = vi.fn();
vi.mock("../news/enrich.js", () => ({
  enrichArticle: enrichArticleMock,
}));

const publishMock = vi.fn();
vi.mock("../lib/sqs-publisher.js", () => ({
  publish: publishMock,
}));

const writePairFanoutMock = vi.fn();
vi.mock("../lib/news-by-pair-store.js", () => ({
  writePairFanout: writePairFanoutMock,
}));

const processNewsEventForInvalidationMock = vi.fn();
vi.mock("../news/invalidation.js", () => ({
  processNewsEventForInvalidation: processNewsEventForInvalidationMock,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const newsRecord = {
  newsId: "news-001",
  publishedAt: "2024-01-01T00:00:00.000Z",
  title: "BTC ETF approved",
  currencies: ["BTC"],
  status: "pending",
  source: "cryptopanic",
  url: "https://example.com/btc-etf",
};

const enrichmentResult = {
  sentiment: "positive",
  confidence: 0.9,
  entities: [],
  events: [],
};

const phase5aResult = {
  enrichedAt: "2024-01-01T00:01:00.000Z",
  mentionedPairs: ["BTC/USDT"],
  sentiment: { score: 0.8, magnitude: 0.9, model: "anthropic.claude-haiku-4-5" },
  duplicateOf: null,
  embeddingModel: "amazon.titan-embed-text-v1",
};

function makeSqsEvent(
  newsId = "news-001",
  publishedAt = "2024-01-01T00:00:00.000Z",
  extra?: Record<string, unknown>,
) {
  return {
    Records: [
      {
        body: JSON.stringify({ data: { newsId, publishedAt }, ...extra }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  enrichNewsItemMock.mockReset();
  enrichArticleMock.mockReset();
  publishMock.mockReset();
  writePairFanoutMock.mockReset();
  processNewsEventForInvalidationMock.mockReset();

  // DDB GetCommand: return the news record by default
  sendMock.mockImplementation((cmd: { __cmd: string }) => {
    if (cmd.__cmd === "Get") {
      return Promise.resolve({ Item: { ...newsRecord } });
    }
    return Promise.resolve({});
  });

  enrichNewsItemMock.mockResolvedValue(enrichmentResult);
  enrichArticleMock.mockResolvedValue(phase5aResult);
  publishMock.mockResolvedValue(undefined);
  writePairFanoutMock.mockResolvedValue(undefined);
  processNewsEventForInvalidationMock.mockResolvedValue({
    triggered: false,
    pairsInvalidated: [],
    signalsInvalidated: 0,
  });
});

async function loadHandler() {
  return (await import("./handler.js")).handler;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enrichment/handler — Gap 4: invalidation wiring", () => {
  it("calls processNewsEventForInvalidation after enrichment completes", async () => {
    const handler = await loadHandler();
    await handler(makeSqsEvent() as any, {} as any);

    expect(processNewsEventForInvalidationMock).toHaveBeenCalledOnce();
    const [calledEvent] = processNewsEventForInvalidationMock.mock.calls[0];
    expect(calledEvent.newsId).toBe("news-001");
    expect(calledEvent.title).toBe("BTC ETF approved");
    expect(calledEvent.mentionedPairs).toEqual(["BTC/USDT"]);
    expect(calledEvent.sentiment).toEqual(phase5aResult.sentiment);
    expect(calledEvent.duplicateOf).toBeNull();
  });

  it("does not throw when processNewsEventForInvalidation fails (non-fatal)", async () => {
    processNewsEventForInvalidationMock.mockRejectedValue(new Error("DDB error"));

    const handler = await loadHandler();
    // Should not throw — invalidation is best-effort
    await expect(handler(makeSqsEvent() as any, {} as any)).resolves.toBeUndefined();
  });

  it("skips processing when news record is not found", async () => {
    sendMock.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    const handler = await loadHandler();
    await handler(makeSqsEvent() as any, {} as any);

    expect(enrichNewsItemMock).not.toHaveBeenCalled();
    expect(processNewsEventForInvalidationMock).not.toHaveBeenCalled();
  });

  it("skips processing when news record is already enriched", async () => {
    sendMock.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") {
        return Promise.resolve({ Item: { ...newsRecord, status: "enriched" } });
      }
      return Promise.resolve({});
    });

    const handler = await loadHandler();
    await handler(makeSqsEvent() as any, {} as any);

    expect(enrichNewsItemMock).not.toHaveBeenCalled();
    expect(processNewsEventForInvalidationMock).not.toHaveBeenCalled();
  });

  it("logs invalidation result when triggered", async () => {
    processNewsEventForInvalidationMock.mockResolvedValue({
      triggered: true,
      pairsInvalidated: ["BTC/USDT"],
      signalsInvalidated: 1,
    });

    const handler = await loadHandler();
    // Should complete without error even when invalidation triggers
    await expect(handler(makeSqsEvent() as any, {} as any)).resolves.toBeUndefined();
    expect(processNewsEventForInvalidationMock).toHaveBeenCalledOnce();
  });

  it("re-enriches an already-enriched row when force=true is set in the SQS message", async () => {
    // Simulate a record that is already enriched
    sendMock.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") {
        return Promise.resolve({ Item: { ...newsRecord, status: "enriched" } });
      }
      return Promise.resolve({});
    });

    const handler = await loadHandler();
    await handler(
      makeSqsEvent("news-001", "2024-01-01T00:00:00.000Z", { force: true }) as any,
      {} as any,
    );

    // Both enrichment phases must have been called despite the pre-existing enriched status
    expect(enrichNewsItemMock).toHaveBeenCalledOnce();
    expect(enrichArticleMock).toHaveBeenCalledOnce();
    expect(publishMock).toHaveBeenCalledOnce();
  });

  it("skips an already-enriched row when force is absent (at-least-once regression guard)", async () => {
    // Simulate a record that is already enriched and no force field in message
    sendMock.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") {
        return Promise.resolve({ Item: { ...newsRecord, status: "enriched" } });
      }
      return Promise.resolve({});
    });

    const handler = await loadHandler();
    await handler(makeSqsEvent() as any, {} as any);

    // Default behavior: skip on enriched status
    expect(enrichNewsItemMock).not.toHaveBeenCalled();
    expect(enrichArticleMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });
});
