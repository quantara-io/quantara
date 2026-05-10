import { describe, it, expect, vi, beforeEach } from "vitest";

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
  it("suppresses bins with fewer than 10 signals", () => {
    // 9 signals in the 0.5-0.6 bin — should be suppressed.
    const signals = Array.from({ length: 9 }, (_, i) => sig(`s${i}`, 0.55, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(0);
  });

  it("includes bins with exactly 10 signals", () => {
    const signals = Array.from({ length: 10 }, (_, i) => sig(`s${i}`, 0.65, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s) => [s.signalId, "correct"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].binMin).toBeCloseTo(0.6);
    expect(result[0].binMax).toBeCloseTo(0.7);
    expect(result[0].signalCount).toBe(10);
    expect(result[0].winRate).toBe(1);
  });

  it("computes win rate correctly (6 wins out of 10)", () => {
    const signals = Array.from({ length: 10 }, (_, i) => sig(`s${i}`, 0.75, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s, i) => [s.signalId, i < 6 ? "correct" : "incorrect"]),
    );
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(1);
    expect(result[0].winRate).toBeCloseTo(0.6);
  });

  it("excludes neutral outcomes from win-rate calculation", () => {
    // 10 signals: 5 correct, 5 neutral → winRate = 5/5 = 1 (neutral excluded)
    const signals = Array.from({ length: 10 }, (_, i) => sig(`s${i}`, 0.25, [], 0));
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">(
      signals.map((s, i) => [s.signalId, i < 5 ? "correct" : "neutral"]),
    );
    // Only 5 directional → bin has 10 signalCount but winRate based on 5
    // Wait — computeCalibration counts only directional towards bin.count.
    // Check: bin count should be 5 (only directional), below threshold → suppressed.
    const result = computeCalibration(signals, outcomes);
    expect(result).toHaveLength(0); // 5 directional < 10 minimum
  });

  it("produces separate bins for signals at different confidence levels", () => {
    // 10 signals in 0.2-0.3, 10 signals in 0.7-0.8
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
    // Two signals in the highest ATR quartile: 1 win, 1 loss → 50%.
    // ATR values need to span full range so bucket assignment is unambiguous.
    const t1 = 100;
    const t2 = 200;
    const t3 = 300;
    const t4 = 400;
    const t5 = 500;
    const signals = [t1, t2, t3, t4, t5].map((t, i) => sig(`s${i}`, 0.7, [], t));
    // ATRs: 5, 10, 15, 40, 45 → q25=5, q50=10, q75=15 → bucket 3 gets s3 and s4
    const atrMap = new Map<string, number | null>([
      [`BTC/USDT#1h#${t1}`, 5],
      [`BTC/USDT#1h#${t2}`, 10],
      [`BTC/USDT#1h#${t3}`, 15],
      [`BTC/USDT#1h#${t4}`, 40],
      [`BTC/USDT#1h#${t5}`, 45],
    ]);
    const outcomes = new Map<string, "correct" | "incorrect" | "neutral">([
      ["s0", "correct"],
      ["s1", "correct"],
      ["s2", "correct"],
      ["s3", "correct"],
      ["s4", "incorrect"],
    ]);
    const result = computeByVolatility(signals, outcomes, atrMap);
    const highBucket = result.find((b) => b.atrPercentile === 75)!;
    expect(highBucket).toBeDefined();
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

  it("queries signal_outcomes with createdAt filter", async () => {
    dynamoSend.mockResolvedValue({ Items: [] });

    const { getGenieDeepDive } = await import("./genie-deepdive.service.js");
    await getGenieDeepDive("2026-04-01T00:00:00.000Z", "BTC/USDT", "1h");

    const outcomesCall = dynamoSend.mock.calls.find(
      (c) => (c[0].input as Record<string, unknown>).TableName === "quantara-dev-signal-outcomes",
    );
    expect(outcomesCall).toBeDefined();
    const input = outcomesCall![0].input as Record<string, unknown>;
    expect(input.FilterExpression).toBe("#createdAt BETWEEN :since AND :until");
  });
});
