import { describe, it, expect, vi, beforeEach } from "vitest";

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

// indicator-handler writes only consensus-exchange rows in production —
// fixtures match that.
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
  // signals_v2 rows persist `ratificationVerdict` (with `source`) and
  // `algoVerdict` / `rulesFired`, NOT a top-level `interpretation` field.
  // The service materialises interpretationText via `buildInterpretation`
  // on read.
  return {
    pair,
    sk: `${timeframe}#${Date.now()}`,
    signalId: "abc123",
    type: "buy",
    confidence: 0.85,
    ratificationStatus: "ratified",
    ratificationVerdict: {
      type: "buy",
      confidence: 0.85,
      reasoning: "Strong upward momentum confirmed.",
      source: "llm",
    },
    rulesFired: ["rsi-oversold", "ema-cross"],
    asOf: Date.now() - 120_000, // 2 minutes ago
    emittedAt: new Date(Date.now() - 120_000).toISOString(),
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
    sendMock.mockImplementation(
      (cmd: {
        _type: string;
        KeyConditionExpression?: string;
        Key?: { pair?: string; window?: string };
      }) => {
        if (cmd._type === "QueryCommand") {
          // Determine if this is an indicator or signal query by key expression shape.
          const expr = cmd.KeyConditionExpression ?? "";
          if (expr.includes("begins_with")) {
            // signals-v2 query
            return Promise.resolve({ Items: [makeSignalItem("BTC/USDT", "15m")] });
          }
          // indicator-state query — production rows are consensus-exchange.
          return Promise.resolve({ Items: [makeIndicatorItem("BTC/USDT", "consensus", "15m")] });
        }
        if (cmd._type === "GetCommand") {
          const key = cmd.Key as { pair: string; window: string } | undefined;
          // sentiment_aggregates is keyed by base symbol ("BTC"), not "BTC/USDT".
          return Promise.resolve({
            Item: makeSentimentItem(key?.pair ?? "BTC", key?.window ?? "4h"),
          });
        }
        return Promise.resolve({});
      },
    );

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("BTC/USDT");

    expect(result.cells.length).toBe(5); // 4 real timeframes + consensus
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

    expect(result.cells.length).toBe(5); // 4 real timeframes + consensus
    const cell = result.cells[0];
    expect(cell.indicator.rsi14).toBeNull();
    expect(cell.indicator.ageSeconds).toBeNull();
    expect(cell.signal.type).toBeNull();
    expect(cell.signal.recentHistory).toEqual([]);
    expect(cell.sentiment4h.score).toBeNull();
  });

  it("returns all 5 pairs × 5 timeframes (incl. consensus) = 25 cells when no filter given", async () => {
    sendMock.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "QueryCommand") return Promise.resolve({ Items: [] });
      if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState();
    expect(result.cells.length).toBe(25); // 5 pairs × (15m / 1h / 4h / 1d / consensus)
  });

  it("looks up sentiment by base symbol, not trading pair", async () => {
    // Aggregator stores rows under `pair: "BTC"`, not `pair: "BTC/USDT"`.
    // The service must derive the base symbol before calling GetCommand or
    // every cell silently shows null sentiment.
    const sentimentKeysSeen: { pair: string; window: string }[] = [];
    sendMock.mockImplementation(
      (cmd: { _type: string; Key?: { pair?: string; window?: string } }) => {
        if (cmd._type === "GetCommand") {
          const key = cmd.Key as { pair: string; window: string };
          sentimentKeysSeen.push({ pair: key.pair, window: key.window });
          return Promise.resolve({ Item: undefined });
        }
        if (cmd._type === "QueryCommand") return Promise.resolve({ Items: [] });
        return Promise.resolve({});
      },
    );

    const { getPipelineState } = await import("./pipeline-state.service.js");
    await getPipelineState("BTC/USDT");
    expect(sentimentKeysSeen.every((k) => k.pair === "BTC")).toBe(true);
    expect(sentimentKeysSeen.length).toBe(2);
    expect(sentimentKeysSeen.map((k) => k.window).sort()).toEqual(["24h", "4h"]);
  });

  it("queries indicator_state with `consensus` exchange, not a per-exchange value", async () => {
    // indicator-handler only writes consensus-exchange rows; querying
    // `binanceus` returns nothing.
    const indicatorPksSeen: string[] = [];
    sendMock.mockImplementation(
      (cmd: {
        _type: string;
        ExpressionAttributeValues?: Record<string, string>;
        KeyConditionExpression?: string;
      }) => {
        if (cmd._type === "QueryCommand") {
          const expr = cmd.KeyConditionExpression ?? "";
          const pk = cmd.ExpressionAttributeValues?.[":pk"];
          // indicator_state queries use `#pk = :pk`; signals_v2 uses `#pair = :pair`
          if (expr.includes("#pk") && pk) indicatorPksSeen.push(pk);
          return Promise.resolve({ Items: [] });
        }
        if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
        return Promise.resolve({});
      },
    );

    const { getPipelineState } = await import("./pipeline-state.service.js");
    await getPipelineState("BTC/USDT");
    // Every indicator_state query for the BTC/USDT cells must hit the
    // consensus-exchange path.
    expect(indicatorPksSeen.length).toBeGreaterThan(0);
    expect(indicatorPksSeen.every((pk) => pk.startsWith("BTC/USDT#consensus#"))).toBe(true);
  });

  it("fetches sentiment per-pair (not per-pair-per-tf)", async () => {
    // 5 timeframes × 1 pair = 5 cells. Sentiment is per-pair, so the
    // GetCommand for sentiment_aggregates should fire exactly twice for the
    // single pair (4h + 24h windows), not 10 times (twice per cell).
    let getCount = 0;
    sendMock.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetCommand") {
        getCount += 1;
        return Promise.resolve({ Item: undefined });
      }
      if (cmd._type === "QueryCommand") return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    const { getPipelineState } = await import("./pipeline-state.service.js");
    await getPipelineState("BTC/USDT");
    expect(getCount).toBe(2); // 4h + 24h, fetched once per pair
  });

  it("derives the `consensus` cell from the freshest per-tf signal (NOT reverse-lex sk order)", async () => {
    // Per-tf signals: 4h is OLDEST, 15m is FRESHEST.
    // The previous implementation issued a Query without tfPrefix and took
    // the first reverse-lex row, which sorts alphabetically by tf prefix
    // (4h > 1h > 1d > 15m) and would have surfaced the stale 4h row.
    // The new behaviour picks max-asOf across the per-tf signals.
    const now = Date.now();
    const signalsByTf: Record<string, { type: string; asOf: number }> = {
      "15m": { type: "buy", asOf: now - 60_000 }, // FRESHEST
      "1h": { type: "hold", asOf: now - 600_000 },
      "4h": { type: "sell", asOf: now - 3_600_000 }, // OLDEST
      "1d": { type: "hold", asOf: now - 7_200_000 },
    };

    sendMock.mockImplementation(
      (cmd: {
        _type: string;
        KeyConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, string>;
      }) => {
        if (cmd._type === "QueryCommand") {
          const expr = cmd.KeyConditionExpression ?? "";
          // signals_v2 query is per-tf via begins_with(sk, "<tf>#").
          if (expr.includes("begins_with")) {
            const tfPrefix = cmd.ExpressionAttributeValues?.[":tfPrefix"] ?? "";
            const tf = tfPrefix.replace(/#$/, "");
            const sig = signalsByTf[tf];
            if (sig) {
              return Promise.resolve({
                Items: [
                  {
                    pair: "BTC/USDT",
                    sk: `${tf}#${sig.asOf}`,
                    type: sig.type,
                    confidence: 0.7,
                    asOf: sig.asOf,
                  },
                ],
              });
            }
          }
          return Promise.resolve({ Items: [] });
        }
        if (cmd._type === "GetCommand") return Promise.resolve({ Item: undefined });
        return Promise.resolve({});
      },
    );

    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("BTC/USDT");
    const consensusCell = result.cells.find((c) => c.timeframe === "consensus");
    expect(consensusCell).toBeDefined();
    // Max-asOf across the four real-tf signals is 15m → "buy".
    expect(consensusCell?.signal.type).toBe("buy");
  });

  it("returns an empty cells array if filterPair does not match any configured pair", async () => {
    const { getPipelineState } = await import("./pipeline-state.service.js");
    const result = await getPipelineState("UNKNOWN/USDT");
    expect(result.cells.length).toBe(0);
  });

  it("truncates interpretationText to 160 chars", async () => {
    // signals_v2 rows do NOT persist a top-level `interpretation` field —
    // the service runs `buildInterpretation` on read. A long
    // ratificationVerdict.reasoning on a "ratified" row with source="llm"
    // produces a long interpretation.text, which the service truncates.
    const longText = "A".repeat(300);
    sendMock.mockImplementation((cmd: { _type: string; KeyConditionExpression?: string }) => {
      if (cmd._type === "QueryCommand") {
        const expr = cmd.KeyConditionExpression ?? "";
        if (expr.includes("begins_with")) {
          return Promise.resolve({
            Items: [
              {
                pair: "BTC/USDT",
                sk: "15m#12345",
                type: "sell",
                confidence: 0.7,
                asOf: Date.now() - 1000,
                ratificationStatus: "ratified",
                ratificationVerdict: {
                  type: "sell",
                  confidence: 0.7,
                  reasoning: longText,
                  source: "llm",
                },
                rulesFired: ["rsi-overbought"],
              },
            ],
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

  it("computes interpretationText via buildInterpretation for algoOnly rows (no ratificationVerdict)", async () => {
    // An algo-only row has no ratificationVerdict / ratificationStatus —
    // the previous implementation would fall back to null. With
    // buildInterpretation, the cell gets a rules-summary string built from
    // pair + rulesFired.
    sendMock.mockImplementation((cmd: { _type: string; KeyConditionExpression?: string }) => {
      if (cmd._type === "QueryCommand") {
        const expr = cmd.KeyConditionExpression ?? "";
        if (expr.includes("begins_with")) {
          return Promise.resolve({
            Items: [
              {
                pair: "BTC/USDT",
                sk: "15m#12345",
                type: "buy",
                confidence: 0.6,
                asOf: Date.now() - 1000,
                rulesFired: ["rsi-oversold", "ema-cross"],
                // No ratificationStatus / ratificationVerdict — algo-only.
              },
            ],
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
    expect(cell.signal.interpretationText).toBe("BTC/USDT: rsi-oversold + ema-cross");
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
    expect(result.cells.length).toBe(5); // 4 real timeframes + consensus
    const cell = result.cells[0];
    expect(cell.indicator.raw).toBeNull();
    expect(cell.signal.type).toBeNull();
    expect(cell.sentiment4h.score).toBeNull();
  });
});

// Note: route-level tests for `/pipeline-state` (auth + middleware + 400 on
// bad pair, etc.) live in `backend/src/routes/admin.test.ts` so they exercise
// the real `admin.ts` handler chain. This file is service-unit-only.
