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
    expect(result.text).toBe("EMA cross confirmed by RSI momentum and MACD histogram expansion.");
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

  it("degrades to algo-only when downgraded but algoVerdict is missing (#172 Copilot review)", () => {
    // The `llm-downgraded` source contract requires `originalAlgo`. If we
    // cannot honour that contract, fall back to algo-only rather than emit
    // a malformed interpretation that the UI cannot render the transition
    // line for.
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
    expect(result.source).toBe("algo-only");
    expect(result.originalAlgo).toBeUndefined();
  });
});

describe("buildInterpretation — algo-fallback detection (#172 codex finding)", () => {
  // When the LLM stream / API / validation fails, `invokeStage2Fallback` writes
  // `ratificationStatus: "ratified"` with `ratificationVerdict.source = "algo-fallback"`
  // so the signal leaves "pending". buildInterpretation must surface this as
  // algo-only — labelling it "LLM ratified" would be misleading.

  it("returns algo-only when verdict.source is 'algo-fallback' (graceful LLM failure)", () => {
    const result = buildInterpretation(
      base({
        ratificationStatus: "ratified",
        ratificationVerdict: {
          type: "buy",
          confidence: 0.65,
          reasoning: "ema_cross_bullish, rsi_oversold",
          source: "algo-fallback",
        },
      }),
    );
    expect(result.source).toBe("algo-only");
    // Falls back to the standard rulesFired summary, NOT the verdict.reasoning,
    // because the verdict text is just the algo rules already.
    expect(result.text).toBe("BTC/USDT: ema_cross_bullish + rsi_oversold");
  });

  it("returns llm-ratified when verdict.source is 'llm' (real LLM verdict)", () => {
    const result = buildInterpretation(
      base({
        ratificationStatus: "ratified",
        ratificationVerdict: {
          type: "buy",
          confidence: 0.78,
          reasoning: "Confirmed by macro and on-chain signals.",
          source: "llm",
        },
      }),
    );
    expect(result.source).toBe("llm-ratified");
    expect(result.text).toBe("Confirmed by macro and on-chain signals.");
  });

  it("treats absent source as 'llm' for back-compat with pre-B2 rows", () => {
    // Legacy ratified rows have no `source` field. Default to llm-ratified
    // so existing data continues to render correctly.
    const result = buildInterpretation(
      base({
        ratificationStatus: "ratified",
        ratificationVerdict: {
          type: "buy",
          confidence: 0.7,
          reasoning: "Legacy LLM verdict without a source tag.",
        },
      }),
    );
    expect(result.source).toBe("llm-ratified");
    expect(result.text).toBe("Legacy LLM verdict without a source tag.");
  });
});
