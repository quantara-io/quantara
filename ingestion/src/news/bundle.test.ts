/**
 * Tests for news/bundle.ts
 *
 * Covers:
 * - buildSentimentBundle pair normalisation: full trading pair ("BTC/USDT") is
 *   split to bare-coin ("BTC") before calling recomputeSentimentAggregate.
 * - The returned SentimentBundle.pair keeps the caller's input value.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- SDK mocks (hoisted before any module import) ----

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

// mock recomputeSentimentAggregate so we can assert what pair it receives
const recomputeMock = vi.fn();
vi.mock("./aggregator.js", () => ({
  recomputeSentimentAggregate: recomputeMock,
  computeTrend24h: vi.fn().mockReturnValue(null),
}));

beforeEach(() => {
  vi.resetModules();
  ddbSendMock.mockReset();
  recomputeMock.mockReset();
});

const makeAggregate = (pair: string, window: string) => ({
  pair,
  window,
  computedAt: new Date().toISOString(),
  articleCount: 0,
  meanScore: null,
  meanMagnitude: null,
  fearGreedLatest: null,
  fearGreedTrend24h: null,
});

describe("buildSentimentBundle", () => {
  it("passes bare-coin to recomputeSentimentAggregate when given a full trading pair", async () => {
    recomputeMock.mockResolvedValue({
      aggregate: makeAggregate("BTC", "4h"),
      previousAggregate: null,
    });
    // Fear & Greed GetCommand
    ddbSendMock.mockResolvedValue({ Item: null });

    const { buildSentimentBundle } = await import("./bundle.js");
    await buildSentimentBundle("BTC/USDT");

    // recomputeSentimentAggregate must have been called with "BTC", not "BTC/USDT"
    expect(recomputeMock).toHaveBeenCalledTimes(2);
    expect(recomputeMock).toHaveBeenCalledWith("BTC", "4h");
    expect(recomputeMock).toHaveBeenCalledWith("BTC", "24h");
    expect(recomputeMock).not.toHaveBeenCalledWith("BTC/USDT", expect.anything());
  });

  it("returned SentimentBundle.pair keeps the caller's full trading pair", async () => {
    recomputeMock.mockResolvedValue({
      aggregate: makeAggregate("BTC", "4h"),
      previousAggregate: null,
    });
    ddbSendMock.mockResolvedValue({ Item: null });

    const { buildSentimentBundle } = await import("./bundle.js");
    const bundle = await buildSentimentBundle("BTC/USDT");

    expect(bundle.pair).toBe("BTC/USDT");
  });

  it("works correctly when pair is already a bare-coin (no slash)", async () => {
    recomputeMock.mockResolvedValue({
      aggregate: makeAggregate("ETH", "4h"),
      previousAggregate: null,
    });
    ddbSendMock.mockResolvedValue({ Item: null });

    const { buildSentimentBundle } = await import("./bundle.js");
    const bundle = await buildSentimentBundle("ETH");

    expect(recomputeMock).toHaveBeenCalledWith("ETH", "4h");
    expect(recomputeMock).toHaveBeenCalledWith("ETH", "24h");
    expect(bundle.pair).toBe("ETH");
  });
});
