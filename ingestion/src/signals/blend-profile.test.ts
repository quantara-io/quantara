/**
 * Tests for BlendProfile types + reblendWithProfile (#302).
 *
 * Covers:
 *   - BLEND_PROFILES constants: correct T and weights for each profile
 *   - defaultBlendProfiles: tier defaulting (free → strict, paid → balanced)
 *   - getBlendProfile: fallback to "strict" when map is absent or pair missing
 *   - reblendWithProfile: strict — same math as stored blend (no-op for canonical signal)
 *   - reblendWithProfile: balanced — lower T (0.22) allows 1h alone to surface
 *   - reblendWithProfile: aggressive — lowest T (0.18), 15m alone can surface
 *   - reblendWithProfile: gates always force hold regardless of profile
 *   - reblendWithProfile: weightsUsed sums to 1.0 post-renormalization
 *   - reblendWithProfile: single-source 0.7 damping is applied correctly
 *   - reblendWithProfile: sell path works under all profiles
 *   - blendTimeframeVotes: threshold parameter overrides BLEND_THRESHOLD_T
 */

import { describe, it, expect } from "vitest";
import type { BlendedSignal, TimeframeVote } from "@quantara/shared";
import {
  BLEND_PROFILES,
  defaultBlendProfiles,
  getBlendProfile,
  reblendWithProfile,
} from "@quantara/shared";
import type { BlendProfileMap } from "@quantara/shared";

import { blendTimeframeVotes, DEFAULT_TIMEFRAME_WEIGHTS } from "./blend.js";

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
    reasoning: "No rules fired",
    tags: [],
    asOf: 1_700_000_000_000,
    ...overrides,
  };
}

/** Build a minimal BlendedSignal with the given perTimeframe overrides. */
function makeSignal(
  ptOverrides: Partial<BlendedSignal["perTimeframe"]> = {},
  rest: Partial<BlendedSignal> = {},
): BlendedSignal {
  return {
    pair: "BTC/USDT",
    type: "hold",
    confidence: 0.5,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: [],
    perTimeframe: {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
      ...ptOverrides,
    },
    weightsUsed: DEFAULT_TIMEFRAME_WEIGHTS,
    asOf: 1_700_000_000_000,
    emittingTimeframe: "1h",
    risk: null,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// BLEND_PROFILES constants
// ---------------------------------------------------------------------------

describe("BLEND_PROFILES constants", () => {
  it("strict: T = 0.25", () => {
    expect(BLEND_PROFILES.strict.threshold).toBe(0.25);
  });

  it("balanced: T = 0.22", () => {
    expect(BLEND_PROFILES.balanced.threshold).toBe(0.22);
  });

  it("aggressive: T = 0.18", () => {
    expect(BLEND_PROFILES.aggressive.threshold).toBe(0.18);
  });

  it("strict weights: {15m=0.15, 1h=0.20, 4h=0.30, 1d=0.35}", () => {
    const w = BLEND_PROFILES.strict.weights;
    expect(w["15m"]).toBe(0.15);
    expect(w["1h"]).toBe(0.2);
    expect(w["4h"]).toBe(0.3);
    expect(w["1d"]).toBe(0.35);
    expect(w["1m"]).toBe(0);
    expect(w["5m"]).toBe(0);
  });

  it("balanced weights: {15m=0.10, 1h=0.25, 4h=0.30, 1d=0.35}", () => {
    const w = BLEND_PROFILES.balanced.weights;
    expect(w["15m"]).toBe(0.1);
    expect(w["1h"]).toBe(0.25);
    expect(w["4h"]).toBe(0.3);
    expect(w["1d"]).toBe(0.35);
  });

  it("aggressive weights: {15m=0.15, 1h=0.25, 4h=0.30, 1d=0.30}", () => {
    const w = BLEND_PROFILES.aggressive.weights;
    expect(w["15m"]).toBe(0.15);
    expect(w["1h"]).toBe(0.25);
    expect(w["4h"]).toBe(0.3);
    expect(w["1d"]).toBe(0.3);
  });

  it("strict blending TF weights (15m+1h+4h+1d) sum to 1.0", () => {
    const w = BLEND_PROFILES.strict.weights;
    expect(w["15m"] + w["1h"] + w["4h"] + w["1d"]).toBeCloseTo(1.0, 10);
  });

  it("balanced blending TF weights (15m+1h+4h+1d) sum to 1.0", () => {
    const w = BLEND_PROFILES.balanced.weights;
    expect(w["15m"] + w["1h"] + w["4h"] + w["1d"]).toBeCloseTo(1.0, 10);
  });

  it("aggressive blending TF weights (15m+1h+4h+1d) sum to 1.0", () => {
    const w = BLEND_PROFILES.aggressive.weights;
    expect(w["15m"] + w["1h"] + w["4h"] + w["1d"]).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// defaultBlendProfiles — tier defaulting
// ---------------------------------------------------------------------------

describe("defaultBlendProfiles — tier defaulting", () => {
  it("free tier → 'strict' for all pairs", () => {
    const profiles = defaultBlendProfiles("free");
    expect(profiles["BTC/USDT"]).toBe("strict");
    expect(profiles["ETH/USDT"]).toBe("strict");
    expect(profiles["SOL/USDT"]).toBe("strict");
    expect(profiles["XRP/USDT"]).toBe("strict");
    expect(profiles["DOGE/USDT"]).toBe("strict");
  });

  it("paid tier → 'balanced' for all pairs", () => {
    const profiles = defaultBlendProfiles("paid");
    expect(profiles["BTC/USDT"]).toBe("balanced");
    expect(profiles["ETH/USDT"]).toBe("balanced");
    expect(profiles["SOL/USDT"]).toBe("balanced");
    expect(profiles["XRP/USDT"]).toBe("balanced");
    expect(profiles["DOGE/USDT"]).toBe("balanced");
  });
});

// ---------------------------------------------------------------------------
// getBlendProfile — fallback behavior
// ---------------------------------------------------------------------------

describe("getBlendProfile — fallback to 'strict'", () => {
  it("returns 'strict' when blendProfiles is undefined", () => {
    expect(getBlendProfile(undefined, "BTC/USDT")).toBe("strict");
  });

  it("returns the per-pair value from the map", () => {
    const map: BlendProfileMap = {
      "BTC/USDT": "aggressive",
      "ETH/USDT": "balanced",
      "SOL/USDT": "strict",
      "XRP/USDT": "balanced",
      "DOGE/USDT": "strict",
    };
    expect(getBlendProfile(map, "BTC/USDT")).toBe("aggressive");
    expect(getBlendProfile(map, "ETH/USDT")).toBe("balanced");
    expect(getBlendProfile(map, "SOL/USDT")).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// reblendWithProfile — all-null → signal returned unchanged
// ---------------------------------------------------------------------------

describe("reblendWithProfile — all-null perTimeframe", () => {
  it("returns the same signal object (by reference) when all TF votes are null", () => {
    const signal = makeSignal();
    const result = reblendWithProfile(signal, "strict");
    expect(result).toBe(signal);
  });
});

// ---------------------------------------------------------------------------
// reblendWithProfile — strict profile (same math as stored blend)
// ---------------------------------------------------------------------------

describe("reblendWithProfile — strict profile (T=0.25, default weights)", () => {
  it("§5 golden example: 1h=buy 0.68, 4h=buy 0.72 → buy (blended=0.352 > 0.25)", () => {
    const signal = makeSignal({
      "15m": makeVote({ type: "hold", confidence: 0.55 }),
      "1h": makeVote({ type: "buy", confidence: 0.68 }),
      "4h": makeVote({ type: "buy", confidence: 0.72 }),
      "1d": makeVote({ type: "hold", confidence: 0.5 }),
    });
    const result = reblendWithProfile(signal, "strict");
    expect(result.type).toBe("buy");
    expect(result.confidence).toBeCloseTo(0.4224, 4);
  });

  it("all hold → blended = 0 → type=hold, confidence=0.5", () => {
    const signal = makeSignal({
      "15m": makeVote({ type: "hold" }),
      "1h": makeVote({ type: "hold" }),
      "4h": makeVote({ type: "hold" }),
      "1d": makeVote({ type: "hold" }),
    });
    const result = reblendWithProfile(signal, "strict");
    expect(result.type).toBe("hold");
    expect(result.confidence).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// reblendWithProfile — balanced profile (T=0.22, boosted 1h weight)
// ---------------------------------------------------------------------------

describe("reblendWithProfile — balanced profile (T=0.22)", () => {
  it("1h=buy 0.92 with 4-TF coverage: strict→hold, balanced→buy", () => {
    // strict:   blended = 0.15*0 + 0.20*0.92 + 0.30*0 + 0.35*0 = 0.184 ≤ 0.25 → hold
    // balanced: blended = 0.10*0 + 0.25*0.92 + 0.30*0 + 0.35*0 = 0.230 > 0.22  → buy
    const signal = makeSignal({
      "15m": makeVote({ type: "hold" }),
      "1h": makeVote({ type: "buy", confidence: 0.92 }),
      "4h": makeVote({ type: "hold" }),
      "1d": makeVote({ type: "hold" }),
    });
    expect(reblendWithProfile(signal, "strict").type).toBe("hold");
    expect(reblendWithProfile(signal, "balanced").type).toBe("buy");
  });

  it("balanced buy confidence = min(1, 0.230 * 1.2) ≈ 0.276", () => {
    const signal = makeSignal({
      "15m": makeVote({ type: "hold" }),
      "1h": makeVote({ type: "buy", confidence: 0.92 }),
      "4h": makeVote({ type: "hold" }),
      "1d": makeVote({ type: "hold" }),
    });
    const result = reblendWithProfile(signal, "balanced");
    expect(result.confidence).toBeCloseTo(0.276, 3);
  });
});

// ---------------------------------------------------------------------------
// reblendWithProfile — aggressive profile (T=0.18)
// ---------------------------------------------------------------------------

describe("reblendWithProfile — aggressive profile (T=0.18)", () => {
  it("15m alone, c=0.20: strict→hold, aggressive→buy (single-source, 0.7 damping)", () => {
    // aggressive T=0.18: blended = 1.0 * 0.20 = 0.20 > 0.18 → buy
    // strict T=0.25:     blended = 1.0 * 0.20 = 0.20 ≤ 0.25 → hold
    const signal = makeSignal({ "15m": makeVote({ type: "buy", confidence: 0.2 }) });
    expect(reblendWithProfile(signal, "strict").type).toBe("hold");
    expect(reblendWithProfile(signal, "aggressive").type).toBe("buy");
  });

  it("aggressive single-source (15m=buy 0.20) confidence = min(1, 0.20 * 1.2 * 0.7) ≈ 0.168", () => {
    const signal = makeSignal({ "15m": makeVote({ type: "buy", confidence: 0.2 }) });
    const result = reblendWithProfile(signal, "aggressive");
    expect(result.confidence).toBeCloseTo(0.168, 4);
  });

  it("aggressive T=0.18: blended exactly at T → hold (not strictly greater)", () => {
    const signal = makeSignal({ "15m": makeVote({ type: "buy", confidence: 0.18 }) });
    const result = reblendWithProfile(signal, "aggressive");
    expect(result.type).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// reblendWithProfile — gates always force hold regardless of profile
// ---------------------------------------------------------------------------

describe("reblendWithProfile — gates always override profile", () => {
  it("vol gate on any TF forces hold under all profiles", () => {
    const signal = makeSignal({
      "15m": makeVote({ type: "hold", volatilityFlag: true, gateReason: "vol" }),
      "1h": makeVote({ type: "buy", confidence: 0.99 }),
      "4h": makeVote({ type: "buy", confidence: 0.99 }),
      "1d": makeVote({ type: "buy", confidence: 0.99 }),
    });
    for (const profile of ["strict", "balanced", "aggressive"] as const) {
      const result = reblendWithProfile(signal, profile);
      expect(result.type, `profile=${profile}`).toBe("hold");
      expect(result.volatilityFlag, `profile=${profile}`).toBe(true);
      expect(result.gateReason, `profile=${profile}`).toBe("vol");
      expect(result.confidence, `profile=${profile}`).toBe(0.5);
    }
  });

  it("dispersion gate forces hold regardless of profile", () => {
    const signal = makeSignal({
      "1h": makeVote({ type: "hold", volatilityFlag: true, gateReason: "dispersion" }),
      "4h": makeVote({ type: "buy", confidence: 0.99 }),
    });
    for (const profile of ["strict", "balanced", "aggressive"] as const) {
      const result = reblendWithProfile(signal, profile);
      expect(result.type, `profile=${profile}`).toBe("hold");
      expect(result.gateReason, `profile=${profile}`).toBe("dispersion");
    }
  });

  it("stale gate forces hold regardless of profile", () => {
    const signal = makeSignal({
      "4h": makeVote({ type: "hold", volatilityFlag: true, gateReason: "stale" }),
      "1d": makeVote({ type: "buy", confidence: 0.99 }),
    });
    for (const profile of ["strict", "balanced", "aggressive"] as const) {
      const result = reblendWithProfile(signal, profile);
      expect(result.type, `profile=${profile}`).toBe("hold");
      expect(result.gateReason, `profile=${profile}`).toBe("stale");
    }
  });

  it("gated hold confidence is always 0.5 regardless of profile", () => {
    const signal = makeSignal({
      "4h": makeVote({ type: "hold", volatilityFlag: true, gateReason: "vol" }),
      "1d": makeVote({ type: "buy", confidence: 0.99 }),
    });
    for (const profile of ["strict", "balanced", "aggressive"] as const) {
      expect(reblendWithProfile(signal, profile).confidence, `profile=${profile}`).toBe(0.5);
    }
  });

  it("mixed gates: vol + stale → vol wins (highest priority) under all profiles", () => {
    const signal = makeSignal({
      "1h": makeVote({ type: "hold", volatilityFlag: true, gateReason: "stale" }),
      "4h": makeVote({ type: "hold", volatilityFlag: true, gateReason: "vol" }),
    });
    for (const profile of ["strict", "balanced", "aggressive"] as const) {
      const result = reblendWithProfile(signal, profile);
      expect(result.gateReason, `profile=${profile}`).toBe("vol");
      expect(result.volatilityFlag, `profile=${profile}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// reblendWithProfile — weightsUsed sums to 1.0
// ---------------------------------------------------------------------------

describe("reblendWithProfile — weightsUsed post-renormalization", () => {
  it("strict: full 4-TF coverage sums to 1.0", () => {
    const signal = makeSignal({
      "15m": makeVote({ type: "hold" }),
      "1h": makeVote({ type: "buy", confidence: 0.68 }),
      "4h": makeVote({ type: "buy", confidence: 0.72 }),
      "1d": makeVote({ type: "hold" }),
    });
    const sum = Object.values(reblendWithProfile(signal, "strict").weightsUsed).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("balanced: partial coverage (1h+4h only) sums to 1.0, renorm check", () => {
    const signal = makeSignal({
      "1h": makeVote({ type: "buy", confidence: 0.7 }),
      "4h": makeVote({ type: "buy", confidence: 0.7 }),
    });
    const result = reblendWithProfile(signal, "balanced");
    const sum = Object.values(result.weightsUsed).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
    // balanced 1h=0.25, 4h=0.30, total=0.55 → renorm: 1h≈0.4545, 4h≈0.5455
    expect(result.weightsUsed["1h"]).toBeCloseTo(0.25 / 0.55, 5);
    expect(result.weightsUsed["4h"]).toBeCloseTo(0.3 / 0.55, 5);
  });

  it("aggressive: single-TF (15m only) weightsUsed['15m'] = 1.0", () => {
    const signal = makeSignal({ "15m": makeVote({ type: "buy", confidence: 0.5 }) });
    const result = reblendWithProfile(signal, "aggressive");
    expect(result.weightsUsed["15m"]).toBeCloseTo(1.0, 10);
    const sum = Object.values(result.weightsUsed).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// reblendWithProfile — sell path
// ---------------------------------------------------------------------------

describe("reblendWithProfile — sell path", () => {
  it("returns sell when blended < -T under balanced", () => {
    const signal = makeSignal({
      "15m": makeVote({ type: "hold" }),
      "1h": makeVote({ type: "sell", confidence: 0.92 }),
      "4h": makeVote({ type: "hold" }),
      "1d": makeVote({ type: "hold" }),
    });
    const result = reblendWithProfile(signal, "balanced");
    expect(result.type).toBe("sell");
  });

  it("aggressive sell with 15m alone, c=0.20: type=sell, confidence=0.168", () => {
    const signal = makeSignal({ "15m": makeVote({ type: "sell", confidence: 0.2 }) });
    const result = reblendWithProfile(signal, "aggressive");
    expect(result.type).toBe("sell");
    // blended = -0.20 < -0.18 → sell; confidence = min(1, 0.20 * 1.2 * 0.7) = 0.168
    expect(result.confidence).toBeCloseTo(0.168, 4);
  });
});

// ---------------------------------------------------------------------------
// reblendWithProfile — non-blend fields pass through
// ---------------------------------------------------------------------------

describe("reblendWithProfile — non-blend fields carried forward", () => {
  it("asOf, emittingTimeframe, pair, perTimeframe carried forward", () => {
    const signal = makeSignal(
      { "1h": makeVote({ type: "buy", confidence: 0.8 }) },
      { asOf: 9_999_999_999_999, emittingTimeframe: "4h", pair: "ETH/USDT" },
    );
    const result = reblendWithProfile(signal, "balanced");
    expect(result.asOf).toBe(9_999_999_999_999);
    expect(result.emittingTimeframe).toBe("4h");
    expect(result.pair).toBe("ETH/USDT");
    expect(result.perTimeframe).toBe(signal.perTimeframe);
  });

  it("risk is reset to null so enrichWithRisk can re-populate", () => {
    const signal = makeSignal({ "1h": makeVote({ type: "buy", confidence: 0.8 }) });
    expect(reblendWithProfile(signal, "balanced").risk).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// blendTimeframeVotes — threshold parameter override
// ---------------------------------------------------------------------------

describe("blendTimeframeVotes — threshold parameter", () => {
  it("default threshold (0.25): 1h buy 0.20 → hold", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "buy", confidence: 0.2 }),
      "4h": null,
      "1d": null,
    } as const;
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h");
    expect(result!.type).toBe("hold");
  });

  it("custom threshold (0.18): 1h buy 0.20 → buy", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "buy", confidence: 0.2 }),
      "4h": null,
      "1d": null,
    } as const;
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h", DEFAULT_TIMEFRAME_WEIGHTS, 0.18);
    expect(result!.type).toBe("buy");
  });

  it("custom threshold (0.22): sell 0.23 single source → sell", () => {
    const votes = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": makeVote({ type: "sell", confidence: 0.23 }),
      "4h": null,
      "1d": null,
    } as const;
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h", DEFAULT_TIMEFRAME_WEIGHTS, 0.22);
    // blended = -0.23 < -0.22 → sell
    expect(result!.type).toBe("sell");
  });

  it("default threshold unchanged: storage writes still use strict T=0.25", () => {
    // Verify no regression: calling blendTimeframeVotes without threshold param
    // still uses BLEND_THRESHOLD_T (0.25) — canonical storage behavior unchanged.
    const votes = {
      "1m": null,
      "5m": null,
      "15m": makeVote({ type: "hold" }),
      "1h": makeVote({ type: "buy", confidence: 0.68 }),
      "4h": makeVote({ type: "buy", confidence: 0.72 }),
      "1d": makeVote({ type: "hold" }),
    } as const;
    // blended = 0.352 > 0.25 → buy (strict)
    const result = blendTimeframeVotes("BTC/USDT", votes, "1h");
    expect(result!.type).toBe("buy");
    expect(result!.confidence).toBeCloseTo(0.4224, 4);
  });
});
