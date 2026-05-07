/**
 * Unit tests for the multi-horizon blender (Phase 3).
 *
 * Covers:
 *   - §5 golden worked example (buy: 15m=hold, 1h=buy 0.68, 4h=buy 0.72, 1d=hold)
 *   - All-null case returns null
 *   - All-hold case returns type="hold" with confidence ≤ 1.0
 *   - Single-source (3 of 4 TFs null) applies 0.7 damping; renormalized weight = 1.0
 *   - Volatility/dispersion/stale cascade forces gated hold with highest-priority reason
 *   - Mixed gates (vol + stale) → highest-priority wins
 *   - weightsUsed sums to 1.0 for non-null paths
 *   - isTrivialChange: trivial and non-trivial cases
 *   - No mutation of input vote map (structuredClone + toEqual)
 *   - Edge: all 4 TFs vote with non-zero weights, sell path, exact threshold boundaries
 */

import { describe, it, expect } from "vitest";
import { blendTimeframeVotes, isTrivialChange, DEFAULT_TIMEFRAME_WEIGHTS, BLEND_THRESHOLD_T } from "./blend.js";
import type { BlendedSignal } from "@quantara/shared";
import type { TimeframeVote } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal non-gated TimeframeVote. */
function makeVote(overrides: Partial<TimeframeVote>): TimeframeVote {
  return {
    type: "hold",
    confidence: 0.5,
    rulesFired: [],
    bullishScore: 0,
    bearishScore: 0,
    volatilityFlag: false,
    gateReason: null,
    asOf: 1_700_000_000_000,
    ...overrides,
  };
}

/** The four-TF vote map from the §5 golden worked example. */
function makeGoldenVotes(): Record<"15m" | "1h" | "4h" | "1d" | "1m" | "5m", TimeframeVote | null> {
  return {
    "1m": null,
    "5m": null,
    "15m": makeVote({ type: "hold", confidence: 0.55, rulesFired: ["hold-rule-15m"] }),
    "1h": makeVote({ type: "buy", confidence: 0.68, rulesFired: ["rsi-oversold", "macd-cross-bull"] }),
    "4h": makeVote({ type: "buy", confidence: 0.72, rulesFired: ["ema-stack-bull", "fng-extreme-fear"] }),
    "1d": makeVote({ type: "hold", confidence: 0.50, rulesFired: ["hold-rule-1d"] }),
  };
}

// ---------------------------------------------------------------------------
// §5 Golden worked example
// ---------------------------------------------------------------------------

describe("§5 golden worked example — (15m: hold, 1h: buy 0.68, 4h: buy 0.72, 1d: hold)", () => {
  /**
   * scalars = { "15m": 0, "1h": +0.68, "4h": +0.72, "1d": 0 }
   * Raw weights (only 15m/1h/4h/1d have non-zero defaults):
   *   15m: 0.15, 1h: 0.20, 4h: 0.30, 1d: 0.35 → sum = 1.0
   * All four are non-null → renormalized weights = raw weights.
   * blended = 0.15*0 + 0.20*0.68 + 0.30*0.72 + 0.35*0
   *          = 0.136 + 0.216 = 0.352
   * |blended| = 0.352 > T (0.25) → type = "buy"
   * confidence = min(1, 0.352 * 1.2) = min(1, 0.4224) = 0.4224
   */

  it("returns type='buy'", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result).not.toBeNull();
    expect(result.type).toBe("buy");
  });

  it("confidence ≈ 0.4224 (within ±0.005)", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.confidence).toBeGreaterThan(0.4224 - 0.005);
    expect(result.confidence).toBeLessThan(0.4224 + 0.005);
  });

  it("confidence is exactly min(1, 0.352 * 1.2) = 0.4224", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.confidence).toBeCloseTo(0.4224, 4);
  });

  it("volatilityFlag is false", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.volatilityFlag).toBe(false);
  });

  it("gateReason is null", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.gateReason).toBeNull();
  });

  it("rulesFired is union of 1h and 4h rules (hold TFs contribute their rulesFired too)", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    // All non-null TFs contribute — so all four TFs' rulesFired are included
    expect(result.rulesFired).toContain("rsi-oversold");
    expect(result.rulesFired).toContain("macd-cross-bull");
    expect(result.rulesFired).toContain("ema-stack-bull");
    expect(result.rulesFired).toContain("fng-extreme-fear");
  });

  it("weightsUsed sums to 1.0 (renormalized, all 4 non-null TFs)", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    const sum = (Object.values(result.weightsUsed) as number[]).reduce((a, b) => a + b, 0);
    // weightsUsed only counts 15m/1h/4h/1d (1m and 5m are null)
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("weightsUsed matches DEFAULT_TIMEFRAME_WEIGHTS for 15m/1h/4h/1d (sum to 1.0 already)", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    // Since 15m+1h+4h+1d = 0.15+0.20+0.30+0.35 = 1.0, renormalized = raw
    expect(result.weightsUsed["15m"]).toBeCloseTo(0.15, 10);
    expect(result.weightsUsed["1h"]).toBeCloseTo(0.20, 10);
    expect(result.weightsUsed["4h"]).toBeCloseTo(0.30, 10);
    expect(result.weightsUsed["1d"]).toBeCloseTo(0.35, 10);
  });

  it("emittingTimeframe is passed through", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("BTC/USDT", votes, "4h") as BlendedSignal;
    expect(result.emittingTimeframe).toBe("4h");
  });

  it("pair is passed through", () => {
    const votes = makeGoldenVotes();
    const result = blendTimeframeVotes("ETH/USDT", votes, "1h") as BlendedSignal;
    expect(result.pair).toBe("ETH/USDT");
  });

  it("asOf is the maximum asOf among non-null votes", () => {
    const votes = makeGoldenVotes();
    // Override some asOf values.
    votes["1h"] = makeVote({ type: "buy", confidence: 0.68, asOf: 1_700_000_005_000 });
    votes["4h"] = makeVote({ type: "buy", confidence: 0.72, asOf: 1_700_000_003_000 });
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.asOf).toBe(1_700_000_005_000);
  });
});

// ---------------------------------------------------------------------------
// All-null case
// ---------------------------------------------------------------------------

describe("all-null case", () => {
  it("returns null when all TF votes are null", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
    } as const;
    expect(blendTimeframeVotes("BTC/USDT", votes, "1h")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// All-hold case (no gates)
// ---------------------------------------------------------------------------

describe("all-hold case — no gates, all vote hold", () => {
  it("returns type='hold' with confidence = 0.5 (blended = 0, scalar = 0 for all holds)", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold", confidence: 0.5 }),
      "1h": makeVote({ type: "hold", confidence: 0.5 }),
      "4h": makeVote({ type: "hold", confidence: 0.5 }),
      "1d": makeVote({ type: "hold", confidence: 0.5 }),
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result).not.toBeNull();
    expect(result.type).toBe("hold");
    expect(result.confidence).toBeLessThanOrEqual(1.0);
    // hold scalars = 0 → blended = 0 → confidence = 0.5 + 0.1 * 0 = 0.5
    expect(result.confidence).toBeCloseTo(0.5, 10);
  });

  it("volatilityFlag is false", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold", confidence: 0.5 }),
      "1h": makeVote({ type: "hold", confidence: 0.5 }),
      "4h": makeVote({ type: "hold", confidence: 0.5 }),
      "1d": makeVote({ type: "hold", confidence: 0.5 }),
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.volatilityFlag).toBe(false);
  });

  it("weightsUsed sums to 1.0", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold", confidence: 0.5 }),
      "1h": makeVote({ type: "hold", confidence: 0.5 }),
      "4h": makeVote({ type: "hold", confidence: 0.5 }),
      "1d": makeVote({ type: "hold", confidence: 0.5 }),
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    const sum = (Object.values(result.weightsUsed) as number[]).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// Single-source (3 of 4 TFs null) — 0.7 damping
// ---------------------------------------------------------------------------

describe("single-source case — 3 of 4 TFs null, 0.7 damping applied", () => {
  it("renormalized weight = 1.0 on the sole voting TF", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "buy", confidence: 0.80 }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.weightsUsed["1h"]).toBeCloseTo(1.0, 10);
  });

  it("applies 0.7 damping to confidence when type=buy", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "buy", confidence: 0.80 }),
      "4h": null,
      "1d": null,
    };
    // blended = 1.0 * 0.80 = 0.80 (> T=0.25 → buy)
    // undamped confidence = min(1, 0.80 * 1.2) = min(1, 0.96) = 0.96
    // damped confidence   = 0.96 * 0.7 = 0.672
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.type).toBe("buy");
    expect(result.confidence).toBeCloseTo(0.672, 5);
  });

  it("applies 0.7 damping to confidence when type=sell", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": makeVote({ type: "sell", confidence: 0.80 }),
      "1d": null,
    };
    // blended = 1.0 * (-0.80) = -0.80 (< -T → sell)
    // undamped = min(1, 0.80 * 1.2) = 0.96, damped = 0.96 * 0.7 = 0.672
    const result = blendTimeframeVotes("BTC/USDT", votes, "4h") as BlendedSignal;
    expect(result.type).toBe("sell");
    expect(result.confidence).toBeCloseTo(0.672, 5);
  });

  it("single-source hold still applies 0.7 damping to the 1.2 factor (hold skips the 1.2 factor)", () => {
    // When blended → hold branch: confidence = 0.5 + 0.1 * |blended|
    // The spec says damping applies to the "final confidence" for directional signals.
    // For hold (blended ≤ T), the formula doesn't use the 1.2 multiplier path,
    // so single-source hold → same 0.5 formula applies without the damping adjustment.
    // But the blended value is still scaled via renormalized weight = 1.0.
    // e.g. single TF vote: hold with confidence 0.60, blended = 1.0 * 0 = 0
    // → hold, confidence = 0.5 + 0.1*0 = 0.5
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "hold", confidence: 0.60 }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.type).toBe("hold");
    // hold scalar = 0 → blended = 0 → confidence = 0.5
    expect(result.confidence).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// Gate cascade — volatility/dispersion/stale
// ---------------------------------------------------------------------------

describe("gate cascade — any gated TF forces blended hold", () => {
  it("volatilityFlag=true on any TF forces type='hold' with gateReason='vol'", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold", confidence: 0.5, volatilityFlag: true, gateReason: "vol" }),
      "1h": makeVote({ type: "buy", confidence: 0.90 }),
      "4h": makeVote({ type: "buy", confidence: 0.90 }),
      "1d": makeVote({ type: "buy", confidence: 0.90 }),
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.type).toBe("hold");
    expect(result.volatilityFlag).toBe(true);
    expect(result.gateReason).toBe("vol");
    expect(result.confidence).toBe(0.5);
  });

  it("gateReason='dispersion' on any TF forces type='hold'", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "hold", confidence: 0.5, volatilityFlag: true, gateReason: "dispersion" }),
      "4h": makeVote({ type: "buy", confidence: 0.90 }),
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.type).toBe("hold");
    expect(result.gateReason).toBe("dispersion");
  });

  it("gateReason='stale' on any TF forces type='hold'", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "hold", confidence: 0.5, volatilityFlag: true, gateReason: "stale" }),
      "4h": makeVote({ type: "buy", confidence: 0.90 }),
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.type).toBe("hold");
    expect(result.gateReason).toBe("stale");
  });

  it("mixed gates: vol + stale → highest priority wins (vol)", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "hold", confidence: 0.5, volatilityFlag: true, gateReason: "stale" }),
      "4h": makeVote({ type: "hold", confidence: 0.5, volatilityFlag: true, gateReason: "vol" }),
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.gateReason).toBe("vol");
  });

  it("mixed gates: dispersion + stale → dispersion wins (higher priority)", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold", confidence: 0.5, volatilityFlag: true, gateReason: "stale" }),
      "1h": null,
      "4h": makeVote({ type: "hold", confidence: 0.5, volatilityFlag: true, gateReason: "dispersion" }),
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "4h") as BlendedSignal;
    expect(result.gateReason).toBe("dispersion");
  });

  it("gated hold confidence is always 0.5", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold", confidence: 0.9, volatilityFlag: true, gateReason: "vol" }),
      "1h": makeVote({ type: "buy", confidence: 0.99 }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "15m") as BlendedSignal;
    expect(result.confidence).toBe(0.5);
  });

  it("gated hold includes all non-null TF rulesFired in union", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({
        type: "hold",
        volatilityFlag: true,
        gateReason: "vol",
        rulesFired: ["vol-gate-15m"],
      }),
      "1h": makeVote({ type: "buy", confidence: 0.90, rulesFired: ["rsi-oversold"] }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.rulesFired).toContain("vol-gate-15m");
    expect(result.rulesFired).toContain("rsi-oversold");
  });
});

// ---------------------------------------------------------------------------
// weightsUsed sums to 1.0 (various scenarios)
// ---------------------------------------------------------------------------

describe("weightsUsed post-renormalization", () => {
  it("sums to 1.0 for partial TF coverage (only 1h+4h non-null)", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "buy", confidence: 0.6 }),
      "4h": makeVote({ type: "buy", confidence: 0.7 }),
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    // raw weights: 1h=0.20, 4h=0.30 → sum=0.50 → renorm: 1h=0.40, 4h=0.60
    const sum = (Object.values(result.weightsUsed) as number[]).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
    expect(result.weightsUsed["1h"]).toBeCloseTo(0.40, 10);
    expect(result.weightsUsed["4h"]).toBeCloseTo(0.60, 10);
  });

  it("weightsUsed for null TFs is 0", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "buy", confidence: 0.6 }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.weightsUsed["15m"]).toBe(0);
    expect(result.weightsUsed["4h"]).toBe(0);
    expect(result.weightsUsed["1d"]).toBe(0);
  });

  it("weightsUsed sums to 1.0 for gated-hold path", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold", volatilityFlag: true, gateReason: "vol" }),
      "1h": makeVote({ type: "buy", confidence: 0.6 }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    const sum = (Object.values(result.weightsUsed) as number[]).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// Sell path
// ---------------------------------------------------------------------------

describe("sell path", () => {
  it("returns type='sell' when blended < -T", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "sell", confidence: 0.70 }),
      "4h": makeVote({ type: "sell", confidence: 0.75 }),
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.type).toBe("sell");
  });

  it("sell confidence is derived from |blended| * 1.2", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "sell", confidence: 0.70 }),
      "4h": makeVote({ type: "sell", confidence: 0.70 }),
      "1d": null,
    };
    // raw weights: 1h=0.20, 4h=0.30 → renorm: 1h=0.40, 4h=0.60
    // blended = 0.40 * (-0.70) + 0.60 * (-0.70) = -0.70
    // confidence = min(1, 0.70 * 1.2) = 0.84
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.confidence).toBeCloseTo(0.84, 5);
  });
});

// ---------------------------------------------------------------------------
// Threshold boundary
// ---------------------------------------------------------------------------

describe("threshold boundary — exactly T and just above/below", () => {
  it("blended exactly at T (0.25) produces hold (not buy)", () => {
    // Set up votes so that blended = exactly BLEND_THRESHOLD_T.
    // Using only 1h (renorm weight = 1.0, single source, 0.7 damping):
    // blended = confidence = BLEND_THRESHOLD_T / 1.0
    // But with single-source, we need: scalar = T, so buy confidence = T
    // → blended = T (exactly at threshold, not above)
    const exactConfidence = BLEND_THRESHOLD_T; // 0.25
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "buy", confidence: exactConfidence }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    // blended = 1.0 * 0.25 = 0.25 — NOT strictly > T → hold
    expect(result.type).toBe("hold");
  });

  it("blended just above T produces buy", () => {
    const justAbove = BLEND_THRESHOLD_T + 0.001;
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "buy", confidence: justAbove }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.type).toBe("buy");
  });

  it("blended just below -T produces sell", () => {
    const justBelow = BLEND_THRESHOLD_T + 0.001;
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "sell", confidence: justBelow }),
      "4h": null,
      "1d": null,
    };
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h") as BlendedSignal;
    expect(result.type).toBe("sell");
  });
});

// ---------------------------------------------------------------------------
// No mutation of input vote map — purity (structuredClone + toEqual)
// ---------------------------------------------------------------------------

describe("no mutation of inputs — purity (structuredClone + toEqual)", () => {
  it("blendTimeframeVotes does not mutate the perTimeframeVotes map", () => {
    const votes = makeGoldenVotes();
    const snapshot = structuredClone(votes);
    blendTimeframeVotes("BTC/USDT", votes, "1h");
    expect(votes).toEqual(snapshot);
  });

  it("blendTimeframeVotes does not mutate rulesFired arrays inside votes", () => {
    const votes = makeGoldenVotes();
    const originalRules1h = [...(votes["1h"]!.rulesFired)];
    blendTimeframeVotes("BTC/USDT", votes, "1h");
    expect(votes["1h"]!.rulesFired).toEqual(originalRules1h);
  });

  it("blendTimeframeVotes does not mutate perTimeframeVotes for the all-null case", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
    } as const;
    const snapshot = structuredClone(votes);
    blendTimeframeVotes("BTC/USDT", votes, "1h");
    expect(votes).toEqual(snapshot);
  });

  it("blendTimeframeVotes does not mutate votes for gated path", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold", volatilityFlag: true, gateReason: "vol" }),
      "1h": makeVote({ type: "buy", confidence: 0.80 }),
      "4h": null,
      "1d": null,
    };
    const snapshot = structuredClone(votes);
    blendTimeframeVotes("BTC/USDT", votes, "1h");
    expect(votes).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// isTrivialChange
// ---------------------------------------------------------------------------

describe("isTrivialChange", () => {
  function makeSignal(overrides: Partial<BlendedSignal>): BlendedSignal {
    return {
      pair: "BTC/USDT",
      type: "buy",
      confidence: 0.60,
      volatilityFlag: false,
      gateReason: null,
      rulesFired: [],
      perTimeframe: makeGoldenVotes(),
      weightsUsed: DEFAULT_TIMEFRAME_WEIGHTS,
      asOf: 1_700_000_000_000,
      emittingTimeframe: "1h",
      ...overrides,
    };
  }

  it("returns true when both are null", () => {
    expect(isTrivialChange(null, null)).toBe(true);
  });

  it("returns false when previous is null and current is not", () => {
    expect(isTrivialChange(null, makeSignal({}))).toBe(false);
  });

  it("returns false when current is null and previous is not", () => {
    expect(isTrivialChange(makeSignal({}), null)).toBe(false);
  });

  it("returns true when same type, same vol/gate, confidence delta < 0.05", () => {
    const prev = makeSignal({ confidence: 0.60 });
    const curr = makeSignal({ confidence: 0.62 });
    expect(isTrivialChange(prev, curr)).toBe(true);
  });

  it("returns true when confidence delta is exactly 0.049 (< 0.05)", () => {
    const prev = makeSignal({ confidence: 0.60 });
    const curr = makeSignal({ confidence: 0.649 });
    expect(isTrivialChange(prev, curr)).toBe(true);
  });

  it("returns false when confidence delta is exactly 0.05", () => {
    const prev = makeSignal({ confidence: 0.60 });
    const curr = makeSignal({ confidence: 0.65 });
    expect(isTrivialChange(prev, curr)).toBe(false);
  });

  it("returns false when confidence delta > 0.05", () => {
    const prev = makeSignal({ confidence: 0.60 });
    const curr = makeSignal({ confidence: 0.70 });
    expect(isTrivialChange(prev, curr)).toBe(false);
  });

  it("returns false when type changes (buy → sell)", () => {
    const prev = makeSignal({ type: "buy" });
    const curr = makeSignal({ type: "sell" });
    expect(isTrivialChange(prev, curr)).toBe(false);
  });

  it("returns false when type changes (buy → hold)", () => {
    const prev = makeSignal({ type: "buy" });
    const curr = makeSignal({ type: "hold" });
    expect(isTrivialChange(prev, curr)).toBe(false);
  });

  it("returns false when volatilityFlag changes", () => {
    const prev = makeSignal({ volatilityFlag: false });
    const curr = makeSignal({ volatilityFlag: true });
    expect(isTrivialChange(prev, curr)).toBe(false);
  });

  it("returns false when gateReason changes (null → 'vol')", () => {
    const prev = makeSignal({ gateReason: null });
    const curr = makeSignal({ gateReason: "vol" });
    expect(isTrivialChange(prev, curr)).toBe(false);
  });

  it("returns false when gateReason changes (stale → dispersion)", () => {
    const prev = makeSignal({ gateReason: "stale" });
    const curr = makeSignal({ gateReason: "dispersion" });
    expect(isTrivialChange(prev, curr)).toBe(false);
  });

  it("returns true for identical signals", () => {
    const sig = makeSignal({});
    expect(isTrivialChange(sig, sig)).toBe(true);
  });

  it("rulesFired changes alone does not make it non-trivial (§5.5 only checks 4 fields)", () => {
    const prev = makeSignal({ rulesFired: ["rule-a"] });
    const curr = makeSignal({ rulesFired: ["rule-a", "rule-b"] });
    // §5.5 says: same type, |confidence delta| < 0.05, same vol, same gate → trivial
    expect(isTrivialChange(prev, curr)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Custom weights override
// ---------------------------------------------------------------------------

describe("custom weights override", () => {
  it("respects custom weights parameter", () => {
    const customWeights = {
      "1m": 0,
      "5m": 0,
      "15m": 0,
      "1h": 0.50,
      "4h": 0.50,
      "1d": 0,
    } as const;
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "buy", confidence: 0.80 }), // weight=0, excluded
      "1h": makeVote({ type: "buy", confidence: 0.60 }),
      "4h": makeVote({ type: "sell", confidence: 0.60 }),
      "1d": null,
    };
    // 15m has custom weight 0 → renorm: 1h=0.50/1.0=0.50, 4h=0.50/1.0=0.50
    // blended = 0.50 * 0.60 + 0.50 * (-0.60) = 0 → hold
    // But wait, 15m is non-null and has weight=0. Let's verify it doesn't dominate.
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h", customWeights) as BlendedSignal;
    expect(result).not.toBeNull();
    // blended = 0 → hold (or very close to 0)
    expect(result.type).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// BLEND_THRESHOLD_T exported constant
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("BLEND_THRESHOLD_T is 0.25", () => {
    expect(BLEND_THRESHOLD_T).toBe(0.25);
  });

  it("DEFAULT_TIMEFRAME_WEIGHTS sums to 1.0 for the blender TFs (15m+1h+4h+1d)", () => {
    const sum = DEFAULT_TIMEFRAME_WEIGHTS["15m"] +
      DEFAULT_TIMEFRAME_WEIGHTS["1h"] +
      DEFAULT_TIMEFRAME_WEIGHTS["4h"] +
      DEFAULT_TIMEFRAME_WEIGHTS["1d"];
    expect(sum).toBeCloseTo(1.0, 10);
  });
});
