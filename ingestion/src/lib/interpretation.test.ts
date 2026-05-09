/**
 * Tests for buildInterpretation — Phase B2 (#171).
 *
 * buildInterpretation is a pure function exported from @quantara/shared.
 * Tests are colocated here in ingestion (which has vitest) since
 * @quantara/shared has no test runner.
 */

import { describe, it, expect } from "vitest";
import { buildInterpretation } from "@quantara/shared";
import type { BlendedSignal } from "@quantara/shared";

type BuildInput = Pick<
  BlendedSignal,
  "ratificationStatus" | "ratificationVerdict" | "algoVerdict" | "rulesFired" | "pair" | "type"
>;

function base(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    pair: "BTC/USDT",
    type: "buy",
    rulesFired: ["ema_cross_bullish", "rsi_oversold"],
    ratificationStatus: null,
    ratificationVerdict: null,
    algoVerdict: null,
    ...overrides,
  };
}

describe("buildInterpretation — algo-only", () => {
  it("returns algo-only with rulesFired summary when ratificationStatus is null", () => {
    const result = buildInterpretation(base({ ratificationStatus: null }));
    expect(result.source).toBe("algo-only");
    expect(result.text).toBe("BTC/USDT: ema_cross_bullish + rsi_oversold");
    expect(result.originalAlgo).toBeUndefined();
  });

  it("returns algo-only when ratificationStatus is absent (undefined)", () => {
    const result = buildInterpretation(base({ ratificationStatus: undefined }));
    expect(result.source).toBe("algo-only");
    expect(result.text).toContain("BTC/USDT");
  });

  it("returns algo-only when ratificationStatus is 'not-required'", () => {
    const result = buildInterpretation(base({ ratificationStatus: "not-required" }));
    expect(result.source).toBe("algo-only");
    expect(result.text).toBe("BTC/USDT: ema_cross_bullish + rsi_oversold");
  });

  it("returns algo-only with fallback text when rulesFired is empty", () => {
    const result = buildInterpretation(base({ rulesFired: [], type: "sell" }));
    expect(result.source).toBe("algo-only");
    expect(result.text).toBe("BTC/USDT: sell");
  });

  it("includes pair name and rulesFired in the text summary", () => {
    const result = buildInterpretation(
      base({ pair: "ETH/USDT", rulesFired: ["macd_bullish", "bb_squeeze"] }),
    );
    expect(result.text).toBe("ETH/USDT: macd_bullish + bb_squeeze");
  });

  it("returns algo-only with 'Awaiting LLM ratification' hint when status is pending", () => {
    const result = buildInterpretation(base({ ratificationStatus: "pending" }));
    expect(result.source).toBe("algo-only");
    expect(result.text).toMatch(/Awaiting LLM ratification/);
    expect(result.text).toContain("BTC/USDT");
  });

  it("falls back to algo-only when ratificationStatus is 'ratified' but ratificationVerdict is null", () => {
    const result = buildInterpretation(
      base({ ratificationStatus: "ratified", ratificationVerdict: null }),
    );
    expect(result.source).toBe("algo-only");
  });

  it("falls back to algo-only when ratificationStatus is 'downgraded' but ratificationVerdict is null", () => {
    const result = buildInterpretation(
      base({ ratificationStatus: "downgraded", ratificationVerdict: null }),
    );
    expect(result.source).toBe("algo-only");
  });
});

describe("buildInterpretation — llm-ratified", () => {
  it("returns llm-ratified source with LLM reasoning as text", () => {
    const result = buildInterpretation(
      base({
        ratificationStatus: "ratified",
        ratificationVerdict: {
          type: "buy",
          confidence: 0.72,
          reasoning: "EMA cross confirmed by RSI momentum and MACD histogram expansion.",
        },
      }),
    );
    expect(result.source).toBe("llm-ratified");
    expect(result.text).toBe(
      "EMA cross confirmed by RSI momentum and MACD histogram expansion.",
    );
    expect(result.originalAlgo).toBeUndefined();
  });
});

describe("buildInterpretation — llm-downgraded", () => {
  it("returns llm-downgraded source with LLM reasoning as text", () => {
    const result = buildInterpretation(
      base({
        ratificationStatus: "downgraded",
        ratificationVerdict: {
          type: "hold",
          confidence: 0.5,
          reasoning: "LLM sees macro headwinds; downgrading buy to hold.",
        },
        algoVerdict: { type: "buy", confidence: 0.75, reasoning: "ema_cross_bullish" },
      }),
    );
    expect(result.source).toBe("llm-downgraded");
    expect(result.text).toBe("LLM sees macro headwinds; downgrading buy to hold.");
  });

  it("populates originalAlgo when algoVerdict is present", () => {
    const result = buildInterpretation(
      base({
        ratificationStatus: "downgraded",
        ratificationVerdict: {
          type: "hold",
          confidence: 0.5,
          reasoning: "Downgrade reasoning.",
        },
        algoVerdict: { type: "buy", confidence: 0.75, reasoning: "ema_cross_bullish" },
      }),
    );
    expect(result.originalAlgo).toEqual({
      type: "buy",
      confidence: 0.75,
      reasoning: "ema_cross_bullish",
    });
  });

  it("omits originalAlgo when algoVerdict is null", () => {
    const result = buildInterpretation(
      base({
        ratificationStatus: "downgraded",
        ratificationVerdict: {
          type: "hold",
          confidence: 0.5,
          reasoning: "Downgrade reasoning.",
        },
        algoVerdict: null,
      }),
    );
    expect(result.originalAlgo).toBeUndefined();
  });
});
