import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Mock the DynamoDB document client send function
// ---------------------------------------------------------------------------
const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({ send: sendMock })),
  },
  QueryCommand: vi.fn().mockImplementation((input) => ({ _type: "QueryCommand", ...input })),
  GetCommand: vi.fn().mockImplementation((input) => ({ _type: "GetCommand", ...input })),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIndicatorItem(pair: string, exchange: string, timeframe: string) {
  return {
    pk: `${pair}#${exchange}#${timeframe}`,
    pair,
    exchange,
    timeframe,
    asOfMs: Date.now() - 60_000, // 1 minute ago
    barsSinceStart: 42,
    rsi14: 55.2,
    ema50: 43000.5,
    ema200: 42000.0,
    macdLine: 150.3,
    atr14: 800.1,
  };
}

function makeSignalItem(pair: string, timeframe: string) {
  return {
    pair,
    sk: `${timeframe}#${Date.now()}`,
    signalId: "abc123",
    type: "buy",
    confidence: 0.85,
    ratificationStatus: "ratified",
    asOf: Date.now() - 120_000, // 2 minutes ago
    emittedAt: new Date(Date.now() - 120_000).toISOString(),
    interpretation: { text: "Strong upward momentum confirmed." },
  };
}

function makeSentimentItem(pair: string, window: string) {
  return {
    pair,
    window,
    computedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
    articleCount: 7,
    meanScore: 0.65,
    meanMagnitude: 0.8,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getPipelineState", () => {
  it("returns cells with populated indicator + signal + sentiment when data exists", async () => {
    // For each QueryCommand call (indicator + signal per pair×tf) and GetCommand (sentiment),
    // return appropriate mock data. We test with filterPair to reduce cardinality.
    sendMock.mockImplementation((cmd: { _type: string; KeyConditionExpression?: string; Key?: { pair?: string; window?: string } }) => {
      if (cmd._type === "QueryCommand") {
        // Determine if this is an indicator or signal query by key expression shape.
        const expr = cmd.KeyConditionExpression ?? "";
        if (expr.includes("begins_with")) {
          // signals-v2 query
          return Promise.resolve({ Items: [makeSignalItem("BTC/USDT", "15m")] });
        }
        // indicator-state query
        return Promise.resolve({ Items: [makeIndicatorItem("BTC/USDT", "binanceus", "15m")] });
      }
      if (cmd._type === "GetCommand") {
        const key = cmd.Key as { pair: string; window: string } | undefined;
        return Promise.resolve({ Item: makeSentimentItem(key?.pair ?? "BTC/USDT", key?.window ?? "4h") });
      }
      return Promise.resolve({});
    });

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("BTC/USDT");

    expect(result.cells.length).toBe(4); // 4 timeframes for 1 pair
    expect(result.generatedAt).toBeTruthy();

    const cell = result.cells[0];
    expect(cell.pair).toBe("BTC/USDT");
    expect(cell.indicator.rsi14).toBe(55.2);
    expect(cell.indicator.ema50).toBe(43000.5);
    expect(cell.indicator.ageSeconds).toBeGreaterThan(0);
    expect(cell.indicator.raw).toBeTruthy();

    expect(cell.signal.type).toBe("buy");
    expect(cell.signal.confidence).toBe(0.85);
    expect(cell.signal.ratificationStatus).toBe("ratified");
    expect(cell.signal.interpretationText).toBe("Strong upward momentum confirmed.");
    expect(cell.signal.ageSeconds).toBeGreaterThan(0);

    expect(cell.sentiment4h.score).toBe(0.65);
    expect(cell.sentiment4h.articleCount).toBe(7);
    expect(cell.sentiment4h.ageSeconds).toBeGreaterThan(0);

    expect(cell.sentiment24h.score).toBe(0.65);
  });

  it("returns null fields for empty cells — does not throw or 500", async () => {
    sendMock.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "QueryCommand") return Promise.resolve({ Items: [] });
      if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("BTC/USDT");

    expect(result.cells.length).toBe(4);
    const cell = result.cells[0];
    expect(cell.indicator.rsi14).toBeNull();
    expect(cell.indicator.ageSeconds).toBeNull();
    expect(cell.signal.type).toBeNull();
    expect(cell.signal.recentHistory).toEqual([]);
    expect(cell.sentiment4h.score).toBeNull();
  });

  it("returns all 5 pairs × 4 timeframes = 20 cells when no filter given", async () => {
    sendMock.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "QueryCommand") return Promise.resolve({ Items: [] });
      if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState();
    expect(result.cells.length).toBe(20); // 5 pairs × 4 timeframes
  });

  it("returns an empty cells array if filterPair does not match any configured pair", async () => {
    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("UNKNOWN/USDT");
    expect(result.cells.length).toBe(0);
  });

  it("truncates interpretationText to 160 chars", async () => {
    const longText = "A".repeat(300);
    sendMock.mockImplementation((cmd: { _type: string; KeyConditionExpression?: string }) => {
      if (cmd._type === "QueryCommand") {
        const expr = cmd.KeyConditionExpression ?? "";
        if (expr.includes("begins_with")) {
          return Promise.resolve({
            Items: [{
              pair: "BTC/USDT",
              sk: "15m#12345",
              type: "sell",
              confidence: 0.7,
              asOf: Date.now() - 1000,
              interpretation: { text: longText },
            }],
          });
        }
        return Promise.resolve({ Items: [] });
      }
      if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("BTC/USDT");
    const cell = result.cells[0];
    expect(cell.signal.interpretationText?.length).toBe(160);
  });

  it("surfaces up to 5 ratification history items", async () => {
    const historyItems = Array.from({ length: 5 }, (_, i) => ({
      pair: "ETH/USDT",
      sk: `15m#${100000 - i}`,
      type: "buy",
      confidence: 0.8,
      asOf: Date.now() - (i + 1) * 60_000,
      ratificationStatus: i === 0 ? "ratified" : "pending",
    }));

    sendMock.mockImplementation((cmd: { _type: string; KeyConditionExpression?: string }) => {
      if (cmd._type === "QueryCommand") {
        const expr = cmd.KeyConditionExpression ?? "";
        if (expr.includes("begins_with")) {
          return Promise.resolve({ Items: historyItems });
        }
        return Promise.resolve({ Items: [] });
      }
      if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("ETH/USDT");
    const cell = result.cells[0]; // 15m cell
    expect(cell.signal.recentHistory.length).toBe(5);
    expect(cell.signal.ratificationStatus).toBe("ratified");
  });

  it("handles DynamoDB errors gracefully — returns empty cell instead of throwing", async () => {
    sendMock.mockRejectedValue(new Error("DynamoDB unavailable"));

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("BTC/USDT");
    // All cells should still be returned with null values
    expect(result.cells.length).toBe(4);
    const cell = result.cells[0];
    expect(cell.indicator.raw).toBeNull();
    expect(cell.signal.type).toBeNull();
    expect(cell.sentiment4h.score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route integration test
// ---------------------------------------------------------------------------

describe("GET /pipeline-state route", () => {
  it("returns 200 with success envelope containing cells array", async () => {
    sendMock.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "QueryCommand") return Promise.resolve({ Items: [] });
      if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    // Build a minimal Hono app with just the admin route (without auth middleware)
    const { getPipelineState } = await import("./pipeline-state.service.js");
    const app = new Hono();
    app.get("/pipeline-state", async (c) => {
      const pair = c.req.query("pair");
      const data = await getPipelineState(pair);
      return c.json({ success: true, data });
    });

    const res = await app.request("/pipeline-state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { cells: unknown[]; generatedAt: string } };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.cells)).toBe(true);
    expect(body.data.generatedAt).toBeTruthy();
  });

  it("filters by pair query param", async () => {
    sendMock.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "QueryCommand") return Promise.resolve({ Items: [] });
      if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const app = new Hono();
    app.get("/pipeline-state", async (c) => {
      const pair = c.req.query("pair");
      const data = await getPipelineState(pair);
      return c.json({ success: true, data });
    });

    const res = await app.request("/pipeline-state?pair=BTC%2FUSDT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { cells: { pair: string }[] } };
    expect(body.data.cells.length).toBe(4);
    expect(body.data.cells.every((c) => c.pair === "BTC/USDT")).toBe(true);
  });
});
