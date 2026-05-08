/**
 * Tests for indicator-handler.ts
 *
 * Mocking strategy:
 *   - All AWS SDK calls are replaced with a single `send` vi.fn().
 *   - candle-store, canonicalize, cooldown-store, indicator-state-store,
 *     signal-store, indicators/index, signals/score, signals/blend, signals/gates
 *     are all vi.mock'd at the module boundary.
 *   - Handler is imported dynamically after resetModules() so module-scope
 *     table-name env vars are picked up fresh.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TimeframeVote, BlendedSignal } from "@quantara/shared";

// ---------------------------------------------------------------------------
// AWS SDK mock (single send mock covering all DDB interactions in the handler)
// ---------------------------------------------------------------------------

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

// ---------------------------------------------------------------------------
// Module mocks — pure-function and store layers
// ---------------------------------------------------------------------------

const tryClaimProcessedCloseMock = vi.fn();
const commitProcessedCloseMock = vi.fn();
const clearProcessedCloseMock = vi.fn();
vi.mock("./lib/processed-close-store.js", () => ({
  tryClaimProcessedClose: tryClaimProcessedCloseMock,
  commitProcessedClose: commitProcessedCloseMock,
  clearProcessedClose: clearProcessedCloseMock,
}));

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

const putSignalMock = vi.fn();
const getLatestSignalMock = vi.fn();
vi.mock("./lib/signal-store.js", () => ({
  putSignal: putSignalMock,
  getLatestSignal: getLatestSignalMock,
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

// ---------------------------------------------------------------------------
// New mocks — ratification (Gap 3) + sentiment bundle
// ---------------------------------------------------------------------------

const ratifySignalMock = vi.fn();
vi.mock("./llm/ratify.js", () => ({
  ratifySignal: ratifySignalMock,
}));

const buildSentimentBundleMock = vi.fn();
vi.mock("./news/bundle.js", () => ({
  buildSentimentBundle: buildSentimentBundleMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The test pins time to 2023-01-01T00:15:10.000Z (1672532110000).
// A 15m bar closes at 2023-01-01T00:15:00.000Z (1672532100000).
// Candle closeTime must match lastClose for the freshness check to pass.
const TEST_LAST_CLOSE_15M = 1672532100000;

function makeCandle(overrides: Record<string, unknown> = {}) {
  return {
    exchange: "binanceus",
    symbol: "BTC/USDT",
    pair: "BTC/USDT",
    timeframe: "15m",
    openTime: TEST_LAST_CLOSE_15M - 15 * 60 * 1000,
    closeTime: TEST_LAST_CLOSE_15M,
    open: 30000,
    high: 30500,
    low: 29800,
    close: 30200,
    volume: 100,
    isClosed: true,
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
    asOf: 1700000900000,
  };
}

function makeBlendedSignal(): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "hold",
    confidence: 0.5,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: [],
    perTimeframe: { "15m": null, "1h": null, "4h": null, "1d": null, "1m": null, "5m": null },
    weightsUsed: { "15m": 0.15, "1h": 0.2, "4h": 0.3, "1d": 0.35, "1m": 0, "5m": 0 },
    asOf: 1700000900000,
    emittingTimeframe: "15m",
    risk: null,
  };
}

function makeState() {
  return {
    pair: "BTC/USDT",
    exchange: "consensus",
    timeframe: "15m",
    asOf: 1700000900000,
    barsSinceStart: 50,
    rsi14: 55,
    ema20: 30000,
    ema50: 29500,
    ema200: 28000,
    macdLine: 100,
    macdSignal: 90,
    macdHist: 10,
    atr14: 400,
    bbUpper: 30800,
    bbMid: 30000,
    bbLower: 29200,
    bbWidth: 0.053,
    obv: 500000,
    obvSlope: 200,
    vwap: 30100,
    volZ: 0.5,
    realizedVolAnnualized: 0.55,
    fearGreed: 60,
    dispersion: 0.002,
    history: {
      rsi14: [55, 54, 53, 52, 51],
      macdHist: [10, 8, 6, 4, 2],
      ema20: [30000, 29900, 29800, 29700, 29600],
      ema50: [29500, 29400, 29300, 29200, 29100],
      close: [30200, 30100, 30000, 29900, 29800],
      volume: [100, 90, 80, 70, 60],
    },
  };
}

// ---------------------------------------------------------------------------
// beforeEach — reset all mocks and set up sensible defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  tryClaimProcessedCloseMock.mockReset();
  commitProcessedCloseMock.mockReset();
  clearProcessedCloseMock.mockReset();
  getCandles.mockReset();
  canonicalizeCandleMock.mockReset();
  getLastFireBarsMock.mockReset();
  tickCooldownsMock.mockReset();
  recordRuleFiresMock.mockReset();
  putIndicatorStateMock.mockReset();
  putSignalMock.mockReset();
  getLatestSignalMock.mockReset();
  buildIndicatorStateMock.mockReset();
  scoreTimeframeMock.mockReset();
  blendTimeframeVotesMock.mockReset();
  isTrivialChangeMock.mockReset();
  evaluateGatesMock.mockReset();
  narrowPairMock.mockReset();

  // Default mocks.
  tryClaimProcessedCloseMock.mockResolvedValue(true);
  commitProcessedCloseMock.mockResolvedValue(undefined);
  clearProcessedCloseMock.mockResolvedValue(undefined);
  getCandles.mockResolvedValue([makeCandle()]);
  canonicalizeCandleMock.mockReturnValue({
    consensus: makeCandle({ exchange: "consensus" }),
    dispersion: 0.002,
  });
  getLastFireBarsMock.mockResolvedValue({});
  tickCooldownsMock.mockResolvedValue(undefined);
  recordRuleFiresMock.mockResolvedValue(undefined);
  putIndicatorStateMock.mockResolvedValue(undefined);
  putSignalMock.mockResolvedValue({ signalId: "abc-123", emittedAt: new Date().toISOString() });
  getLatestSignalMock.mockResolvedValue(null);
  buildIndicatorStateMock.mockReturnValue(makeState());
  scoreTimeframeMock.mockReturnValue(makeVote("hold"));
  blendTimeframeVotesMock.mockReturnValue(makeBlendedSignal());
  isTrivialChangeMock.mockReturnValue(false);
  evaluateGatesMock.mockReturnValue({ fired: false, reason: null });
  narrowPairMock.mockImplementation((pair: string) => pair);

  // Ratification mocks (Gap 3) — default to algo fallback so tests are unaffected.
  ratifySignalMock.mockReset();
  buildSentimentBundleMock.mockReset();
  // By default: ratification falls back to algo signal (no LLM cost).
  ratifySignalMock.mockImplementation(async (ctx: { candidate: BlendedSignal }) => ({
    signal: ctx.candidate,
    fellBackToAlgo: true,
    cacheHit: false,
  }));
  buildSentimentBundleMock.mockResolvedValue({
    pair: "BTC/USDT",
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

  // DDB send for handler's own GetCommand calls (fear-greed + staleness + dispersion + votes).
  send.mockResolvedValue({ Item: undefined });
});

// ---------------------------------------------------------------------------
// TF-close detection tests
// ---------------------------------------------------------------------------

describe("TF-close detection", () => {
  it("returns early when no TF closed in this minute (arbitrary mid-bar time)", async () => {
    // Pin now to 14 minutes 30 seconds past the hour — no TF boundary.
    // 14.5 minutes into a 15m bar, 14.5 minutes into a 1h bar, etc.
    // Use a fixed timestamp: 2023-01-01T00:14:30.000Z (UTC)
    const now = new Date("2023-01-01T00:14:30.000Z").getTime();
    vi.setSystemTime(now);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // No candle fetches, no indicator state, no signal persisted.
    expect(getCandles).not.toHaveBeenCalled();
    expect(putIndicatorStateMock).not.toHaveBeenCalled();
    expect(putSignalMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("detects a 15m bar close (at exactly 00:15:00 UTC)", async () => {
    // 00:15:00 UTC — 15m, and we're within 60s of that boundary.
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // Handler should have called getCandles (at least once per pair per exchange).
    expect(getCandles).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("detects a 1h bar close (at exactly 01:00:00 UTC)", async () => {
    const now = new Date("2023-01-01T01:00:05.000Z").getTime();
    vi.setSystemTime(now);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(getCandles).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Canonicalization integration tests
// ---------------------------------------------------------------------------

describe("≥2/3 stale skip path", () => {
  it("skips indicator state persistence when canonicalizeCandle returns null", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    canonicalizeCandleMock.mockReturnValue(null);
    // When all canons fail, votes never get written, so all-null goes to blend.
    // blendTimeframeVotesMock must return null to simulate real all-null path.
    blendTimeframeVotesMock.mockReturnValue(null);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // putIndicatorState should NOT have been called (all pairs skipped).
    expect(putIndicatorStateMock).not.toHaveBeenCalled();
    // putSignal should NOT have been called (blend returned null).
    expect(putSignalMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Score → blend → persist round-trip
// ---------------------------------------------------------------------------

describe("score → blend → persist round-trip", () => {
  it("calls buildIndicatorState, scoreTimeframe, blendTimeframeVotes, putSignal on TF close", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(buildIndicatorStateMock).toHaveBeenCalled();
    expect(scoreTimeframeMock).toHaveBeenCalled();
    expect(blendTimeframeVotesMock).toHaveBeenCalled();
    expect(putSignalMock).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("passes gateResult from evaluateGates to scoreTimeframe", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const gateResult = { fired: true, reason: "vol" as const };
    evaluateGatesMock.mockReturnValue(gateResult);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(scoreTimeframeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ gateResult }),
    );

    vi.useRealTimers();
  });

  it("calls recordRuleFires when vote has rulesFired", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const voteWithRules = makeVote("buy");
    voteWithRules.rulesFired = ["rsi-oversold", "ema-cross-bull"];
    scoreTimeframeMock.mockReturnValue(voteWithRules);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(recordRuleFiresMock).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("does not call recordRuleFires when rulesFired is empty", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const voteNoRules = makeVote("hold");
    voteNoRules.rulesFired = [];
    scoreTimeframeMock.mockReturnValue(voteNoRules);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(recordRuleFiresMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("always calls putSignal even when isTrivialChange returns true", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    isTrivialChangeMock.mockReturnValue(true);
    blendTimeframeVotesMock.mockReturnValue(makeBlendedSignal());

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // putSignal should still be called even for trivial changes.
    expect(putSignalMock).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("does not call putSignal when blendTimeframeVotes returns null (all TFs null)", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    blendTimeframeVotesMock.mockReturnValue(null);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(putSignalMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Cooldown integration
// ---------------------------------------------------------------------------

describe("cooldown integration", () => {
  it("calls tickCooldowns and getLastFireBars on each pair/TF", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // 5 PAIRS × 1 closed TF = 5 tickCooldowns calls.
    expect(tickCooldownsMock).toHaveBeenCalledTimes(5);
    expect(getLastFireBarsMock).toHaveBeenCalledTimes(5);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Idempotency — processed-close marker
// ---------------------------------------------------------------------------

describe("idempotency via processed-close marker", () => {
  it("skips indicator state and cooldown processing when tryClaimProcessedClose returns false (duplicate invocation)", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    // Simulate all claims failing — another invocation already processed these closes.
    tryClaimProcessedCloseMock.mockResolvedValue(false);
    // Blend step reads stored votes; with no new indicator state we still blend existing.
    blendTimeframeVotesMock.mockReturnValue(null);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // Indicator state and cooldown work must be skipped (idempotency guard fired).
    expect(putIndicatorStateMock).not.toHaveBeenCalled();
    expect(tickCooldownsMock).not.toHaveBeenCalled();
    // putSignal is not called because blend returned null.
    expect(putSignalMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("processes work when tryClaimProcessedClose returns true (first invocation)", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    tryClaimProcessedCloseMock.mockResolvedValue(true);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(putIndicatorStateMock).toHaveBeenCalled();
    expect(putSignalMock).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("calls tryClaimProcessedClose with correct pair, tf, and lastClose", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    tryClaimProcessedCloseMock.mockResolvedValue(true);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // Should be called once per pair (5 pairs) × 1 closed TF.
    expect(tryClaimProcessedCloseMock).toHaveBeenCalledTimes(5);
    // The lastClose for the 15m bar should be exactly 2023-01-01T00:15:00.000Z.
    expect(tryClaimProcessedCloseMock).toHaveBeenCalledWith(
      expect.any(String),
      "15m",
      TEST_LAST_CLOSE_15M,
    );

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Candle freshness check
// ---------------------------------------------------------------------------

describe("candle freshness check", () => {
  it("skips processing when candle closeTime doesn't match lastClose (stale candle)", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    // Return a candle with a closeTime that doesn't match lastClose (previous bar).
    const staleCandle = makeCandle({ closeTime: TEST_LAST_CLOSE_15M - 15 * 60 * 1000 });
    getCandles.mockResolvedValue([staleCandle]);

    // All exchanges return stale candles → canonicalize returns null → sentinel vote
    canonicalizeCandleMock.mockReturnValue(null);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // buildIndicatorState should NOT have been called (all pairs had no fresh candles).
    expect(buildIndicatorStateMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("processes normally when candle closeTime exactly matches lastClose", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    // makeCandle defaults to closeTime = TEST_LAST_CLOSE_15M which matches lastClose.
    getCandles.mockResolvedValue([makeCandle()]);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(buildIndicatorStateMock).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Stale-vote sentinel (P2 #2)
// ---------------------------------------------------------------------------

describe("stale-vote sentinel on consensus skip", () => {
  it("writes a sentinel null vote when canonicalize returns null (≥2/3 stale)", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    canonicalizeCandleMock.mockReturnValue(null);
    blendTimeframeVotesMock.mockReturnValue(null);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // send should have been called with PutCommand for the sentinel vote per pair.
    const putCallCount = send.mock.calls.filter((call) => call[0]?.__cmd === "Put").length;
    expect(putCallCount).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });

  it("does NOT early-return sentinel when canonicalize succeeds", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    // canonicalizeCandleMock returns a valid canon (default).
    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // buildIndicatorState should have been called, meaning we proceeded normally.
    expect(buildIndicatorStateMock).toHaveBeenCalled();
    // Indicator state was processed and persisted.
    expect(putIndicatorStateMock).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// P1: Candle slot scan (newest-first array with in-progress bar at index 0)
// ---------------------------------------------------------------------------

describe("candle slot scan — picks bar matching lastClose, not index 0", () => {
  it("picks the closed bar at index 1 when index 0 is an in-progress newer bar", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const barMs = 15 * 60 * 1000;
    // Simulate backfill writing a newer in-progress bar ahead of the just-closed bar.
    const inProgressCandle = makeCandle({
      closeTime: TEST_LAST_CLOSE_15M + barMs, // next bar — not yet closed
      isClosed: false,
    });
    const justClosedCandle = makeCandle({
      closeTime: TEST_LAST_CLOSE_15M, // this is the bar that just closed
      isClosed: true,
    });
    // Newest-first: in-progress bar is index 0, just-closed bar is index 1.
    getCandles.mockResolvedValue([inProgressCandle, justClosedCandle]);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // canonicalizeCandle should have been called with the just-closed bar as the
    // exchange-latest entry, NOT the in-progress bar.
    expect(canonicalizeCandleMock).toHaveBeenCalled();
    const candlesPassedToCanon = canonicalizeCandleMock.mock.calls[0]![0] as Record<
      string,
      { closeTime: number } | null
    >;
    for (const ex of Object.keys(candlesPassedToCanon)) {
      const entry = candlesPassedToCanon[ex];
      if (entry !== null) {
        // Every non-null entry must be the just-closed bar, not the in-progress one.
        expect(entry.closeTime).toBe(TEST_LAST_CLOSE_15M);
      }
    }

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// P2: Marker written after vote persist (clear on error → retry not skipped)
// ---------------------------------------------------------------------------

describe("marker lifecycle — commit after vote, clear on error", () => {
  it("calls commitProcessedClose after vote is persisted on the happy path", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // commitProcessedClose must be called (once per pair × 1 closed TF).
    expect(commitProcessedCloseMock).toHaveBeenCalledTimes(5);
    // clearProcessedClose must NOT be called on the success path.
    expect(clearProcessedCloseMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("calls clearProcessedClose on error so the second invocation is NOT skipped", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    // Simulate a failure after candle read but before vote persist.
    // putIndicatorState throws — the pipeline should catch, clear the marker,
    // then re-throw so the outer handler loop continues with other pairs.
    putIndicatorStateMock.mockRejectedValue(new Error("DDB write failed"));

    const { handler } = await import("./indicator-handler.js");
    // Handler swallows per-pair errors and logs them — it should not throw at top level.
    await expect(handler({})).resolves.toBeUndefined();

    // The marker must be cleared (not committed) when the pipeline threw.
    expect(clearProcessedCloseMock).toHaveBeenCalled();
    expect(commitProcessedCloseMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("second invocation for same close is NOT skipped after a cleared marker", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    // First invocation: claim succeeds, pipeline throws, marker cleared.
    putIndicatorStateMock.mockRejectedValueOnce(new Error("transient failure"));

    const { handler: handlerFirst } = await import("./indicator-handler.js");
    await handlerFirst({});

    // The marker was cleared — tryClaimProcessedClose would return true again on retry.
    // Simulate the retry by resetting the claim mock to return true again.
    tryClaimProcessedCloseMock.mockResolvedValue(true);
    putIndicatorStateMock.mockResolvedValue(undefined); // recovered

    vi.resetModules();
    const { handler: handlerSecond } = await import("./indicator-handler.js");
    await handlerSecond({});

    // Second invocation should have processed work (not been short-circuited).
    expect(putIndicatorStateMock).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Gap 3 — ratifySignal wiring
// ---------------------------------------------------------------------------

describe("ratifySignal wiring (Gap 3)", () => {
  it("calls ratifySignal after blending when a blended signal is produced", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(ratifySignalMock).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("persists the ratified signal (not the algo candidate) when ratification succeeds", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    const ratifiedSignal = {
      ...makeBlendedSignal(),
      type: "buy" as const,
      confidence: 0.85,
    };
    ratifySignalMock.mockResolvedValue({
      signal: ratifiedSignal,
      fellBackToAlgo: false,
      cacheHit: false,
    });

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    // putSignal should have been called with the ratified signal
    expect(putSignalMock).toHaveBeenCalled();
    const persistedSignal = putSignalMock.mock.calls[0][0] as BlendedSignal;
    expect(persistedSignal.confidence).toBe(0.85);

    vi.useRealTimers();
  });

  it("falls back to algo signal and still calls putSignal when ratifySignal throws", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    ratifySignalMock.mockRejectedValue(new Error("Anthropic API error"));

    const { handler } = await import("./indicator-handler.js");
    // Handler must not throw — ratification failure is non-fatal.
    await expect(handler({})).resolves.toBeUndefined();

    // putSignal must still be called (with the algo fallback signal).
    expect(putSignalMock).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("does not call ratifySignal when blendTimeframeVotes returns null", async () => {
    const now = new Date("2023-01-01T00:15:10.000Z").getTime();
    vi.setSystemTime(now);

    blendTimeframeVotesMock.mockReturnValue(null);

    const { handler } = await import("./indicator-handler.js");
    await handler({});

    expect(ratifySignalMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
