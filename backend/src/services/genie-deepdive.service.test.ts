import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted above variable declarations, so we declare the send spy
// using vi.fn() directly referenced through a module-level const that vitest
// also hoists. This mirrors the pattern used in admin.service.test.ts.
const dynamoSend = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: dynamoSend })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: dynamoSend }) },
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  BatchGetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "BatchGet", input })),
}));

vi.mock("@quantara/shared", () => ({
  PAIRS: ["BTC/USDT", "ETH/USDT"],
}));

beforeEach(() => {
  vi.resetModules();
  dynamoSend.mockReset();
  process.env.TABLE_PREFIX = "quantara-dev-";
  process.env.AWS_REGION = "us-west-2";
});

// ---------------------------------------------------------------------------
// Pure-function unit tests (no DDB I/O)
// ---------------------------------------------------------------------------

import {
  computeCalibration,
  MIN_BIN_SAMPLES,
  computePerRule,
  computeCoOccurrence,
  computeByVolatility,
  computeByHour,
} from "./genie-deepdive.math.js";

// Helper to build a minimal signal record.
function sig(
  signalId: string,
  confidence: number,
  rulesFired: string[],
  closeTime = 0,
  emittingTimeframe = "1h",
  pair = "BTC/USDT",
) {
  return { signalId, confidence, rulesFired, closeTime, emittingTimeframe, pair };
}

// ---------------------------------------------------------------------------
// computeCalibration
// ---------------------------------------------------------------------------

describe("computeCalibration", () => {
  // These tests use the static import whose MIN_BIN_SAMPLES is resolved at
  // module load time. In dev (ENVIRONMENT !== "prod") that value is 3.

  it("suppresses bins below MIN_BIN_SAMPLES (uses MIN_BIN_SAMPLES - 1 signals)", () => {
    // Build a bin with one fewer signal than the current threshold.
    const count = MIN_BIN_SAMPLES - 1;
    const signals = Array.from({ length: count }, (_, i) => sig(`s${i}`, 0.55, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(0);
  });

  it("includes bins with exactly MIN_BIN_SAMPLES signals", () => {
    const signals = Array.from({ length: MIN_BIN_SAMPLES }, (_, i) => sig(`s${i}`, 0.65, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].binMin).toBeCloseTo(0.6);
    expect(result[0].binMax).toBeCloseTo(0.7);
    expect(result[0].signalCount).toBe(MIN_BIN_SAMPLES);
    expect(result[0].winRate).toBe(1);
  });

  it("computes win rate correctly (6 wins out of 10)", () => {
    // 10 signals is always above the threshold in any env mode.
    const signals = Array.from({ length: 10 }, (_, i) => sig(`s${i}`, 0.75, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s, i) => [s.signalId, i < 6 ? "correct" : "incorrect"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].winRate).toBeCloseTo(0.6);
  });

  it("excludes neutral outcomes from win-rate calculation (directional count below threshold)", () => {
    // MIN_BIN_SAMPLES signals where only MIN_BIN_SAMPLES-1 are directional →
    // bin.count falls below the threshold and should be suppressed.
    const total = MIN_BIN_SAMPLES;
    const signals = Array.from({ length: total }, (_, i) => sig(`s${i}`, 0.25, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      // All neutral except the last one — directional count = 1, below threshold.
      signals.map((s, i) => [s.signalId, i === total - 1 ? "correct" : "neutral"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(0); // 1 directional < MIN_BIN_SAMPLES
  });

  it("produces separate bins for signals at different confidence levels", () => {
    // 10 signals per bin — always above threshold in both env modes.
    const low = Array.from({ length: 10 }, (_, i) => sig(`lo${i}`, 0.25, []));
    const high = Array.from({ length: 10 }, (_, i) => sig(`hi${i}`, 0.75, []));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ...low.map((s): [string, "correct"] => [s.signalId, "correct"]),
      ...high.map((s): [string, "incorrect"] => [s.signalId, "incorrect"]),
    ]);
    const result = computeCalibration([...low, ...high], outcomes);
    expect(result).toHaveLength(2);
    const lowBin = result.find((b) => b.binMin < 0.3)!;
    const highBin = result.find((b) => b.binMin >= 0.7)!;
    expect(lowBin.winRate).toBe(1);
    expect(highBin.winRate).toBe(0);
  });

  it("places confidence = 1.0 in the last bin (index 9)", () => {
    // 10 signals — above threshold in both env modes.
    const signals = Array.from({ length: 10 }, (_, i) => sig(`s${i}`, 1.0, []));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].binMin).toBeCloseTo(0.9);
    expect(result[0].binMax).toBeCloseTo(1.0);
  });

  it("computes avgConfidence correctly", () => {
    const confidences = [0.71, 0.72, 0.73, 0.74, 0.75, 0.76, 0.77, 0.78, 0.79, 0.7];
    const signals = confidences.map((c, i) => sig(`s${i}`, c, []));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(1);
    const expected = confidences.reduce((a, b) => a + b) / confidences.length;
    expect(result[0].avgConfidence).toBeCloseTo(expected, 5);
  });
});

// ---------------------------------------------------------------------------
// computeCalibration — env-aware MIN_BIN_SAMPLES behaviour
//
// These tests use vi.resetModules + dynamic import to load the math module
// under different ENVIRONMENT values, exercising both the dev (3) and prod
// (10) thresholds.
// ---------------------------------------------------------------------------

describe("computeCalibration — env-aware MIN_BIN_SAMPLES", () => {
  afterEach(() => {
    delete process.env.ENVIRONMENT;
    vi.resetModules();
  });

  it("returns a 3-sample bin in dev (ENVIRONMENT !== 'prod')", async () => {
    delete process.env.ENVIRONMENT; // not "prod" → MIN_BIN_SAMPLES = 3
    vi.resetModules();
    const { computeCalibration: calc } = await import("./genie-deepdive.math.js");

    const signals = Array.from({ length: 3 }, (_, i) => sig(`d${i}`, 0.55, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = calc(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].signalCount).toBe(3);
  });

  it("suppresses a 3-sample bin in prod (ENVIRONMENT === 'prod')", async () => {
    process.env.ENVIRONMENT = "prod"; // MIN_BIN_SAMPLES = 10
    vi.resetModules();
    const { computeCalibration: calc } = await import("./genie-deepdive.math.js");

    const signals = Array.from({ length: 3 }, (_, i) => sig(`p${i}`, 0.55, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = calc(signals, outcomes);
    expect(result).toHaveLength(0); // 3 < 10 → suppressed
  });

  it("includes a 5-sample bin in dev and suppresses it in prod", async () => {
    const makeSignals = () =>
      Array.from({ length: 5 }, (_, i) => sig(`e${i}`, 0.65, [], 0)).map((s) => ({
        ...s,
      }));
    const makeOutcomes = (signals: ReturnType<typeof makeSignals>) =>
      new Map<string, "correct" | "incorrect" | "neutral">(
        signals.map((s) => [s.signalId, "correct"]),
      );

    // Dev
    delete process.env.ENVIRONMENT;
    vi.resetModules();
    const { computeCalibration: calcDev } = await import("./genie-deepdive.math.js");
    const devSignals = makeSignals();
    expect(calcDev(devSignals, makeOutcomes(devSignals))).toHaveLength(1);

    // Prod
    process.env.ENVIRONMENT = "prod";
    vi.resetModules();
    const { computeCalibration: calcProd } = await import("./genie-deepdive.math.js");
    const prodSignals = makeSignals();
    expect(calcProd(prodSignals, makeOutcomes(prodSignals))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computePerRule
// ---------------------------------------------------------------------------

describe("computePerRule", () => {
  it("counts fire count per rule correctly", () => {
    const signals = [
      sig("s1", 0.7, ["rsi_oversold", "ema_cross"]),
      sig("s2", 0.6, ["rsi_oversold"]),
      sig("s3", 0.8, ["ema_cross"]),
    ];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s1", "correct"],
      ["s2", "incorrect"],
      ["s3", "correct"],
    ]);
    const result = computePerRule(signals, outcomes);
    const rsiRow = result.find((r) => r.rule === "rsi_oversold")!;
    const emaRow = result.find((r) => r.rule === "ema_cross")!;

    expect(rsiRow.fireCount).toBe(2);
    expect(emaRow.fireCount).toBe(2);
  });

  it("computes TP rate correctly for a hand-checked case", () => {
    // rsi_oversold fires on 4 signals: 3 correct, 1 incorrect → tpRate = 0.75
    const signals = [
      sig("s1", 0.7, ["rsi_oversold"]),
      sig("s2", 0.7, ["rsi_oversold"]),
      sig("s3", 0.7, ["rsi_oversold"]),
      sig("s4", 0.7, ["rsi_oversold"]),
    ];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s1", "correct"],
      ["s2", "correct"],
      ["s3", "correct"],
      ["s4", "incorrect"],
    ]);
    const result = computePerRule(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].tpRate).toBeCloseTo(0.75);
  });

  it("uses 0 tpRate when no directional outcomes are available", () => {
    const signals = [sig("s1", 0.5, ["volume_spike"])];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([["s1", "neutral"]]);
    const result = computePerRule(signals, outcomes);
    expect(result[0].tpRate).toBe(0);
  });

  it("computes avgConfidence per rule", () => {
    const signals = [sig("s1", 0.6, ["macd_cross"]), sig("s2", 0.8, ["macd_cross"])];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s1", "correct"],
      ["s2", "correct"],
    ]);
    const result = computePerRule(signals, outcomes);
    expect(result[0].avgConfidence).toBeCloseTo(0.7);
  });

  it("returns rows sorted by fireCount descending", () => {
    const signals = [
      sig("s1", 0.5, ["rare_rule"]),
      sig("s2", 0.5, ["common_rule"]),
      sig("s3", 0.5, ["common_rule"]),
    ];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">();
    const result = computePerRule(signals, outcomes);
    expect(result[0].rule).toBe("common_rule");
    expect(result[1].rule).toBe("rare_rule");
  });
});

// ---------------------------------------------------------------------------
// computeCoOccurrence
// ---------------------------------------------------------------------------

describe("computeCoOccurrence", () => {
  it("detects pairwise co-occurrence (not 3-way)", () => {
    // signal with 3 rules → 3 pairs, not 1 triple
    const signals = [sig("s1", 0.7, ["A", "B", "C"]), sig("s2", 0.7, ["A", "B", "C"])];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s1", "correct"],
      ["s2", "correct"],
    ]);
    const result = computeCoOccurrence(signals, outcomes);
    // Expect exactly 3 pairs: (A,B), (A,C), (B,C)
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.rules.length === 2)).toBe(true);
  });

  it("computes tpRateWhenJoint correctly", () => {
    const signals = [
      sig("s1", 0.7, ["X", "Y"]),
      sig("s2", 0.7, ["X", "Y"]),
      sig("s3", 0.7, ["X", "Y"]),
      sig("s4", 0.7, ["X", "Y"]),
    ];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s1", "correct"],
      ["s2", "correct"],
      ["s3", "incorrect"],
      ["s4", "incorrect"],
    ]);
    const result = computeCoOccurrence(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].tpRateWhenJoint).toBeCloseTo(0.5);
  });

  it("uses canonical (sorted) key so (A,B) and (B,A) are the same pair", () => {
    const signals = [sig("s1", 0.7, ["Z", "A"]), sig("s2", 0.7, ["A", "Z"])];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s1", "correct"],
      ["s2", "correct"],
    ]);
    const result = computeCoOccurrence(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].jointCount).toBe(2);
    expect(result[0].rules).toEqual(["A", "Z"]);
  });

  it("suppresses pairs with jointCount < 2", () => {
    const signals = [sig("s1", 0.7, ["A", "B"])]; // only 1 co-occurrence
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([["s1", "correct"]]);
    const result = computeCoOccurrence(signals, outcomes);
    expect(result).toHaveLength(0);
  });

  it("skips signals with only one rule", () => {
    const signals = [sig("s1", 0.7, ["lone_rule"]), sig("s2", 0.7, ["lone_rule"])];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s1", "correct"],
      ["s2", "correct"],
    ]);
    const result = computeCoOccurrence(signals, outcomes);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeByHour
// ---------------------------------------------------------------------------

describe("computeByHour", () => {
  it("buckets signals by UTC hour of closeTime", () => {
    const midnight = new Date("2026-01-01T00:00:00Z").getTime();
    const noon = new Date("2026-01-01T12:00:00Z").getTime();

    const signals = [
      sig("s1", 0.7, [], midnight),
      sig("s2", 0.7, [], midnight),
      sig("s3", 0.7, [], noon),
    ];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s1", "correct"],
      ["s2", "incorrect"],
      ["s3", "correct"],
    ]);
    const result = computeByHour(signals, outcomes);
    const hour0 = result.find((b) => b.utcHour === 0)!;
    const hour12 = result.find((b) => b.utcHour === 12)!;

    expect(hour0.signalCount).toBe(2);
    expect(hour0.winRate).toBeCloseTo(0.5);
    expect(hour12.signalCount).toBe(1);
    expect(hour12.winRate).toBe(1);
  });

  it("omits hours with no signals", () => {
    const noon = new Date("2026-01-01T12:00:00Z").getTime();
    const signals = [sig("s1", 0.7, [], noon)];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([["s1", "correct"]]);
    const result = computeByHour(signals, outcomes);
    expect(result.every((b) => b.signalCount > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeByVolatility
// ---------------------------------------------------------------------------

describe("computeByVolatility", () => {
  it("returns empty array when no ATR data is available", () => {
    const signals = [sig("s1", 0.7, [], 0)];
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([["s1", "correct"]]);
    const atrMap = new Map<string, number | null>([["BTC/USDT#1h#0", null]]);
    const result = computeByVolatility(signals, outcomes, atrMap);
    expect(result).toHaveLength(0);
  });

  it("assigns signals to correct ATR quartile buckets", () => {
    // ATR values: [10, 20, 30, 40] → q25=10, q50=20, q75=30
    const times = [1000, 2000, 3000, 4000];
    const atrs = [10, 20, 30, 40];
    const signals = times.map((t, i) => sig(`s${i}`, 0.7, [], t));
    const atrMap = new Map(times.map((t, i) => [`BTC/USDT#1h#${t}`, atrs[i]]));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeByVolatility(signals, outcomes, atrMap);
    // Should produce 4 buckets, each with 1 signal.
    expect(result).toHaveLength(4);
    expect(result.map((b) => b.signalCount)).toEqual([1, 1, 1, 1]);
  });

  it("computes win rate per bucket", () => {
    // 8 ATR samples evenly spread; with nearest-rank percentile (ceil(p/100*n)-1)
    // q25=values[1], q50=values[3], q75=values[5]. Top quartile ( atr > q75 )
    // holds 2 samples: 1 win + 1 loss → 50%.
    const times = [100, 200, 300, 400, 500, 600, 700, 800];
    const atrs = [5, 10, 15, 20, 25, 30, 40, 50];
    const signals = times.map((t, i) => sig(`s${i}`, 0.7, [], t));
    const atrMap = new Map<string, number | null>(
      times.map((t, i) => [`BTC/USDT#1h#${t}`, atrs[i]]),
    );
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s0", "correct"],
      ["s1", "correct"],
      ["s2", "correct"],
      ["s3", "correct"],
      ["s4", "correct"],
      ["s5", "correct"],
      ["s6", "correct"], // top quartile: win
      ["s7", "incorrect"], // top quartile: loss
    ]);
    const result = computeByVolatility(signals, outcomes, atrMap);
    const highBucket = result.find((b) => b.atrPercentile === 75)!;
    expect(highBucket).toBeDefined();
    expect(highBucket.signalCount).toBe(2);
    expect(highBucket.winRate).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// DynamoDB fetch layer — assert QueryCommand inputs
//
// These tests use the dynamoSend mock declared at the top of the file. They
// guard against schema drift (wrong key names, wrong table refs, wrong filter
// expressions) and the per-signal fan-out regression (one Query per signal
// vs. one Query per (pair, tf) group).
// ---------------------------------------------------------------------------

describe("getGenieDeepDive — DDB fetch layer", () => {
  it("queries indicator_state with the real range key (asOf), not asOfMs", async () => {
    const closeMs = Date.parse("2026-04-15T00:00:00.000Z");
    dynamoSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      const table = cmd.input.TableName as string;
      if (table === "quantara-dev-signals-v2") {
        return Promise.resolve({
          Items: [
            {
              pair: "BTC/USDT",
              signalId: "s1",
              confidence: 0.7,
              rulesFired: ["r1"],
              closeTime: closeMs,
            },
          ],
        });
      }
      if (table === "quantara-dev-signal-outcomes") {
        return Promise.resolve({ Items: [] });
      }
      if (table === "quantara-dev-indicator-state") {
        return Promise.resolve({
          Items: [{ asOf: "2026-04-15T00:00:00.000Z", atr14: 42 }],
        });
      }
      return Promise.resolve({ Items: [] });
    });

    const { getGenieDeepDive } = await import("./genie-deepdive.service.js");
    await getGenieDeepDive("2026-04-01T00:00:00.000Z", "BTC/USDT", "1h");

    const indicatorCall = dynamoSend.mock.calls.find(
      (c) => (c[0].input as Record<string, unknown>).TableName === "quantara-dev-indicator-state",
    );
    expect(indicatorCall).toBeDefined();
    const indicatorInput = indicatorCall![0].input as Record<string, unknown>;
    const exprNames = indicatorInput.ExpressionAttributeNames as Record<string, string>;
    // The KeyConditionExpression's sort key alias must resolve to `asOf`,
    // NOT `asOfMs`. `asOfMs` is a non-key attribute and would Query nothing.
    expect(exprNames["#sk"]).toBe("asOf");
    expect(exprNames["#pk"]).toBe("pk");
    const exprValues = indicatorInput.ExpressionAttributeValues as Record<string, unknown>;
    expect(typeof exprValues[":since"]).toBe("string");
    expect(typeof exprValues[":until"]).toBe("string");
    expect(exprValues[":pk"]).toBe("BTC/USDT#consensus#1h");
  });

  it("issues one indicator-state Query per (pair, tf) group, not per signal", async () => {
    const baseTime = Date.parse("2026-04-15T00:00:00.000Z");
    const signals = Array.from({ length: 5 }, (_, i) => ({
      pair: "BTC/USDT",
      signalId: `s${i}`,
      confidence: 0.7,
      rulesFired: ["r1"],
      closeTime: baseTime + i * 3600_000,
    }));

    dynamoSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      const table = cmd.input.TableName as string;
      if (table === "quantara-dev-signals-v2") {
        return Promise.resolve({ Items: signals });
      }
      return Promise.resolve({ Items: [] });
    });

    const { getGenieDeepDive } = await import("./genie-deepdive.service.js");
    await getGenieDeepDive("2026-04-01T00:00:00.000Z", "BTC/USDT", "1h");

    const indicatorCalls = dynamoSend.mock.calls.filter(
      (c) => (c[0].input as Record<string, unknown>).TableName === "quantara-dev-indicator-state",
    );
    // 5 signals, 1 (pair, tf) group → exactly 1 Query.
    // Regression guard: the original code issued one Query per closeTime.
    expect(indicatorCalls).toHaveLength(1);
  });

  it("queries signals_v2 with the canonical (pair, sk-prefix) shape", async () => {
    dynamoSend.mockResolvedValue({ Items: [] });

    const { getGenieDeepDive } = await import("./genie-deepdive.service.js");
    await getGenieDeepDive("2026-04-01T00:00:00.000Z", "BTC/USDT", "1h");

    const signalsCall = dynamoSend.mock.calls.find(
      (c) => (c[0].input as Record<string, unknown>).TableName === "quantara-dev-signals-v2",
    );
    expect(signalsCall).toBeDefined();
    const input = signalsCall![0].input as Record<string, unknown>;
    expect(input.KeyConditionExpression).toBe("#pair = :pair AND #sk BETWEEN :lo AND :hi");
    const names = input.ExpressionAttributeNames as Record<string, string>;
    expect(names["#pair"]).toBe("pair");
    expect(names["#sk"]).toBe("sk");
  });

  it("reads signal_outcomes via BatchGetItem keyed on (pair, signalId)", async () => {
    const closeMs = Date.parse("2026-04-15T00:00:00.000Z");
    dynamoSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      // Signals query — return one signal so a BatchGet is issued.
      if (cmd.input.TableName === "quantara-dev-signals-v2") {
        return Promise.resolve({
          Items: [
            {
              pair: "BTC/USDT",
              signalId: "sig-abc",
              confidence: 0.7,
              rulesFired: ["r1"],
              closeTime: closeMs,
            },
          ],
        });
      }
      // Indicator state — empty.
      if (cmd.input.TableName === "quantara-dev-indicator-state") {
        return Promise.resolve({ Items: [] });
      }
      // BatchGet on signal-outcomes — return Responses map.
      if (cmd.input.RequestItems !== undefined) {
        return Promise.resolve({
          Responses: { "quantara-dev-signal-outcomes": [] },
        });
      }
      return Promise.resolve({ Items: [] });
    });

    const { getGenieDeepDive } = await import("./genie-deepdive.service.js");
    await getGenieDeepDive("2026-04-01T00:00:00.000Z", "BTC/USDT", "1h");

    const batchGetCall = dynamoSend.mock.calls.find(
      (c) => (c[0].input as Record<string, unknown>).RequestItems !== undefined,
    );
    expect(batchGetCall).toBeDefined();
    const input = batchGetCall![0].input as Record<string, unknown>;
    const requestItems = input.RequestItems as Record<
      string,
      { Keys: { pair: string; signalId: string }[] }
    >;
    const tableEntry = requestItems["quantara-dev-signal-outcomes"];
    expect(tableEntry).toBeDefined();
    expect(tableEntry.Keys).toEqual([{ pair: "BTC/USDT", signalId: "sig-abc" }]);
  });

  it("skips signals_v2 rows missing a non-empty signalId", async () => {
    const closeMs = Date.parse("2026-04-15T00:00:00.000Z");
    dynamoSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (cmd.input.TableName === "quantara-dev-signals-v2") {
        return Promise.resolve({
          Items: [
            // Valid row.
            {
              pair: "BTC/USDT",
              signalId: "good",
              confidence: 0.7,
              rulesFired: ["r1"],
              closeTime: closeMs,
            },
            // Empty signalId — must be skipped.
            {
              pair: "BTC/USDT",
              signalId: "",
              confidence: 0.7,
              rulesFired: ["r1"],
              closeTime: closeMs,
            },
            // Missing signalId attribute — must be skipped.
            {
              pair: "BTC/USDT",
              confidence: 0.7,
              rulesFired: ["r1"],
              closeTime: closeMs,
            },
          ],
        });
      }
      if (cmd.input.RequestItems !== undefined) {
        return Promise.resolve({ Responses: { "quantara-dev-signal-outcomes": [] } });
      }
      return Promise.resolve({ Items: [] });
    });

    const { getGenieDeepDive } = await import("./genie-deepdive.service.js");
    await getGenieDeepDive("2026-04-01T00:00:00.000Z", "BTC/USDT", "1h");

    const batchGetCall = dynamoSend.mock.calls.find(
      (c) => (c[0].input as Record<string, unknown>).RequestItems !== undefined,
    );
    expect(batchGetCall).toBeDefined();
    const input = batchGetCall![0].input as Record<string, unknown>;
    const requestItems = input.RequestItems as Record<
      string,
      { Keys: { pair: string; signalId: string }[] }
    >;
    // Only the "good" signalId should reach BatchGet.
    expect(requestItems["quantara-dev-signal-outcomes"].Keys).toEqual([
      { pair: "BTC/USDT", signalId: "good" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Percentile boundary regression
// ---------------------------------------------------------------------------

describe("computeByVolatility — nearest-rank percentile", () => {
  it("places n=4 ATR samples one per quartile bucket", () => {
    // Pre-fix Math.floor((p/100)*n) put p=25,n=4 at index 1 (= 20), shifting
    // boundaries so the 10-ATR sample landed in bucket 1 instead of bucket 0.
    // Nearest-rank ceil((p/100)*n)-1 puts q25 at index 0 (= 10), q50 at 1 (= 20),
    // q75 at 2 (= 30), exactly one sample per bucket.
    const times = [1000, 2000, 3000, 4000];
    const atrs = [10, 20, 30, 40];
    const signals = times.map((t, i) => sig(`s${i}`, 0.7, [], t));
    const atrMap = new Map(times.map((t, i) => [`BTC/USDT#1h#${t}`, atrs[i]]));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeByVolatility(signals, outcomes, atrMap);
    // Expect 4 buckets, one signal each.
    expect(result.map((b) => b.signalCount)).toEqual([1, 1, 1, 1]);
  });

  it("places n=100 ATR samples evenly across quartiles", () => {
    // 100 distinct ATR values 1..100. Nearest-rank gives q25=25, q50=50, q75=75.
    // With `<=` boundaries each bucket gets exactly 25 samples.
    const times = Array.from({ length: 100 }, (_, i) => i + 1);
    const atrs = times; // ATR equals time index for simplicity
    const signals = times.map((t, i) => sig(`s${i}`, 0.7, [], t));
    const atrMap = new Map(times.map((t, i) => [`BTC/USDT#1h#${t}`, atrs[i]]));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeByVolatility(signals, outcomes, atrMap);
    expect(result.map((b) => b.signalCount)).toEqual([25, 25, 25, 25]);
  });
});
