/**
 * Strategy interface + loader unit tests — Phase 2.
 */

import { describe, it, expect } from "vitest";
import { strategySchema } from "./types.js";
import type { Strategy } from "./types.js";

// ---------------------------------------------------------------------------
// Valid strategy shapes
// ---------------------------------------------------------------------------

const minimalValid: Strategy = {
  name: "test-strategy",
  description: "A minimal valid strategy.",
  exitPolicy: { kind: "n-bars", nBars: 4 },
  sizing: { kind: "fixed-pct", pct: 0.01 },
};

const fullValid: Strategy = {
  name: "full-strategy",
  description: "Full coverage of all optional fields.",
  enabledRules: ["ema-cross", "rsi-oversold"],
  timeframeWeights: {
    "15m": 0.1,
    "1h": 0.2,
    "4h": 0.3,
    "1d": 0.4,
  },
  ratificationThreshold: 0.45,
  exitPolicy: { kind: "atr-multiple", atrMultiple: 2.0 },
  sizing: { kind: "kelly", kellyFraction: 0.25 },
  calibration: { kind: "walk-forward", refitDays: 30 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("strategySchema", () => {
  it("accepts a minimal valid strategy", () => {
    const result = strategySchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
  });

  it("accepts a fully-specified valid strategy", () => {
    const result = strategySchema.safeParse(fullValid);
    expect(result.success).toBe(true);
  });

  it("accepts n-bars exit policy", () => {
    const s = { ...minimalValid, exitPolicy: { kind: "n-bars" as const, nBars: 6 } };
    expect(strategySchema.safeParse(s).success).toBe(true);
  });

  it("accepts atr-multiple exit policy", () => {
    const s = { ...minimalValid, exitPolicy: { kind: "atr-multiple" as const, atrMultiple: 1.5 } };
    expect(strategySchema.safeParse(s).success).toBe(true);
  });

  it("accepts trailing-stop exit policy", () => {
    const s = { ...minimalValid, exitPolicy: { kind: "trailing-stop" as const, trailPct: 0.02 } };
    expect(strategySchema.safeParse(s).success).toBe(true);
  });

  it("accepts kelly sizing", () => {
    const s = { ...minimalValid, sizing: { kind: "kelly" as const, kellyFraction: 0.5 } };
    expect(strategySchema.safeParse(s).success).toBe(true);
  });

  it("accepts vol-target sizing", () => {
    const s = { ...minimalValid, sizing: { kind: "vol-target" as const, volTarget: 0.15 } };
    expect(strategySchema.safeParse(s).success).toBe(true);
  });

  it("accepts frozen calibration", () => {
    const s = {
      ...minimalValid,
      calibration: { kind: "frozen" as const, paramsAt: "2026-01-01T00:00:00Z" },
    };
    expect(strategySchema.safeParse(s).success).toBe(true);
  });

  it("accepts none calibration", () => {
    const s = { ...minimalValid, calibration: { kind: "none" as const } };
    expect(strategySchema.safeParse(s).success).toBe(true);
  });

  it("rejects strategy with empty name", () => {
    const s = { ...minimalValid, name: "" };
    const result = strategySchema.safeParse(s);
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameError = result.error.issues.find((i) => i.path.includes("name"));
      expect(nameError).toBeDefined();
    }
  });

  it("rejects strategy with missing exitPolicy", () => {
    const s: Record<string, unknown> = { ...minimalValid };
    delete s["exitPolicy"];
    const result = strategySchema.safeParse(s);
    expect(result.success).toBe(false);
  });

  it("rejects strategy with missing sizing", () => {
    const s: Record<string, unknown> = { ...minimalValid };
    delete s["sizing"];
    const result = strategySchema.safeParse(s);
    expect(result.success).toBe(false);
  });

  it("rejects n-bars exit policy with non-integer nBars", () => {
    const s = { ...minimalValid, exitPolicy: { kind: "n-bars" as const, nBars: 1.5 } };
    const result = strategySchema.safeParse(s);
    expect(result.success).toBe(false);
  });

  it("rejects ratificationThreshold outside [0, 1]", () => {
    const s = { ...minimalValid, ratificationThreshold: 1.5 };
    const result = strategySchema.safeParse(s);
    expect(result.success).toBe(false);
  });

  it("rejects unknown exitPolicy kind", () => {
    const s = { ...minimalValid, exitPolicy: { kind: "magic-stop" as string, bars: 3 } };
    const result = strategySchema.safeParse(s);
    expect(result.success).toBe(false);
  });

  it("rejects unknown sizing kind", () => {
    const s = { ...minimalValid, sizing: { kind: "random" as string } };
    const result = strategySchema.safeParse(s);
    expect(result.success).toBe(false);
  });
});

describe("reference strategies", () => {
  it("production-default passes schema validation", async () => {
    // Dynamic import — path relative to this test file in src/strategy/
    const mod = await import("../../strategies/production-default.js");
    const strategy = mod.default;
    const result = strategySchema.safeParse(strategy);
    if (!result.success) {
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it("aggressive-1d-weighted passes schema validation", async () => {
    const mod = await import("../../strategies/aggressive-1d-weighted.js");
    const strategy = mod.default;
    const result = strategySchema.safeParse(strategy);
    if (!result.success) {
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });
});
