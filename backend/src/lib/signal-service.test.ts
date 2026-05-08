/**
 * Tests for signal-service.ts — signals_v2 read path + risk enrichment + history.
 *
 * Covers:
 *   - getSignalForUser: returns null when table is empty (no signals yet)
 *   - getSignalForUser: returns mapped BlendedSignal when a record exists
 *   - getSignalForUser: bootstraps the user record on first call
 *   - getSignalForUser: calls attachRiskRecommendation for non-hold signals
 *   - getSignalForUser: hold signals get risk: null without indicator state fetch
 *   - getAllSignalsForUser: returns empty array when table is empty
 *   - getAllSignalsForUser: returns one BlendedSignal per pair that has data
 *   - getSignalHistoryForUser: returns history from signal-outcomes table
 *   - getSignalHistoryForUser: returns empty history when table is empty
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock DynamoDB client
// ---------------------------------------------------------------------------

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({ send: sendMock }),
  },
  QueryCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "QueryCommand" })),
  GetCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "GetCommand" })),
}));

// ---------------------------------------------------------------------------
// Mock user-store so bootstrap calls don't hit DynamoDB
// ---------------------------------------------------------------------------

const getOrCreateUserRecordMock = vi.fn();

vi.mock("./user-store.js", () => ({
  getOrCreateUserRecord: getOrCreateUserRecordMock,
}));

// ---------------------------------------------------------------------------
// Mock @quantara/shared risk helpers to isolate signal-service logic
// ---------------------------------------------------------------------------

const attachRiskRecommendationMock = vi.fn();
const defaultRiskProfilesMock = vi.fn();

vi.mock("@quantara/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@quantara/shared")>();
  return {
    ...actual,
    attachRiskRecommendation: attachRiskRecommendationMock,
    defaultRiskProfiles: defaultRiskProfilesMock,
  };
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const defaultRiskProfilesMap = {
  "BTC/USDT": "moderate" as const,
  "ETH/USDT": "conservative" as const,
  "SOL/USDT": "aggressive" as const,
  "XRP/USDT": "moderate" as const,
  "DOGE/USDT": "conservative" as const,
};

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  getOrCreateUserRecordMock.mockReset();
  attachRiskRecommendationMock.mockReset();
  defaultRiskProfilesMock.mockReset();
  getOrCreateUserRecordMock.mockResolvedValue({
    userId: "user_test",
    tier: "free",
    riskProfiles: defaultRiskProfilesMap,
  });
  // Default: attachRiskRecommendation returns the signal unchanged (pass-through)
  attachRiskRecommendationMock.mockImplementation((signal: unknown) => signal);
  // Default: defaultRiskProfiles returns a minimal map
  defaultRiskProfilesMock.mockReturnValue(defaultRiskProfilesMap);
  delete process.env.TABLE_SIGNALS_V2;
  delete process.env.TABLE_PREFIX;
  delete process.env.TABLE_INDICATOR_STATE;
  delete process.env.TABLE_SIGNAL_OUTCOMES;
});

async function loadService() {
  return await import("./signal-service.js");
}

// ---------------------------------------------------------------------------
// Minimal BlendedSignal DynamoDB item fixture
// ---------------------------------------------------------------------------

const fixtureItem = {
  pair: "BTC/USDT",
  type: "buy",
  confidence: 0.72,
  volatilityFlag: false,
  gateReason: null,
  rulesFired: ["ema_cross_bullish", "rsi_oversold"],
  perTimeframe: {
    "1h": {
      type: "buy",
      confidence: 0.72,
      rulesFired: ["ema_cross_bullish"],
      bullishScore: 0.8,
      bearishScore: 0.1,
      volatilityFlag: false,
      gateReason: null,
      asOf: 1700000000000,
    },
  },
  weightsUsed: { "1h": 1.0 },
  asOf: 1700000000000,
  emittingTimeframe: "1h",
  risk: {
    pair: "BTC/USDT",
    profile: "conservative",
    positionSizePct: 0.01,
    positionSizeModel: "fixed",
    stopLoss: 42000,
    stopDistance: 500,
    takeProfit: [{ price: 44000, closePct: 0.5, rMultiple: 4 }],
    invalidationCondition: "Close below 42000",
    trailingStopAfterTP2: { multiplier: 1.5, reference: "ATR" },
  },
};

// Minimal IndicatorState item shape as stored in DynamoDB.
const indicatorStateItem = {
  pk: "BTC/USDT#consensus#1h",
  asOf: "2023-01-01T00:00:00.000Z",
  pair: "BTC/USDT",
  exchange: "consensus",
  timeframe: "1h",
  asOfMs: 1700000000000,
  barsSinceStart: 200,
  rsi14: 55,
  ema20: 46000,
  ema50: 45000,
  ema200: 44000,
  macdLine: 100,
  macdSignal: 80,
  macdHist: 20,
  atr14: 500,
  bbUpper: 47500,
  bbMid: 46000,
  bbLower: 44500,
  bbWidth: 0.065,
  obv: 100000,
  obvSlope: 500,
  vwap: 46000,
  volZ: 1.2,
  realizedVolAnnualized: 0.6,
  fearGreed: 55,
  dispersion: 0.001,
  history: {
    rsi14: [52, 53, 54, 55, 55],
    macdHist: [15, 17, 19, 20, 20],
    ema20: [45800, 45900, 46000, 46000, 46000],
    ema50: [44900, 45000, 45000, 45000, 45000],
    close: [45800, 45900, 46000, 46100, 46200],
    volume: [1000, 1100, 1050, 1200, 1150],
  },
};

// ---------------------------------------------------------------------------
// BlendedSignalSchema — partial perTimeframe parse guard
// ---------------------------------------------------------------------------

describe("BlendedSignalSchema.parse (partial perTimeframe)", () => {
  it("accepts a fixture with only one TF key present (other 3 absent)", async () => {
    // Regression guard for PR #107: perTimeframe keys are now individually optional,
    // so a DDB item or test fixture that omits some TFs must not throw ZodError.
    const { BlendedSignalSchema } = await import("./schemas/genie.js");
    const partialFixture = {
      pair: "ETH/USDT",
      type: "buy" as const,
      confidence: 0.65,
      volatilityFlag: false,
      gateReason: null,
      rulesFired: ["ema_cross_bullish"],
      perTimeframe: {
        "15m": {
          type: "buy" as const,
          confidence: 0.65,
          rulesFired: ["ema_cross_bullish"],
          bullishScore: 0.7,
          bearishScore: 0.2,
          volatilityFlag: false,
          gateReason: null,
          asOf: 1700000000000,
        },
        // "1h", "4h", "1d" intentionally absent
      },
      weightsUsed: { "15m": 1.0 },
      asOf: 1700000000000,
      emittingTimeframe: "15m" as const,
      risk: null,
    };
    expect(() => BlendedSignalSchema.parse(partialFixture)).not.toThrow();
    const parsed = BlendedSignalSchema.parse(partialFixture);
    expect(parsed.perTimeframe["15m"]).toBeDefined();
    expect(parsed.perTimeframe["1h"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getSignalForUser
// ---------------------------------------------------------------------------

describe("getSignalForUser", () => {
  it("returns null when the table has no signal for the pair", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getSignalForUser } = await loadService();
    const result = await getSignalForUser("user_1", "BTC/USDT");
    expect(result).toBeNull();
  });

  it("returns a mapped BlendedSignal when a record exists", async () => {
    // First call: signals_v2 query → returns fixture
    // Second call: indicator-state query → returns state (for risk enrichment)
    sendMock
      .mockResolvedValueOnce({ Items: [fixtureItem] })
      .mockResolvedValueOnce({ Items: [indicatorStateItem] });
    const { getSignalForUser } = await loadService();
    const result = await getSignalForUser("user_1", "BTC/USDT", "user@b.com");
    expect(result).not.toBeNull();
    expect(result!.pair).toBe("BTC/USDT");
    expect(result!.type).toBe("buy");
    expect(result!.confidence).toBe(0.72);
    expect(result!.rulesFired).toEqual(["ema_cross_bullish", "rsi_oversold"]);
    expect(result!.risk).not.toBeNull();
    expect(result!.risk!.pair).toBe("BTC/USDT");
  });

  it("bootstraps the user record via getOrCreateUserRecord", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getSignalForUser } = await loadService();
    await getSignalForUser("user_bootstrap", "ETH/USDT", "boot@b.com");
    expect(getOrCreateUserRecordMock).toHaveBeenCalledOnce();
    expect(getOrCreateUserRecordMock).toHaveBeenCalledWith("user_bootstrap", "boot@b.com");
  });

  it("queries signals_v2 with the correct pair key and Limit 1", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getSignalForUser } = await loadService();
    await getSignalForUser("user_1", "SOL/USDT");
    // At minimum one DDB call (signals_v2 query)
    expect(sendMock).toHaveBeenCalled();
    const firstCall = sendMock.mock.calls[0][0];
    expect(firstCall.ExpressionAttributeValues[":pair"]).toBe("SOL/USDT");
    expect(firstCall.Limit).toBe(1);
    expect(firstCall.ScanIndexForward).toBe(false);
  });

  it("propagates null gateReason and risk from the fixture for hold signals", async () => {
    const holdItem = { ...fixtureItem, type: "hold", risk: null, gateReason: "vol" };
    sendMock.mockResolvedValue({ Items: [holdItem] });
    const { getSignalForUser } = await loadService();
    const result = await getSignalForUser("user_1", "BTC/USDT");
    expect(result!.type).toBe("hold");
    expect(result!.risk).toBeNull();
    expect(result!.gateReason).toBe("vol");
  });

  it("calls attachRiskRecommendation for non-hold signals when IndicatorState is available", async () => {
    const enrichedSignal = { ...fixtureItem, risk: { pair: "BTC/USDT", profile: "moderate" } };
    attachRiskRecommendationMock.mockReturnValueOnce(enrichedSignal);
    sendMock
      .mockResolvedValueOnce({ Items: [fixtureItem] })
      .mockResolvedValueOnce({ Items: [indicatorStateItem] });

    const { getSignalForUser } = await loadService();
    const result = await getSignalForUser("user_1", "BTC/USDT");
    expect(attachRiskRecommendationMock).toHaveBeenCalledOnce();
    expect(result).toBe(enrichedSignal);
  });

  it("returns signal without enrichment when IndicatorState is unavailable (warm-up)", async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [fixtureItem] })
      .mockResolvedValueOnce({ Items: [] }); // no indicator state

    const { getSignalForUser } = await loadService();
    const result = await getSignalForUser("user_1", "BTC/USDT");
    // Should NOT call attachRiskRecommendation when state is unavailable
    expect(attachRiskRecommendationMock).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.pair).toBe("BTC/USDT");
  });

  it("does not fetch IndicatorState for hold signals", async () => {
    const holdItem = { ...fixtureItem, type: "hold", risk: null, gateReason: null };
    sendMock.mockResolvedValueOnce({ Items: [holdItem] });

    const { getSignalForUser } = await loadService();
    await getSignalForUser("user_1", "BTC/USDT");

    // Only 1 DDB call — the signals_v2 query; no indicator state fetch needed for hold
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(attachRiskRecommendationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getAllSignalsForUser
// ---------------------------------------------------------------------------

describe("getAllSignalsForUser", () => {
  it("returns an empty array when all pairs have no signals", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getAllSignalsForUser } = await loadService();
    const results = await getAllSignalsForUser("user_1");
    expect(results).toEqual([]);
  });

  it("returns one BlendedSignal per pair that has data", async () => {
    // Return a fixture item for BTC/USDT; empty for all others (including indicator state).
    sendMock.mockImplementation((cmd: { ExpressionAttributeValues?: Record<string, unknown> }) => {
      if (cmd.ExpressionAttributeValues?.[":pair"] === "BTC/USDT") {
        // First call for BTC/USDT pair returns the signal
        return Promise.resolve({ Items: [fixtureItem] });
      }
      return Promise.resolve({ Items: [] });
    });
    const { getAllSignalsForUser } = await loadService();
    const results = await getAllSignalsForUser("user_1", "user@b.com");
    expect(results).toHaveLength(1);
    expect(results[0].pair).toBe("BTC/USDT");
    expect(results[0].type).toBe("buy");
  });

  it("bootstraps the user record exactly once regardless of pair count", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getAllSignalsForUser } = await loadService();
    await getAllSignalsForUser("user_all", "all@b.com");
    expect(getOrCreateUserRecordMock).toHaveBeenCalledOnce();
    expect(getOrCreateUserRecordMock).toHaveBeenCalledWith("user_all", "all@b.com");
  });
});

// ---------------------------------------------------------------------------
// getSignalHistoryForUser
// ---------------------------------------------------------------------------

describe("getSignalHistoryForUser", () => {
  const outcomeItem = {
    pair: "BTC/USDT",
    signalId: "sig-001",
    type: "buy",
    confidence: 0.72,
    createdAt: "2024-01-01T00:00:00.000Z",
    outcome: "correct",
    priceAtSignal: 45000,
    priceAtResolution: 46000,
  };

  it("returns empty history when signal-outcomes table has no records", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getSignalHistoryForUser } = await loadService();
    const result = await getSignalHistoryForUser("user_1", undefined, { pageSize: 20 });
    expect(result.history).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("returns mapped history entries from signal-outcomes table", async () => {
    // All queries including the user bootstrap and the per-pair queries
    sendMock.mockImplementation((cmd: { ExpressionAttributeValues?: Record<string, unknown> }) => {
      if (cmd.ExpressionAttributeValues?.[":pair"] === "BTC/USDT") {
        return Promise.resolve({ Items: [outcomeItem] });
      }
      return Promise.resolve({ Items: [] });
    });
    const { getSignalHistoryForUser } = await loadService();
    const result = await getSignalHistoryForUser("user_1", "user@b.com", {
      pageSize: 20,
      pair: "BTC/USDT",
    });
    expect(result.history).toHaveLength(1);
    expect(result.history[0].signalId).toBe("sig-001");
    expect(result.history[0].pair).toBe("BTC/USDT");
    expect(result.history[0].outcome).toBe("correct");
    expect(result.history[0].priceAtSignal).toBe(45000);
    expect(result.history[0].priceAtResolution).toBe(46000);
  });

  it("bootstraps user record before querying history", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getSignalHistoryForUser } = await loadService();
    await getSignalHistoryForUser("user_hist", "hist@b.com", { pageSize: 20 });
    expect(getOrCreateUserRecordMock).toHaveBeenCalledWith("user_hist", "hist@b.com");
  });

  it("returns hasMore=true and nextCursor when DDB returns LastEvaluatedKey", async () => {
    const lastKey = { pair: "BTC/USDT", signalId: "sig-001" };
    sendMock.mockResolvedValueOnce({ Items: [outcomeItem], LastEvaluatedKey: lastKey });
    const { getSignalHistoryForUser } = await loadService();
    const result = await getSignalHistoryForUser("user_1", undefined, {
      pageSize: 20,
      pair: "BTC/USDT",
    });
    expect(result.hasMore).toBe(true);
    expect(typeof result.nextCursor).toBe("string");
    // Cursor is base64-encoded JSON of the LastEvaluatedKey
    const decoded = JSON.parse(Buffer.from(result.nextCursor!, "base64").toString("utf-8"));
    expect(decoded).toEqual(lastKey);
  });

  it("accepts and decodes a cursor from a previous page", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ pair: "BTC/USDT", signalId: "sig-001" }),
    ).toString("base64");
    sendMock.mockResolvedValue({ Items: [] });
    const { getSignalHistoryForUser } = await loadService();
    // Should not throw on valid cursor
    await expect(
      getSignalHistoryForUser("user_1", undefined, { pageSize: 20, pair: "BTC/USDT", cursor }),
    ).resolves.not.toThrow();
  });

  it("ignores malformed cursor and starts from beginning", async () => {
    sendMock.mockResolvedValue({ Items: [] });
    const { getSignalHistoryForUser } = await loadService();
    await expect(
      getSignalHistoryForUser("user_1", undefined, {
        pageSize: 20,
        pair: "BTC/USDT",
        cursor: "not-valid-base64!!!",
      }),
    ).resolves.not.toThrow();
  });
});
