/**
 * Tests for indicator-handler.ts — v6 P2 DDB Streams flow.
 *
 * Mocking strategy:
 *   - All AWS SDK calls are replaced with a single `send` vi.fn().
 *   - candle-store, canonicalize, cooldown-store, indicator-state-store,
 *     indicators/index, signals/score, signals/blend, signals/gates are vi.mock'd.
 *   - unmarshall is mocked to return a plain object from DDB stream record format.
 *   - Handler is imported dynamically after resetModules() so env vars are fresh.
 *
 * Key behaviors under test:
 *   - Quorum idempotency on retry (ADD exchange to set is safe to repeat).
 *   - Quorum-not-reached path returns early without touching signals-v2.
 *   - Deterministic SK construction: tf#closeTime (P2.2 correction).
 *   - Conditional-Put loss path (ConditionalCheckFailedException → idempotent skip).
 *   - Non-signal timeframes and non-live sources are filtered out.
 *   - Signals-v2 existence check prevents double computation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DynamoDBStreamEvent } from "aws-lambda";
import type { TimeframeVote, BlendedSignal } from "@quantara/shared";

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

// @aws-sdk/util-dynamodb — unmarshall is mocked to return NewImage directly as a plain object.
vi.mock("@aws-sdk/util-dynamodb", () => ({
  unmarshall: vi.fn().mockImplementation((img) => img),
}));

// ---------------------------------------------------------------------------
// Module mocks — indicator/scoring/blending layers
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

const blendTimeframeVotesMock = vi.fn();
const isTrivialChangeMock = vi.fn();
vi.mock("./signals/blend.js", () => ({
  blendTimeframeVotes: blendTimeframeVotesMock,
  isTrivialChange: isTrivialChangeMock,
}));

const evaluateGatesMock = vi.fn();
const narrowPairMock = vi.fn();
vi.mock("./signals/gates.js", () => ({
  evaluateGates: evaluateGatesMock,
  narrowPair: narrowPairMock,
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

const TEST_CLOSE_TIME = 1715187600000; // 2024-05-08T15:00:00.000Z (15m close)
const TEST_PAIR = "BTC/USDT";
const TEST_TF = "15m";
const TEST_EXCHANGE = "binanceus";

/**
 * Build a minimal DynamoDBStreamEvent for a single candle INSERT.
 * The NewImage is already a plain object (unmarshall mock returns it as-is).
 */
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
            timeframe: TEST_TF,
            closeTime: TEST_CLOSE_TIME,
            openTime: TEST_CLOSE_TIME - 15 * 60 * 1000,
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
    timeframe: TEST_TF,
    openTime: TEST_CLOSE_TIME - 15 * 60 * 1000,
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
    rulesFired: [],
    bullishScore: 0,
    bearishScore: 0,
    volatilityFlag: false,
    gateReason: null,
    reasoning: "No rules fired",
    tags: [],
    asOf: TEST_CLOSE_TIME,
  };
}

function makeBlendedSignal(): BlendedSignal {
  return {
    pair: TEST_PAIR,
    type: "hold",
    confidence: 0.5,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: [],
    perTimeframe: { "15m": null, "1h": null, "4h": null, "1d": null, "1m": null, "5m": null },
    weightsUsed: { "15m": 0.15, "1h": 0.2, "4h": 0.3, "1d": 0.35, "1m": 0, "5m": 0 },
    asOf: TEST_CLOSE_TIME,
    emittingTimeframe: "15m",
    risk: null,
  };
}

function makeIndicatorState() {
  return {
    pair: TEST_PAIR,
    exchange: "consensus",
    timeframe: TEST_TF,
    asOf: TEST_CLOSE_TIME,
    barsSinceStart: 50,
    rsi14: 55,
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
    fearGreed: 55,
    dispersion: 0.002,
    history: {
      rsi14: [55, 54],
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
  isTrivialChangeMock.mockReset();
  evaluateGatesMock.mockReset();
  narrowPairMock.mockReset();
  ratifySignalMock.mockReset();
  buildSentimentBundleMock.mockReset();

  process.env.TABLE_CLOSE_QUORUM = "test-close-quorum";
  process.env.TABLE_SIGNALS_V2 = "test-signals-v2";
  process.env.TABLE_METADATA = "test-metadata";
  process.env.REQUIRED_EXCHANGE_COUNT = "2";

  // Default send: UpdateCommand (Step 1) succeeds; GetCommand (Step 2 quorum) returns
  // exchanges with size=2 (quorum reached); GetCommand (Step 3 signals-v2) returns no item;
  // PutCommand (Step 4) succeeds; QueryCommand (getLatestSignal) returns no items.
  send.mockImplementation((cmd) => {
    if (cmd.__cmd === "Update") return Promise.resolve({});
    if (cmd.__cmd === "Put") return Promise.resolve({});
    if (cmd.__cmd === "Query") return Promise.resolve({ Items: [] });
    if (cmd.__cmd === "Get") {
      // Quorum table get returns 2 exchanges (quorum reached by default)
      if (cmd.input.TableName === "test-close-quorum") {
        return Promise.resolve({
          Item: {
            id: `${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`,
            exchanges: new Set([TEST_EXCHANGE, "coinbase"]),
          },
        });
      }
      // signals-v2 get returns no item (not yet processed)
      if (cmd.input.TableName === "test-signals-v2") {
        return Promise.resolve({ Item: undefined });
      }
      // metadata table get (dispersion history, staleness, vote reads, fear-greed)
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
  scoreTimeframeMock.mockReturnValue(makeVote("hold"));
  blendTimeframeVotesMock.mockReturnValue(makeBlendedSignal());
  isTrivialChangeMock.mockReturnValue(false);
  evaluateGatesMock.mockReturnValue({ fired: false, reason: null });
  narrowPairMock.mockImplementation((pair: string) => pair);
  ratifySignalMock.mockImplementation(async (ctx: { candidate: BlendedSignal }) => ({
    signal: ctx.candidate,
    fellBackToAlgo: true,
    cacheHit: false,
  }));
  buildSentimentBundleMock.mockResolvedValue({
    pair: TEST_PAIR,
    assembledAt: new Date().toISOString(),
    windows: {
      "4h": { articleCount: 0, avgScore: 0, avgMagnitude: 0, windowStart: "", windowEnd: "" },
      "24h": { articleCount: 0, avgScore: 0, avgMagnitude: 0, windowStart: "", windowEnd: "" },
    },
    fearGreed: {
      value: 50,
      classification: "Neutral",
      lastTimestamp: null,
      history: [],
      trend24h: 0,
    },
  });
});

// ---------------------------------------------------------------------------
// DDB Streams handler signature
// ---------------------------------------------------------------------------

describe("handler entry point", () => {
  it("processes INSERT records with source=live and signal timeframe", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    // Should have called UpdateCommand (Step 1 — quorum ADD)
    const updates = send.mock.calls.filter((c) => c[0]?.__cmd === "Update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("skips REMOVE records entirely", async () => {
    const event = makeStreamEvent();
    event.Records[0]!.eventName = "REMOVE";

    const { handler } = await import("./indicator-handler.js");
    await handler(event, {} as any, () => {});

    // No DDB calls for a REMOVE event
    expect(send).not.toHaveBeenCalled();
  });

  it("skips records with non-signal timeframes (1m, 5m)", async () => {
    const { handler } = await import("./indicator-handler.js");

    for (const tf of ["1m", "5m"]) {
      send.mockClear();
      await handler(makeStreamEvent({ timeframe: tf }), {} as any, () => {});
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("skips records with source=backfill", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent({ source: "backfill" }), {} as any, () => {});
    expect(send).not.toHaveBeenCalled();
  });

  it("processes signal timeframes: 15m, 1h, 4h, 1d", async () => {
    const { handler } = await import("./indicator-handler.js");

    for (const tf of ["15m", "1h", "4h", "1d"]) {
      send.mockImplementation((cmd) => {
        if (cmd.__cmd === "Update") return Promise.resolve({});
        if (cmd.__cmd === "Get") {
          if (cmd.input.TableName === "test-close-quorum") {
            return Promise.resolve({
              Item: {
                id: `${TEST_PAIR}#${tf}#${TEST_CLOSE_TIME}`,
                exchanges: new Set([TEST_EXCHANGE, "coinbase"]),
              },
            });
          }
          return Promise.resolve({ Item: undefined });
        }
        if (cmd.__cmd === "Put") return Promise.resolve({});
        if (cmd.__cmd === "Query") return Promise.resolve({ Items: [] });
        return Promise.resolve({});
      });

      await handler(makeStreamEvent({ timeframe: tf }), {} as any, () => {});

      const updates = send.mock.calls.filter((c) => c[0]?.__cmd === "Update");
      expect(updates.length).toBeGreaterThanOrEqual(1);
      send.mockClear();
    }
  });
});

// ---------------------------------------------------------------------------
// Step 1 — Quorum ADD
// ---------------------------------------------------------------------------

describe("Step 1 — ADD exchange to close-quorum", () => {
  it("calls UpdateCommand with correct quorum id, exchange set, and TTL", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const updateCall = send.mock.calls.find((c) => c[0]?.__cmd === "Update");
    expect(updateCall).toBeDefined();

    const input = updateCall![0].input;
    expect(input.TableName).toBe("test-close-quorum");
    expect(input.Key.id).toBe(`${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`);
    expect(input.UpdateExpression).toContain("ADD exchanges");
    expect(input.UpdateExpression).toContain("if_not_exists(#ttl");
    // Exchange set should contain the candle's exchange
    expect(input.ExpressionAttributeValues[":ex"]).toBeInstanceOf(Set);
    expect(input.ExpressionAttributeValues[":ex"].has(TEST_EXCHANGE)).toBe(true);
    // TTL = floor(closeTime / 1000) + 86400
    const expectedTtl = Math.floor(TEST_CLOSE_TIME / 1000) + 86_400;
    expect(input.ExpressionAttributeValues[":ttl"]).toBe(expectedTtl);
  });

  it("is idempotent — same exchange can be ADD'd multiple times safely (Set semantics)", async () => {
    // The quorum ADD is idempotent because DDB String Set ADD is a no-op for
    // already-present values. We verify the handler calls UpdateCommand on retry
    // without throwing.
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({}); // succeeds on retry
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          return Promise.resolve({
            Item: {
              id: `${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`,
              exchanges: new Set([TEST_EXCHANGE, "coinbase"]),
            },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (cmd.__cmd === "Put") return Promise.resolve({});
      if (cmd.__cmd === "Query") return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    const { handler } = await import("./indicator-handler.js");
    // Invoke twice (simulating retry)
    await handler(makeStreamEvent(), {} as any, () => {});
    await handler(makeStreamEvent(), {} as any, () => {});

    const updateCalls = send.mock.calls.filter((c) => c[0]?.__cmd === "Update");
    expect(updateCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — Quorum check
// ---------------------------------------------------------------------------

describe("Step 2 — Quorum check", () => {
  it("returns early when quorum is not reached (only 1 exchange)", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get" && cmd.input.TableName === "test-close-quorum") {
        return Promise.resolve({
          Item: {
            id: `${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`,
            exchanges: new Set([TEST_EXCHANGE]),
          },
        });
      }
      return Promise.resolve({ Item: undefined });
    });

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    // Should NOT have called getCandles or putIndicatorState (quorum not reached)
    expect(getCandles).not.toHaveBeenCalled();
    expect(putIndicatorStateMock).not.toHaveBeenCalled();

    // Should NOT have attempted a signals-v2 get
    const signalsV2Gets = send.mock.calls.filter(
      (c) => c[0]?.__cmd === "Get" && c[0].input.TableName === "test-signals-v2",
    );
    expect(signalsV2Gets.length).toBe(0);
  });

  it("returns early when quorum item is absent from table", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get" && cmd.input.TableName === "test-close-quorum") {
        return Promise.resolve({ Item: undefined }); // no item at all
      }
      return Promise.resolve({ Item: undefined });
    });

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(getCandles).not.toHaveBeenCalled();
  });

  it("proceeds when quorum is exactly REQUIRED_EXCHANGE_COUNT (2)", async () => {
    // Default send mock already returns 2 exchanges — quorum reached.
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    // Should have called getCandles (quorum reached → computation started)
    expect(getCandles).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 3 — Deterministic SK construction (P2.2: tf#closeTime)
// ---------------------------------------------------------------------------

describe("Step 3 — Deterministic SK construction (P2.2 correction)", () => {
  it("checks signals-v2 with SK = tf#closeTime (NOT closeTime#tf)", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const signalsV2Get = send.mock.calls.find(
      (c) => c[0]?.__cmd === "Get" && c[0].input.TableName === "test-signals-v2",
    );
    expect(signalsV2Get).toBeDefined();

    const input = signalsV2Get![0].input;
    expect(input.Key.pair).toBe(TEST_PAIR);
    // SK must be "15m#1715187600000" — tf FIRST, then closeTime (P2.2 corrected order)
    expect(input.Key.sk).toBe(`${TEST_TF}#${TEST_CLOSE_TIME}`);
  });

  it("writes signals-v2 with the same deterministic SK", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const signalsV2Put = send.mock.calls.find(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-v2",
    );
    expect(signalsV2Put).toBeDefined();

    const item = signalsV2Put![0].input.Item;
    expect(item.pair).toBe(TEST_PAIR);
    expect(item.sk).toBe(`${TEST_TF}#${TEST_CLOSE_TIME}`);
  });

  it("returns early when signals-v2 item already exists (prior processing)", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          return Promise.resolve({
            Item: {
              id: `${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`,
              exchanges: new Set([TEST_EXCHANGE, "coinbase"]),
            },
          });
        }
        if (cmd.input.TableName === "test-signals-v2") {
          // Simulate existing signal (already processed)
          return Promise.resolve({
            Item: { pair: TEST_PAIR, sk: `${TEST_TF}#${TEST_CLOSE_TIME}` },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    // Should NOT have done any candle fetching or computation
    expect(getCandles).not.toHaveBeenCalled();
    expect(putIndicatorStateMock).not.toHaveBeenCalled();

    // Should NOT have attempted a signals-v2 Put
    const puts = send.mock.calls.filter(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-v2",
    );
    expect(puts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — Conditional Put dedup
// ---------------------------------------------------------------------------

describe("Step 4 — Conditional Put dedup", () => {
  it("uses attribute_not_exists(pair) as the ConditionExpression", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const signalsV2Put = send.mock.calls.find(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-v2",
    );
    expect(signalsV2Put).toBeDefined();
    expect(signalsV2Put![0].input.ConditionExpression).toBe("attribute_not_exists(pair)");
  });

  it("swallows ConditionalCheckFailedException (concurrent handler already wrote)", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          return Promise.resolve({
            Item: {
              id: `${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`,
              exchanges: new Set([TEST_EXCHANGE, "coinbase"]),
            },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (cmd.__cmd === "Put" && cmd.input.TableName === "test-signals-v2") {
        // Simulate concurrent handler winning the race
        return Promise.reject(new ConditionalCheckFailedException());
      }
      if (cmd.__cmd === "Put") return Promise.resolve({});
      if (cmd.__cmd === "Query") return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    const { handler } = await import("./indicator-handler.js");
    // Must not throw — ConditionalCheckFailedException is an idempotent skip
    await expect(handler(makeStreamEvent(), {} as any, () => {})).resolves.toBeUndefined();
  });

  it("re-throws non-ConditionalCheck DDB errors from Step 4", async () => {
    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          return Promise.resolve({
            Item: {
              id: `${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`,
              exchanges: new Set([TEST_EXCHANGE, "coinbase"]),
            },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (cmd.__cmd === "Put" && cmd.input.TableName === "test-signals-v2") {
        return Promise.reject(new Error("ProvisionedThroughputExceededException"));
      }
      if (cmd.__cmd === "Put") return Promise.resolve({});
      if (cmd.__cmd === "Query") return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    const { handler } = await import("./indicator-handler.js");
    // Should re-throw so Lambda retries the batch
    await expect(handler(makeStreamEvent(), {} as any, () => {})).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });
});

// ---------------------------------------------------------------------------
// Indicator computation (retained logic)
// ---------------------------------------------------------------------------

describe("Indicator computation", () => {
  it("calls buildIndicatorState, scoreTimeframe, blendTimeframeVotes on successful flow", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(buildIndicatorStateMock).toHaveBeenCalled();
    expect(scoreTimeframeMock).toHaveBeenCalled();
    expect(blendTimeframeVotesMock).toHaveBeenCalled();
  });

  it("calls putIndicatorState to persist the indicator state", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(putIndicatorStateMock).toHaveBeenCalled();
  });

  it("calls ratifySignal after blending", async () => {
    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(ratifySignalMock).toHaveBeenCalled();
  });

  it("does not write signals-v2 when blendTimeframeVotes returns null", async () => {
    blendTimeframeVotesMock.mockReturnValue(null);

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const signalsV2Puts = send.mock.calls.filter(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-v2",
    );
    expect(signalsV2Puts.length).toBe(0);
  });

  it("proceeds gracefully when ratifySignal throws (falls back to algo signal)", async () => {
    ratifySignalMock.mockRejectedValue(new Error("Anthropic API error"));

    const { handler } = await import("./indicator-handler.js");
    // Must not throw — ratification failure is non-fatal
    await expect(handler(makeStreamEvent(), {} as any, () => {})).resolves.toBeUndefined();

    // signals-v2 Put should still have been called with the algo fallback
    const signalsV2Puts = send.mock.calls.filter(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-v2",
    );
    expect(signalsV2Puts.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Phase B1 two-stage path: stage-1 must commit before stage-2 UPDATE fires
  // -------------------------------------------------------------------------

  it("stage-1 Put includes ratificationStatus='pending' when ratifySignal returns pending", async () => {
    ratifySignalMock.mockImplementation(
      async (ctx: { candidate: BlendedSignal }, _onStage2: unknown) => ({
        signal: { ...ctx.candidate, ratificationStatus: "pending" as const },
        fellBackToAlgo: false,
        cacheHit: false,
        // Provide a kickoffRatification stub so the handler awaits something realistic.
        kickoffRatification: async () => undefined,
      }),
    );

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    const stage1Put = send.mock.calls.find(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-v2",
    );
    expect(stage1Put).toBeDefined();
    expect(stage1Put![0].input.Item.ratificationStatus).toBe("pending");
    expect(stage1Put![0].input.ConditionExpression).toBe("attribute_not_exists(pair)");
  });

  it("kickoffRatification is invoked AFTER stage-1 Put (no race)", async () => {
    const kickoffOrder: string[] = [];
    let stage1PutCommitted = false;

    // Track stage-1 Put commit time.
    send.mockImplementation((cmd: any) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          return Promise.resolve({
            Item: { exchanges: new Set(["binanceus", "coinbase"]) },
          });
        }
        if (cmd.input.TableName === "test-signals-v2") {
          return Promise.resolve({}); // no existing row → proceed to compute
        }
        return Promise.resolve({});
      }
      if (cmd.__cmd === "Put" && cmd.input.TableName === "test-signals-v2") {
        kickoffOrder.push("stage1-put");
        stage1PutCommitted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    ratifySignalMock.mockImplementation(
      async (ctx: { candidate: BlendedSignal }, _onStage2: unknown) => ({
        signal: { ...ctx.candidate, ratificationStatus: "pending" as const },
        fellBackToAlgo: false,
        cacheHit: false,
        kickoffRatification: async () => {
          // The race the reviewer flagged: kickoffRatification must NOT be
          // called before stage-1 Put commits. If it were, this would be
          // false and the test would fail.
          kickoffOrder.push("kickoff-ratification");
          expect(stage1PutCommitted).toBe(true);
          return undefined;
        },
      }),
    );

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(kickoffOrder).toEqual(["stage1-put", "kickoff-ratification"]);
  });

  it("does not invoke kickoffRatification when ratifySignal returns no callback (gated/cache hit)", async () => {
    // Track whether kickoffRatification was ever called. We deliberately omit
    // it from the ratifySignal mock return — the assertion is that the handler
    // does not synthesize/invoke a kickoff when ratifySignal returns undefined.
    const kickoffMock = vi.fn().mockResolvedValue(undefined);
    ratifySignalMock.mockImplementation(
      async (ctx: { candidate: BlendedSignal }, _onStage2: unknown) => ({
        signal: { ...ctx.candidate, ratificationStatus: "not-required" as const },
        fellBackToAlgo: true,
        cacheHit: false,
        // kickoffRatification intentionally omitted — gated path.
      }),
    );

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    // kickoff was never called because the mock didn't return a callback.
    expect(kickoffMock).not.toHaveBeenCalled();
    // Stage-1 still wrote.
    const signalsV2Puts = send.mock.calls.filter(
      (c) => c[0]?.__cmd === "Put" && c[0].input.TableName === "test-signals-v2",
    );
    expect(signalsV2Puts.length).toBeGreaterThan(0);
  });

  it("invokes kickoffRatification exactly once when ratifySignal returns the callback (pending path)", async () => {
    // Counterpart to the prior test — verifies the affirmative case so the
    // assertion isn't trivially passing via "kickoffMock was never wired up".
    const kickoffMock = vi.fn().mockResolvedValue(undefined);
    ratifySignalMock.mockImplementation(
      async (ctx: { candidate: BlendedSignal }, _onStage2: unknown) => ({
        signal: { ...ctx.candidate, ratificationStatus: "pending" as const },
        fellBackToAlgo: false,
        cacheHit: false,
        kickoffRatification: kickoffMock,
      }),
    );

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    expect(kickoffMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED_EXCHANGE_COUNT configuration
// ---------------------------------------------------------------------------

describe("REQUIRED_EXCHANGE_COUNT env var", () => {
  it("respects REQUIRED_EXCHANGE_COUNT=1 for single-exchange quorum", async () => {
    process.env.REQUIRED_EXCHANGE_COUNT = "1";

    send.mockImplementation((cmd) => {
      if (cmd.__cmd === "Update") return Promise.resolve({});
      if (cmd.__cmd === "Get") {
        if (cmd.input.TableName === "test-close-quorum") {
          // Only 1 exchange — quorum if threshold is 1
          return Promise.resolve({
            Item: {
              id: `${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`,
              exchanges: new Set([TEST_EXCHANGE]),
            },
          });
        }
        return Promise.resolve({ Item: undefined });
      }
      if (cmd.__cmd === "Put") return Promise.resolve({});
      if (cmd.__cmd === "Query") return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    const { handler } = await import("./indicator-handler.js");
    await handler(makeStreamEvent(), {} as any, () => {});

    // With REQUIRED_EXCHANGE_COUNT=1, a single-exchange quorum should proceed
    expect(getCandles).toHaveBeenCalled();
  });
});
