/**
 * Tests for signal-service.ts — signals_v2 read path.
 *
 * Covers:
 *   - getSignalForUser: returns null when table is empty (no signals yet)
 *   - getSignalForUser: returns mapped BlendedSignal when a record exists
 *   - getSignalForUser: bootstraps the user record on first call
 *   - getAllSignalsForUser: returns empty array when table is empty
 *   - getAllSignalsForUser: returns one BlendedSignal per pair that has data
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
}));

// ---------------------------------------------------------------------------
// Mock user-store so bootstrap calls don't hit DynamoDB
// ---------------------------------------------------------------------------

const getOrCreateUserRecordMock = vi.fn();

vi.mock("./user-store.js", () => ({
  getOrCreateUserRecord: getOrCreateUserRecordMock,
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  getOrCreateUserRecordMock.mockReset();
  getOrCreateUserRecordMock.mockResolvedValue({
    userId: "user_test",
    tier: "free",
    riskProfiles: {},
  });
  delete process.env.TABLE_SIGNALS_V2;
  delete process.env.TABLE_PREFIX;
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
    sendMock.mockResolvedValue({ Items: [fixtureItem] });
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
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0];
    expect(call.ExpressionAttributeValues[":pair"]).toBe("SOL/USDT");
    expect(call.Limit).toBe(1);
    expect(call.ScanIndexForward).toBe(false);
  });

  it("propagates null gateReason and risk from the fixture", async () => {
    const holdItem = { ...fixtureItem, type: "hold", risk: null, gateReason: "vol" };
    sendMock.mockResolvedValue({ Items: [holdItem] });
    const { getSignalForUser } = await loadService();
    const result = await getSignalForUser("user_1", "BTC/USDT");
    expect(result!.type).toBe("hold");
    expect(result!.risk).toBeNull();
    expect(result!.gateReason).toBe("vol");
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
    // Return a fixture item for BTC/USDT, empty for all others.
    sendMock.mockImplementation((cmd: { ExpressionAttributeValues?: Record<string, unknown> }) => {
      if (cmd.ExpressionAttributeValues?.[":pair"] === "BTC/USDT") {
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
    const { getAllSignalsForUser, PAIRS } = await loadService();
    await getAllSignalsForUser("user_all", "all@b.com");
    // One DDB bootstrap call + one query per pair
    expect(getOrCreateUserRecordMock).toHaveBeenCalledOnce();
    expect(getOrCreateUserRecordMock).toHaveBeenCalledWith("user_all", "all@b.com");
    // One DDB query call per pair
    expect(sendMock).toHaveBeenCalledTimes(PAIRS.length);
  });
});
