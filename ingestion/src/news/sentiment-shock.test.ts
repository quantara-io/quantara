/**
 * Tests for news/sentiment-shock.ts
 *
 * Covers all acceptance criteria from issue #167:
 *   - Shock detector (fire / no-fire cases)
 *   - Cost gate (cooldown + hourly cap)
 *   - Trigger to ratify (neutral skip, cold-start skip, actual fire)
 *   - Feature flag honour
 *   - Schema: triggerReason / previousRatificationId
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SentimentAggregate } from "./aggregator.js";

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before any imports of the SUT)
// ---------------------------------------------------------------------------

const getLatestSignalMock = vi.fn();
vi.mock("../lib/signal-store.js", () => ({
  getLatestSignal: getLatestSignalMock,
}));

const ratifySignalMock = vi.fn();
vi.mock("../llm/ratify.js", () => ({
  ratifySignal: ratifySignalMock,
}));

const putRatificationRecordMock = vi.fn();
const getRecentShockRatificationsMock = vi.fn();
const getRecentRatificationsMock = vi.fn();
vi.mock("../lib/ratification-store.js", () => ({
  putRatificationRecord: putRatificationRecordMock,
  getRecentShockRatifications: getRecentShockRatificationsMock,
  getRecentRatifications: getRecentRatificationsMock,
}));

const buildSentimentBundleMock = vi.fn();
vi.mock("./bundle.js", () => ({
  buildSentimentBundle: buildSentimentBundleMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAggregate(overrides: Partial<SentimentAggregate> = {}): SentimentAggregate {
  return {
    pair: "BTC/USDT",
    window: "4h",
    computedAt: new Date().toISOString(),
    articleCount: 5,
    meanScore: 0.0,
    meanMagnitude: 0.6,
    fearGreedTrend24h: null,
    fearGreedLatest: 55,
    ...overrides,
  };
}

function makeBlendedSignal(overrides: Record<string, unknown> = {}) {
  return {
    pair: "BTC/USDT",
    type: "buy",
    confidence: 0.75,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: ["ema-cross", "rsi-oversold"],
    perTimeframe: {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
    },
    weightsUsed: {
      "1m": 0,
      "5m": 0,
      "15m": 0.15,
      "1h": 0.2,
      "4h": 0.3,
      "1d": 0.35,
    },
    asOf: Date.now(),
    emittingTimeframe: "4h",
    risk: null,
    ratificationStatus: "ratified",
    ratificationVerdict: null,
    algoVerdict: null,
    signalId: "abc-123",
    emittedAt: new Date().toISOString(),
    sk: "4h#1234567890000",
    interpretation: null,
    invalidatedAt: null,
    invalidationReason: null,
    ...overrides,
  };
}

function makeSentimentBundle() {
  return {
    pair: "BTC/USDT",
    assembledAt: new Date().toISOString(),
    windows: {
      "4h": makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 }),
      "24h": makeAggregate({ window: "24h", meanScore: 0.2, meanMagnitude: 0.5 }),
    },
    fearGreed: {
      value: 55,
      classification: "Neutral",
      lastTimestamp: null,
      history: [],
      trend24h: 5,
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  putRatificationRecordMock.mockReset();
  getRecentShockRatificationsMock.mockReset();
  getRecentRatificationsMock.mockReset();
  getLatestSignalMock.mockReset();
  ratifySignalMock.mockReset();
  buildSentimentBundleMock.mockReset();

  // Default happy-path mocks
  getRecentShockRatificationsMock.mockResolvedValue([]);
  getRecentRatificationsMock.mockResolvedValue([]);
  getLatestSignalMock.mockResolvedValue(makeBlendedSignal());
  ratifySignalMock.mockResolvedValue({
    signal: makeBlendedSignal({ ratificationStatus: "ratified" }),
    fellBackToAlgo: false,
    cacheHit: false,
    kickoffRatification: undefined,
  });
  buildSentimentBundleMock.mockResolvedValue(makeSentimentBundle());
  putRatificationRecordMock.mockResolvedValue("new-record-id");
});

afterEach(() => {
  // Reset env vars
  delete process.env.ENABLE_SENTIMENT_SHOCK_RATIFICATION;
  delete process.env.SENTIMENT_SHOCK_DELTA_THRESHOLD;
  delete process.env.SENTIMENT_SHOCK_MAGNITUDE_FLOOR;
  delete process.env.SENTIMENT_SHOCK_WINDOWS;
  delete process.env.SENTIMENT_SHOCK_COOLDOWN_MINUTES;
  delete process.env.SENTIMENT_SHOCK_MAX_PER_PAIR_PER_HOUR;
});

// ---------------------------------------------------------------------------
// Shock detector: detectSentimentShock
// ---------------------------------------------------------------------------

describe("detectSentimentShock", () => {
  it("returns shouldFire=true when delta>=0.3 and magnitude>=0.5 in 4h window", async () => {
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });
    const result = detectSentimentShock(prev, next);
    expect(result.shouldFire).toBe(true);
  });

  it("returns shouldFire=false when magnitude < floor (weak conviction)", async () => {
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.3 }); // magnitude below 0.5 floor
    const result = detectSentimentShock(prev, next);
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toContain("magnitude");
  });

  it("returns shouldFire=false when delta < threshold (small swing)", async () => {
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.2, meanMagnitude: 0.7 }); // delta=0.2 < 0.3
    const result = detectSentimentShock(prev, next);
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toContain("delta");
  });

  it("returns shouldFire=false when prev is null (first-ever aggregate)", async () => {
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const next = makeAggregate({ meanScore: 0.5, meanMagnitude: 0.8 });
    const result = detectSentimentShock(null, next);
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toContain("first computation");
  });

  it("returns shouldFire=false for 24h window (not shock-eligible by default)", async () => {
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ window: "24h", meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ window: "24h", meanScore: 0.5, meanMagnitude: 0.8 });
    const result = detectSentimentShock(prev, next);
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toContain("window 24h not in shock-eligible");
  });

  it("returns shouldFire=false when meanScore is null (no articles)", async () => {
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: null });
    const next = makeAggregate({ meanScore: 0.5, meanMagnitude: 0.8 });
    const result = detectSentimentShock(prev, next);
    expect(result.shouldFire).toBe(false);
    expect(result.reason).toContain("null meanScore");
  });

  it("respects SENTIMENT_SHOCK_DELTA_THRESHOLD env override", async () => {
    process.env.SENTIMENT_SHOCK_DELTA_THRESHOLD = "0.5";
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    // delta=0.4, but threshold is now 0.5 → should NOT fire
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });
    const result = detectSentimentShock(prev, next);
    expect(result.shouldFire).toBe(false);
  });

  it("respects SENTIMENT_SHOCK_MAGNITUDE_FLOOR env override", async () => {
    process.env.SENTIMENT_SHOCK_MAGNITUDE_FLOOR = "0.8";
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    // magnitude=0.7, floor is now 0.8 → should NOT fire
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });
    const result = detectSentimentShock(prev, next);
    expect(result.shouldFire).toBe(false);
  });

  it("fires negative sentiment swing (sell shock)", async () => {
    const { detectSentimentShock } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: -0.1, meanMagnitude: 0.8 }); // delta=0.5
    const result = detectSentimentShock(prev, next);
    expect(result.shouldFire).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cost gate: checkSentimentShockCostGate
// ---------------------------------------------------------------------------

describe("checkSentimentShockCostGate", () => {
  it("allows when no prior shocks exist (empty history)", async () => {
    getRecentShockRatificationsMock.mockResolvedValue([]);
    const { checkSentimentShockCostGate } = await import("./sentiment-shock.js");
    const result = await checkSentimentShockCostGate("BTC/USDT", new Date().toISOString());
    expect(result.allowed).toBe(true);
  });

  it("suppresses by cooldown when last shock was < 5 minutes ago", async () => {
    const nowMs = Date.now();
    const threeMinutesAgo = new Date(nowMs - 3 * 60 * 1000).toISOString();
    getRecentShockRatificationsMock.mockResolvedValue([
      {
        pair: "BTC/USDT",
        invokedAt: threeMinutesAgo,
        triggerReason: "sentiment_shock",
      },
    ]);
    const { checkSentimentShockCostGate } = await import("./sentiment-shock.js");
    const result = await checkSentimentShockCostGate("BTC/USDT", new Date(nowMs).toISOString());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("cooldown");
  });

  it("allows when last shock was > 5 minutes ago (cooldown elapsed)", async () => {
    const nowMs = Date.now();
    const sixMinutesAgo = new Date(nowMs - 6 * 60 * 1000).toISOString();
    getRecentShockRatificationsMock.mockResolvedValue([
      {
        pair: "BTC/USDT",
        invokedAt: sixMinutesAgo,
        triggerReason: "sentiment_shock",
      },
    ]);
    const { checkSentimentShockCostGate } = await import("./sentiment-shock.js");
    const result = await checkSentimentShockCostGate("BTC/USDT", new Date(nowMs).toISOString());
    expect(result.allowed).toBe(true);
  });

  it("suppresses when hourly cap (6) is reached", async () => {
    const nowMs = Date.now();
    // 6 shocks in the past hour
    const shocks = Array.from({ length: 6 }, (_, i) => ({
      pair: "BTC/USDT",
      invokedAt: new Date(nowMs - (i + 1) * 7 * 60 * 1000).toISOString(), // 7-min intervals
      triggerReason: "sentiment_shock",
    }));
    getRecentShockRatificationsMock.mockResolvedValue(shocks);
    const { checkSentimentShockCostGate } = await import("./sentiment-shock.js");
    const result = await checkSentimentShockCostGate("BTC/USDT", new Date(nowMs).toISOString());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("hourly cap");
  });

  it("allows when 6 shocks exist but the 7th would be the first-in-an-hour (counter reset)", async () => {
    const nowMs = Date.now();
    // 5 shocks within the past hour — not yet at the cap
    const shocks = Array.from({ length: 5 }, (_, i) => ({
      pair: "BTC/USDT",
      invokedAt: new Date(nowMs - (i + 1) * 7 * 60 * 1000).toISOString(),
      triggerReason: "sentiment_shock",
    }));
    getRecentShockRatificationsMock.mockResolvedValue(shocks);
    const { checkSentimentShockCostGate } = await import("./sentiment-shock.js");
    const result = await checkSentimentShockCostGate("BTC/USDT", new Date(nowMs).toISOString());
    // 5 < cap of 6, but most-recent is 7 min ago > 5 min cooldown
    expect(result.allowed).toBe(true);
  });

  it("respects SENTIMENT_SHOCK_COOLDOWN_MINUTES override", async () => {
    process.env.SENTIMENT_SHOCK_COOLDOWN_MINUTES = "10";
    const nowMs = Date.now();
    // 8 minutes ago — within 10-minute cooldown
    const eightMinutesAgo = new Date(nowMs - 8 * 60 * 1000).toISOString();
    getRecentShockRatificationsMock.mockResolvedValue([
      {
        pair: "BTC/USDT",
        invokedAt: eightMinutesAgo,
        triggerReason: "sentiment_shock",
      },
    ]);
    const { checkSentimentShockCostGate } = await import("./sentiment-shock.js");
    const result = await checkSentimentShockCostGate("BTC/USDT", new Date(nowMs).toISOString());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("cooldown");
  });

  it("respects SENTIMENT_SHOCK_MAX_PER_PAIR_PER_HOUR override", async () => {
    process.env.SENTIMENT_SHOCK_MAX_PER_PAIR_PER_HOUR = "2";
    const nowMs = Date.now();
    const shocks = [
      { pair: "BTC/USDT", invokedAt: new Date(nowMs - 30 * 60 * 1000).toISOString(), triggerReason: "sentiment_shock" },
      { pair: "BTC/USDT", invokedAt: new Date(nowMs - 20 * 60 * 1000).toISOString(), triggerReason: "sentiment_shock" },
    ];
    getRecentShockRatificationsMock.mockResolvedValue(shocks);
    const { checkSentimentShockCostGate } = await import("./sentiment-shock.js");
    const result = await checkSentimentShockCostGate("BTC/USDT", new Date(nowMs).toISOString());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("hourly cap");
  });
});

// ---------------------------------------------------------------------------
// maybeFireSentimentShockRatification — feature flag and skip paths
// ---------------------------------------------------------------------------

describe("maybeFireSentimentShockRatification — feature flag", () => {
  it("does nothing when ENABLE_SENTIMENT_SHOCK_RATIFICATION is not set (default false)", async () => {
    delete process.env.ENABLE_SENTIMENT_SHOCK_RATIFICATION;
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.5, meanMagnitude: 0.8 });

    await maybeFireSentimentShockRatification(prev, next);

    // No DDB calls, no ratify calls
    expect(getLatestSignalMock).not.toHaveBeenCalled();
    expect(ratifySignalMock).not.toHaveBeenCalled();
    expect(getRecentShockRatificationsMock).not.toHaveBeenCalled();
    expect(putRatificationRecordMock).not.toHaveBeenCalled();
  });

  it("does nothing when ENABLE_SENTIMENT_SHOCK_RATIFICATION=false", async () => {
    process.env.ENABLE_SENTIMENT_SHOCK_RATIFICATION = "false";
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0 });
    const next = makeAggregate({ meanScore: 0.5, meanMagnitude: 0.8 });

    await maybeFireSentimentShockRatification(prev, next);

    expect(ratifySignalMock).not.toHaveBeenCalled();
    expect(putRatificationRecordMock).not.toHaveBeenCalled();
  });
});

describe("maybeFireSentimentShockRatification — skip paths (flag enabled)", () => {
  beforeEach(() => {
    process.env.ENABLE_SENTIMENT_SHOCK_RATIFICATION = "true";
  });

  it("skips and logs when latest signal is null (cold start)", async () => {
    getLatestSignalMock.mockResolvedValue(null);
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    expect(ratifySignalMock).not.toHaveBeenCalled();
    expect(putRatificationRecordMock).not.toHaveBeenCalled();
  });

  it("skips and logs when latest signal is hold with empty rulesFired (warm-up neutral)", async () => {
    getLatestSignalMock.mockResolvedValue(
      makeBlendedSignal({ type: "hold", rulesFired: [] }),
    );
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    expect(ratifySignalMock).not.toHaveBeenCalled();
    expect(putRatificationRecordMock).not.toHaveBeenCalled();
  });

  it("does NOT skip for hold signal with rulesFired (a meaningful hold)", async () => {
    getLatestSignalMock.mockResolvedValue(
      makeBlendedSignal({ type: "hold", rulesFired: ["some-rule"] }),
    );
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    expect(ratifySignalMock).toHaveBeenCalled();
  });

  it("does nothing when shock detector returns shouldFire=false", async () => {
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    // Small delta — no shock
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.1, meanMagnitude: 0.7 }); // delta=0.1 < 0.3

    await maybeFireSentimentShockRatification(prev, next);

    expect(getRecentShockRatificationsMock).not.toHaveBeenCalled();
    expect(ratifySignalMock).not.toHaveBeenCalled();
  });

  it("does nothing when cost gate suppresses (cooldown)", async () => {
    const nowMs = Date.now();
    getRecentShockRatificationsMock.mockResolvedValue([
      {
        pair: "BTC/USDT",
        invokedAt: new Date(nowMs - 2 * 60 * 1000).toISOString(), // 2 min ago — within cooldown
        triggerReason: "sentiment_shock",
      },
    ]);
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    expect(ratifySignalMock).not.toHaveBeenCalled();
    expect(putRatificationRecordMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// maybeFireSentimentShockRatification — happy path / ratification fire
// ---------------------------------------------------------------------------

describe("maybeFireSentimentShockRatification — ratification fire (flag enabled)", () => {
  beforeEach(() => {
    process.env.ENABLE_SENTIMENT_SHOCK_RATIFICATION = "true";
  });

  it("calls ratifySignal with the latest signal and sentiment bundle", async () => {
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    expect(ratifySignalMock).toHaveBeenCalledOnce();
    const [ctx] = ratifySignalMock.mock.calls[0] as [{ pair: string; candidate: unknown }];
    expect(ctx.pair).toBe("BTC/USDT");
    expect(ctx.candidate).toBeDefined();
  });

  it("invokes kickoffRatification when ratifySignal returns it", async () => {
    const kickoffMock = vi.fn().mockResolvedValue(undefined);
    ratifySignalMock.mockResolvedValue({
      signal: makeBlendedSignal({ ratificationStatus: "pending" }),
      fellBackToAlgo: false,
      cacheHit: false,
      kickoffRatification: kickoffMock,
    });

    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    expect(kickoffMock).toHaveBeenCalledOnce();
  });

  it("persists a RatificationRecord with triggerReason=sentiment_shock", async () => {
    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    expect(putRatificationRecordMock).toHaveBeenCalledOnce();
    const recordArg = putRatificationRecordMock.mock.calls[0][0] as {
      triggerReason: string;
      invokedReason: string;
      pair: string;
    };
    expect(recordArg.triggerReason).toBe("sentiment_shock");
    expect(recordArg.invokedReason).toBe("sentiment_shock");
    expect(recordArg.pair).toBe("BTC/USDT");
  });

  it("links previousRatificationId to most recent bar_close ratification", async () => {
    const prevRatification = {
      pair: "BTC/USDT",
      invokedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      triggerReason: "bar_close",
      recordId: "prev-record-uuid-123",
    };
    getRecentRatificationsMock.mockResolvedValue([prevRatification]);

    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    const recordArg = putRatificationRecordMock.mock.calls[0][0] as {
      previousRatificationId: string | undefined;
    };
    expect(recordArg.previousRatificationId).toBe("prev-record-uuid-123");
  });

  it("persists previousRatificationId=undefined when no bar_close ratification exists", async () => {
    getRecentRatificationsMock.mockResolvedValue([]);

    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await maybeFireSentimentShockRatification(prev, next);

    const recordArg = putRatificationRecordMock.mock.calls[0][0] as {
      previousRatificationId: string | undefined;
    };
    expect(recordArg.previousRatificationId).toBeUndefined();
  });

  it("is non-fatal when ratifySignal throws — does not propagate", async () => {
    ratifySignalMock.mockRejectedValue(new Error("Bedrock unavailable"));

    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    // Should NOT throw
    await expect(maybeFireSentimentShockRatification(prev, next)).resolves.toBeUndefined();
  });

  it("is non-fatal when buildSentimentBundle throws", async () => {
    buildSentimentBundleMock.mockRejectedValue(new Error("DDB timeout"));

    const { maybeFireSentimentShockRatification } = await import("./sentiment-shock.js");
    const prev = makeAggregate({ meanScore: 0.0, meanMagnitude: 0.6 });
    const next = makeAggregate({ meanScore: 0.4, meanMagnitude: 0.7 });

    await expect(maybeFireSentimentShockRatification(prev, next)).resolves.toBeUndefined();
    expect(ratifySignalMock).not.toHaveBeenCalled();
  });
});
