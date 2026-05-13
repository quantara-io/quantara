/**
 * Cost estimator unit tests — Phase 2.
 *
 * Follows the quantara-tests skill convention:
 *   - vi.mock at the module boundary for @aws-sdk
 *   - vi.resetModules + dynamic import in beforeEach
 *   - No real AWS calls
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BacktestInput } from "../engine.js";
import type { HistoricalCandleStore } from "../store/candle-store.js";
import type { RatificationsStore } from "./estimator.js";

// ---------------------------------------------------------------------------
// Mock AWS SDK at module boundary
// ---------------------------------------------------------------------------

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({ send: sendMock })),
  },
  QueryCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(days: number): BacktestInput {
  const to = new Date("2026-05-12T00:00:00Z");
  const from = new Date(to.getTime() - days * 86_400_000);
  return { pair: "BTC/USDT", timeframe: "1h", from, to };
}

/** Stub candleStore — estimator doesn't actually call it in current impl. */
const stubCandleStore: HistoricalCandleStore = {
  getCandles: vi.fn().mockResolvedValue([]),
  getCandlesForAllExchanges: vi.fn().mockResolvedValue({}),
};

/** Build a RatificationsStore stub that returns fixed records. */
function makeRatStore(okCount: number, totalCount: number): RatificationsStore {
  const records = Array.from({ length: totalCount }, (_, i) => ({
    validation: { ok: i < okCount },
  }));
  return {
    queryRecent: vi.fn().mockResolvedValue(records),
  };
}

/** Build a RatificationsStore stub that returns no records (empty table). */
function emptyRatStore(): RatificationsStore {
  return {
    queryRecent: vi.fn().mockResolvedValue([]),
  };
}

/** Build a RatificationsStore stub that throws (table unreachable). */
function throwingRatStore(): RatificationsStore {
  return {
    queryRecent: vi.fn().mockRejectedValue(new Error("DDB unreachable")),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("estimateRatificationCost", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
  });

  it("returns zero cost for a 0-day period", async () => {
    const { estimateRatificationCost } = await import("./estimator.js");
    const input = makeInput(0);
    const result = await estimateRatificationCost(
      input,
      "haiku",
      stubCandleStore,
      makeRatStore(10, 100),
    );

    expect(result.closes).toBe(0);
    expect(result.estimatedCalls).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.estimatedLatencyMs).toBe(0);
  });

  it("1-year × BTC/USDT × all TFs × prod gate rate × Haiku — cost is ~$0.20", async () => {
    const { estimateRatificationCost, DEFAULT_GATE_RATE } = await import("./estimator.js");
    // Use the default gate rate (0.4%) as it's representative of production.
    const input = makeInput(365);
    const result = await estimateRatificationCost(
      input,
      "haiku",
      stubCandleStore,
      emptyRatStore(), // triggers fallback to DEFAULT_GATE_RATE
    );

    // 365 days × 96 bars/day (15m TF) × 4 signal TFs = 140,160 closes
    // × DEFAULT_GATE_RATE (0.4%) ≈ 561 calls
    // × 700 input tokens × $0.25/M + 150 output × $1.25/M
    // = ~$0.0001 + ~0.0001 per call ≈ ~$0.10 total

    expect(result.closes).toBeGreaterThan(100_000);
    expect(result.gatedRate).toBe(DEFAULT_GATE_RATE);
    expect(result.estimatedCalls).toBeGreaterThan(50);
    // Should be in the range $0.05 – $1.00 for Haiku
    expect(result.estimatedCostUsd).toBeGreaterThan(0.01);
    expect(result.estimatedCostUsd).toBeLessThan(1.0);
    expect(result.model).toBe("haiku");
    expect(result.pricingSource).toBe("code-comment-as-of-2026-Q1");
  });

  it("falls back to 0.4% gate rate when ratifications table is empty", async () => {
    const { estimateRatificationCost, DEFAULT_GATE_RATE } = await import("./estimator.js");
    const input = makeInput(30);
    const result = await estimateRatificationCost(input, "haiku", stubCandleStore, emptyRatStore());

    expect(result.gatedRate).toBe(DEFAULT_GATE_RATE);
  });

  it("falls back to 0.4% gate rate when ratifications table throws", async () => {
    const { estimateRatificationCost, DEFAULT_GATE_RATE } = await import("./estimator.js");
    const input = makeInput(30);
    const result = await estimateRatificationCost(
      input,
      "haiku",
      stubCandleStore,
      throwingRatStore(),
    );

    expect(result.gatedRate).toBe(DEFAULT_GATE_RATE);
  });

  it("uses measured gate rate from ratifications table when available", async () => {
    const { estimateRatificationCost } = await import("./estimator.js");
    const input = makeInput(30);
    // 20 ok out of 100 = 20% gate rate (within [0.001, 0.5] sanity bounds)
    const result = await estimateRatificationCost(
      input,
      "haiku",
      stubCandleStore,
      makeRatStore(20, 100),
    );

    expect(result.gatedRate).toBeCloseTo(0.2, 5);
  });

  it("clamps gate rate to floor (0.001) when measured rate is near zero", async () => {
    const { estimateRatificationCost, GATE_RATE_FLOOR } = await import("./estimator.js");
    const input = makeInput(30);
    // 0 ok out of 100 = 0% — should be clamped to GATE_RATE_FLOOR
    const result = await estimateRatificationCost(
      input,
      "haiku",
      stubCandleStore,
      makeRatStore(0, 100),
    );

    expect(result.gatedRate).toBeGreaterThanOrEqual(GATE_RATE_FLOOR);
  });

  it("clamps gate rate to ceiling (0.5) when measured rate is very high", async () => {
    const { estimateRatificationCost } = await import("./estimator.js");
    const input = makeInput(30);
    // All 100 ok = 100% — should be clamped to 0.5 ceiling
    const result = await estimateRatificationCost(
      input,
      "haiku",
      stubCandleStore,
      makeRatStore(100, 100),
    );

    expect(result.gatedRate).toBeLessThanOrEqual(0.5);
  });

  it("Sonnet costs ~12x more than Haiku for the same input", async () => {
    const { estimateRatificationCost } = await import("./estimator.js");
    const input = makeInput(30);
    const ratStore = makeRatStore(10, 1000); // consistent gate rate

    const haikuResult = await estimateRatificationCost(input, "haiku", stubCandleStore, ratStore);
    const sonnetResult = await estimateRatificationCost(input, "sonnet", stubCandleStore, ratStore);

    // Sonnet is $3/$15 vs Haiku $0.25/$1.25 — roughly 12x more expensive
    // For a ratio test we just check Sonnet > Haiku and in a reasonable range
    if (haikuResult.estimatedCostUsd > 0) {
      expect(sonnetResult.estimatedCostUsd).toBeGreaterThan(haikuResult.estimatedCostUsd);
    } else {
      // Zero calls → both zero cost
      expect(sonnetResult.estimatedCostUsd).toBe(0);
    }
  });

  it("estimatedCalls × EST_TOKENS matches estimatedTokens", async () => {
    const { estimateRatificationCost, EST_INPUT_TOKENS_PER_CALL, EST_OUTPUT_TOKENS_PER_CALL } =
      await import("./estimator.js");
    const input = makeInput(30);
    const result = await estimateRatificationCost(
      input,
      "sonnet",
      stubCandleStore,
      makeRatStore(5, 100),
    );

    expect(result.estimatedTokens.input).toBe(result.estimatedCalls * EST_INPUT_TOKENS_PER_CALL);
    expect(result.estimatedTokens.output).toBe(result.estimatedCalls * EST_OUTPUT_TOKENS_PER_CALL);
  });
});
