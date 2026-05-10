/**
 * Tests for indicator-handler-shadow.ts — 1m/5m data-collection path (Issue #133).
 *
 * Key behaviors under test:
 *   - Only 1m and 5m candles are processed (15m+ are filtered out).
 *   - Only source=live is processed.
 *   - Quorum check works identically to the production handler.
 *   - Writes to signals-collection (NOT signals-v2).
 *   - NO call to ratifySignal (no LLM).
 *   - NO call to blendTimeframeVotes (single-TF only).
 *   - NO call to buildSentimentBundle (no LLM path).
 *   - Conditional-Put loss path is idempotent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DynamoDBStreamEvent } from "aws-lambda";
import type { TimeframeVote } from "@quantara/shared";

// ---------------------------------------------------------------------------
// AWS SDK mocks
// ---------------------------------------------------------------------------

const send = vi.fn();
class ConditionalCheckFailedException extends Error {
  constructor(_opts?: unknown) {
    super("ConditionalCheckFailedException");
    this.name = "ConditionalCheckFailedException";
  }
}

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
  ConditionalCheckFailedException,
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
  UpdateCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Update", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
}));

vi.mock("@aws-sdk/util-dynamodb", () => ({
  unmarshall: vi.fn().mockImplementation((img) => img),
}));

// ---------------------------------------------------------------------------
// Module mocks — indicator/scoring layers (NO blend, NO ratify, NO sentiment)
// ---------------------------------------------------------------------------

const getCandles = vi.fn();
vi.mock("./lib/candle-store.js", () => ({ getCandles }));

const canonicalizeCandleMock = vi.fn();
vi.mock("./lib/canonicalize.js", () => ({ canonicalizeCandle: canonicalizeCandleMock }));

const getLastFireBarsMock = vi.fn();
const tickCooldownsMock = vi.fn();
const recordRuleFiresMock = vi.fn();
vi.mock("./lib/cooldown-store.js", () => ({
  getLastFireBars: getLastFireBarsMock,
  tickCooldowns: tickCooldownsMock,
  recordRuleFires: recordRuleFiresMock,
}));

const putIndicatorStateMock = vi.fn();
vi.mock("./lib/indicator-state-store.js", () => ({
  putIndicatorState: putIndicatorStateMock,
}));

const buildIndicatorStateMock = vi.fn();
vi.mock("./indicators/index.js", () => ({
  buildIndicatorState: buildIndicatorStateMock,
}));

const scoreTimeframeMock = vi.fn();
vi.mock("./signals/score.js", () => ({
  scoreTimeframe: scoreTimeframeMock,
}));

const evaluateGatesMock = vi.fn();
const narrowPairMock = vi.fn();
vi.mock("./signals/gates.js", () => ({
  evaluateGates: evaluateGatesMock,
  narrowPair: narrowPairMock,
}));

// These should NEVER be called by the shadow handler.
// We declare them here so the assertion "never called" is explicit.
const blendTimeframeVotesMock = vi.fn();
vi.mock("./signals/blend.js", () => ({
  blendTimeframeVotes: blendTimeframeVotesMock,
  isTrivialChange: vi.fn(),
}));

const ratifySignalMock = vi.fn();
vi.mock("./llm/ratify.js", () => ({
  ratifySignal: ratifySignalMock,
}));

const buildSentimentBundleMock = vi.fn();
vi.mock("./news/bundle.js", () => ({
  buildSentimentBundle: buildSentimentBundleMock,
}));

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const TEST_CLOSE_TIME = 1715187600000;
const TEST_PAIR = "BTC/USDT";
const TEST_EXCHANGE = "binanceus";

function makeStreamEvent(overrides: Record<string, unknown> = {}): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventName: "INSERT",
        eventSource: "aws:dynamodb",
        eventVersion: "1.1",
        eventID: "abc123",
        awsRegion: "us-east-1",
        dynamodb: {
          NewImage: {
            pair: TEST_PAIR,
            exchange: TEST_EXCHANGE,
            timeframe: "1m",
            closeTime: TEST_CLOSE_TIME,
            openTime: TEST_CLOSE_TIME - 60 * 1000,
            open: 60000,
            high: 61000,
            low: 59500,
            close: 60500,
            volume: 100,
            symbol: "BTC/USDT",
            source: "live",
            ...overrides,
          },
          SequenceNumber: "1",
          SizeBytes: 100,
          StreamViewType: "NEW_IMAGE",
        },
        eventSourceARN: "arn:aws:dynamodb:us-east-1:123:table/test-candles/stream/x",
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

function makeCandle(overrides: Record<string, unknown> = {}) {
  return {
    exchange: TEST_EXCHANGE,
    symbol: "BTC/USDT",
    pair: TEST_PAIR,
    timeframe: "1m",
    openTime: TEST_CLOSE_TIME - 60 * 1000,
    closeTime: TEST_CLOSE_TIME,
    open: 60000,
    high: 61000,
    low: 59500,
    close: 60500,
    volume: 100,
    isClosed: true,
    source: "live",
    ...overrides,
  };
}

function makeVote(type: "buy" | "sell" | "hold" = "hold"): TimeframeVote {
  return {
    type,
    confidence: 0.65,
    rulesFired: ["rsi-oversold-strong"],
    bullishScore: 2,
    bearishScore: 0,
    volatilityFlag: false,
    gateReason: null,
    asOf: TEST_CLOSE_TIME,
  };
}

function makeIndicatorState() {
  return {
    pair: TEST_PAIR,
    exchange: "consensus",
    timeframe: "1m",
    asOf: TEST_CLOSE_TIME,
    barsSinceStart: 50,
    rsi14: 25,
    ema20: 60000,
    ema50: 59500,
    ema200: 58000,
    macdLine: 100,
    macdSignal: 90,
    macdHist: 10,
    atr14: 400,
    bbUpper: 61500,
    bbMid: 60000,
    bbLower: 58500,
    bbWidth: 0.05,
    obv: 500000,
    obvSlope: 200,
    vwap: 60100,
    volZ: 0.5,
    realizedVolAnnualized: 0.55,
    fearGreed: null, // shadow handler does not use Fear/Greed
    dispersion: 0.002,
    history: {
      rsi14: [25, 26],
      macdHist: [10, 8],
      ema20: [60000, 59900],
      ema50: [59500, 59400],
      close: [60500, 60400],
      volume: [100, 90],
    },
  };
}

// ---------------------------------------------------------------------------
// beforeEach — full reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  getCandles.mockReset();
  canonicalizeCandleMock.mockReset();
  getLastFireBarsMock.mockReset();
  tickCooldownsMock.mockReset();
  recordRuleFiresMock.mockReset();
  putIndicatorStateMock.mockReset();
  buildIndicatorStateMock.mockReset();
  scoreTimeframeMock.mockReset();
  blendTimeframeVotesMock.mockReset();
  evaluateGatesMock.mockReset();
  narrowPairMock.mockReset();
  ratifySignalMock.mockReset();
  buildSentimentBundleMock.mockReset();

  process.env.TABLE_CLOSE_QUORUM = "test-close-quorum";
  process.env.TABLE_SIGNALS_COLLECTION = "test-signals-collection";
  process.env.TABLE_METADATA = "test-metadata";
  process.env.REQUIRED_EXCHANGE_COUNT = "2";

  // Default send: quorum reached (2 exchanges), signals-collection has no item.
  send.mockImplementation((cmd) => {
    if (cmd.__cmd === "Update") return Promise.resolve({});
    if (cmd.__cmd === "Put") return Promise.resolve({});
    if (cmd.__cmd === "Query") return Promise.resolve({ Items: [] });
    if (cmd.__cmd === "Get") {
      if (cmd.input.TableName === "test-close-quorum") {
        return Promise.resolve({
          Item: {
            id: `${TEST_PAIR}#1m#${TEST_CLOSE_TIME}`,
            exchanges: new Set([TEST_EXCHANGE, "coinbase"]),
          },
        });
      }
      // signals-collection get returns no item (not yet processed)
      if (cmd.input.TableName === "test-signals-collection") {
        return Promise.resolve({ Item: undefined });
      }
      // metadata table
      return Promise.resolve({ Item: undefined });
    }
    return Promise.resolve({});
  });

  getCandles.mockResolvedValue([makeCandle()]);
  canonicalizeCandleMock.mockReturnValue({
    consensus: makeCandle({ exchange: "consensus" }),
    dispersion: 0.002,
  });
  getLastFireBarsMock.mockResolvedValue({});
  tickCooldownsMock.mockResolvedValue(undefined);
  recordRuleFiresMock.mockResolvedValue(undefined);
  putIndicatorStateMock.mockResolvedValue(undefined);
  buildIndicatorStateMock.mockReturnValue(makeIndicatorState());
  scoreTimeframeMock.mockReturnValue(makeVote("buy"));
  evaluateGatesMock.mockReturnValue({ fired: false, reason: null });
  narrowPairMock.mockImplementation((pair: string) => pair);
});

// ---------------------------------------------------------------------------
// Timeframe filtering — only 1m and 5m
// ---------------------------------------------------------------------------

describe("timeframe filtering", () => {
  it("processes 1m candles", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent({ timeframe: "1m" }), {} as any, () => {});

    const updates = send.mock.calls.filter((c) => c[0]?.__cmd === "Update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("processes 5m candles", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          return Promise.resolve({
            Item: { exchanges: new Set([TEST_EXCHANGE, "coinbase"]) },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (cmd.__cmd === "Put") return Promise.resolve({});
      return Promise.resolve({});
    });

    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent({ timeframe: "5m" }), {} as any, () => {});

    const updates = send.mock.calls.filter((c) => c[0]?.__cmd === "Update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("skips production timeframes: 15m, 1h, 4h, 1d", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");

    for (const tf of ["15m", "1h", "4h", "1d"]) {
      send.mockClear();
      await handler(makeStreamEvent({ timeframe: tf }), {} as any, () => {});
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("skips source=backfill", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent({ source: "backfill" }), {} as any, () => {});
    expect(send).not.toHaveBeenCalled();
  });

  it("skips REMOVE events", async () => {
    const event = makeStreamEvent();
    event.Records[0]!.eventName = "REMOVE";

    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(event, {} as any, () => {});
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No LLM — ratifySignal must never be called
// ---------------------------------------------------------------------------

describe("no LLM ratification", () => {
  it("never calls ratifySignal on the shadow path", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(ratifySignalMock).not.toHaveBeenCalled();
  });

  it("never calls buildSentimentBundle on the shadow path", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(buildSentimentBundleMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No blend — blendTimeframeVotes must never be called
// ---------------------------------------------------------------------------

describe("no multi-TF blending", () => {
  it("never calls blendTimeframeVotes on the shadow path", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(blendTimeframeVotesMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Writes to signals-collection, NOT signals-v2
// ---------------------------------------------------------------------------

describe("storage — writes to signals-collection table only", () => {
  it("writes the shadow signal to signals-collection", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const collectionPuts = send.mock.calls.filter(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-collection",
    );
    expect(collectionPuts.length).toBeGreaterThan(0);
  });

  it("never writes to signals-v2", async () => {
    process.env.TABLE_SIGNALS_V2 = "test-signals-v2";

    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const v2Puts = send.mock.calls.filter(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-v2",
    );
    expect(v2Puts.length).toBe(0);
  });

  it("writes source='shadow' field on the stored row", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const collectionPut = send.mock.calls.find(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-collection",
    );
    expect(collectionPut).toBeDefined();
    expect(collectionPut![0].input.Item.source).toBe("shadow");
  });

  it("uses deterministic SK = tf#closeTime", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent({ timeframe: "1m" }), {} as any, () => {});

    const collectionPut = send.mock.calls.find(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-collection",
    );
    expect(collectionPut).toBeDefined();
    expect(collectionPut![0].input.Item.sk).toBe(`1m#${TEST_CLOSE_TIME}`);
    expect(collectionPut![0].input.Item.pair).toBe(TEST_PAIR);
  });

  it("applies a 30d TTL on written rows", async () => {
    const before = Math.floor(Date.now() / 1000);

    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const after = Math.floor(Date.now() / 1000);
    const collectionPut = send.mock.calls.find(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-collection",
    );
    expect(collectionPut).toBeDefined();
    const ttl = collectionPut![0].input.Item.ttl as number;
    // TTL should be in [before + 30d, after + 30d]
    expect(ttl).toBeGreaterThanOrEqual(before + 86400 * 30);
    expect(ttl).toBeLessThanOrEqual(after + 86400 * 30);
  });

  it("uses attribute_not_exists(pair) as ConditionExpression", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const collectionPut = send.mock.calls.find(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-collection",
    );
    expect(collectionPut).toBeDefined();
    expect(collectionPut![0].input.ConditionExpression).toBe("attribute_not_exists(pair)");
  });
});

// ---------------------------------------------------------------------------
// Quorum check — mirrors production behavior
// ---------------------------------------------------------------------------

describe("quorum check", () => {
  it("returns early when quorum not reached", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get" && cmd.input.TableName === "test-close-quorum") {
        return Promise.resolve({
          Item: { exchanges: new Set([TEST_EXCHANGE]) }, // only 1 exchange
        });
      }
      return Promise.resolve({ Item: undefined });
    });

    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(getCandles).not.toHaveBeenCalled();
    expect(buildIndicatorStateMock).not.toHaveBeenCalled();
  });

  it("proceeds when quorum is reached (2 exchanges)", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(getCandles).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dedup — signals-collection existence check
// ---------------------------------------------------------------------------

describe("dedup — signals-collection existence check", () => {
  it("skips computation when signals-collection row already exists", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          return Promise.resolve({
            Item: { exchanges: new Set([TEST_EXCHANGE, "coinbase"]) },
          });
        }
        if (cmd.input.TableName === "test-signals-collection") {
          // Row already exists
          return Promise.resolve({
            Item: { pair: TEST_PAIR, sk: `1m#${TEST_CLOSE_TIME}` },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });

    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(getCandles).not.toHaveBeenCalled();
    expect(buildIndicatorStateMock).not.toHaveBeenCalled();
  });

  it("swallows ConditionalCheckFailedException (concurrent handler won race)", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          return Promise.resolve({
            Item: { exchanges: new Set([TEST_EXCHANGE, "coinbase"]) },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (cmd.__cmd === "Put" && cmd.input.TableName === "test-signals-collection") {
        return Promise.reject(new ConditionalCheckFailedException());
      }
      if (cmd.__cmd === "Put") return Promise.resolve({});
      return Promise.resolve({});
    });

    const { handler } = await import("./indicator-handler-shadow.js");
    // Must not throw
    await expect(handler(makeStreamEvent(), {} as any, () => {})).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Indicator computation does run (scoreTimeframe is called)
// ---------------------------------------------------------------------------

describe("indicator computation", () => {
  it("calls buildIndicatorState and scoreTimeframe", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(buildIndicatorStateMock).toHaveBeenCalled();
    expect(scoreTimeframeMock).toHaveBeenCalled();
  });

  it("does not write signals-collection when scoreTimeframe returns null", async () => {
    scoreTimeframeMock.mockReturnValue(null);

    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const collectionPuts = send.mock.calls.filter(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-collection",
    );
    expect(collectionPuts.length).toBe(0);
  });

  it("passes fearGreed=null to buildIndicatorState (no daily FG poll on shadow path)", async () => {
    const { handler } = await import("./indicator-handler-shadow.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(buildIndicatorStateMock).toHaveBeenCalled();
    const callArgs = buildIndicatorStateMock.mock.calls[0];
    // Second argument is the options object with fearGreed field.
    const opts = callArgs?.[1] as { fearGreed: unknown };
    expect(opts?.fearGreed).toBeNull();
  });
});
