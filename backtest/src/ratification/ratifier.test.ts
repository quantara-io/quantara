/**
 * Ratifier unit tests — Phase 2 follow-up (PR #373 review findings 1 & 2).
 *
 * Validate each mode (skip / cache-only / replay-bedrock) in isolation using
 * the public `createRatifier` factory + in-memory stubs for the cache lookup
 * and Bedrock invoker. No real AWS calls.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createRatifier,
  DEFAULT_RATIFICATION_THRESHOLD,
  bedrockCallCostUsd,
  extractCachedRatification,
  type RatificationCandidate,
  type RatificationsLookup,
  type BedrockInvoker,
} from "./ratifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<RatificationCandidate> = {}): RatificationCandidate {
  return {
    pair: "BTC/USDT",
    timeframe: "15m",
    closeTime: 1_700_000_000_000,
    type: "buy",
    confidence: 0.8,
    rulesFired: ["ema-cross", "rsi-rebound"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// skip mode
// ---------------------------------------------------------------------------

describe("Ratifier skip mode", () => {
  it("returns not-required with zero cost regardless of confidence", async () => {
    const ratifier = createRatifier({ mode: "skip", model: "haiku" });

    const high = await ratifier.ratify(candidate({ confidence: 0.95 }));
    const low = await ratifier.ratify(candidate({ confidence: 0.1 }));

    for (const v of [high, low]) {
      expect(v.status).toBe("not-required");
      expect(v.costUsd).toBe(0);
      expect(v.inputTokens).toBe(0);
      expect(v.outputTokens).toBe(0);
      expect(v.ratifiedType).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// cache-only mode
// ---------------------------------------------------------------------------

describe("Ratifier cache-only mode", () => {
  function stubLookup(
    hits: Map<string, Awaited<ReturnType<RatificationsLookup["lookup"]>>>,
  ): RatificationsLookup {
    return {
      lookup: vi.fn().mockImplementation(async (pair, tf, closeTime) => {
        return hits.get(`${pair}|${tf}|${closeTime}`) ?? null;
      }),
    };
  }

  it("uses the cached verdict when one exists for (pair, tf, closeTime)", async () => {
    const hits = new Map<string, Awaited<ReturnType<RatificationsLookup["lookup"]>>>();
    hits.set("BTC/USDT|15m|1700000000000", {
      ratifiedType: "buy",
      ratifiedConfidence: 0.72,
      verdictKind: "ratify",
    });
    const ratifier = createRatifier({
      mode: "cache-only",
      model: "haiku",
      cacheLookup: stubLookup(hits),
    });

    const verdict = await ratifier.ratify(candidate());

    expect(verdict.status).toBe("ratified");
    expect(verdict.ratifiedType).toBe("buy");
    expect(verdict.ratifiedConfidence).toBe(0.72);
    expect(verdict.verdictKind).toBe("ratify");
    expect(verdict.costUsd).toBe(0);
  });

  it("falls back to not-required on cache miss (no LLM call, no cost)", async () => {
    const ratifier = createRatifier({
      mode: "cache-only",
      model: "haiku",
      cacheLookup: stubLookup(new Map()),
    });

    const verdict = await ratifier.ratify(candidate());

    expect(verdict.status).toBe("not-required");
    expect(verdict.ratifiedType).toBeUndefined();
    expect(verdict.costUsd).toBe(0);
  });

  it("skips sub-threshold candidates without hitting the cache", async () => {
    const lookup = vi.fn();
    const ratifier = createRatifier({
      mode: "cache-only",
      model: "haiku",
      cacheLookup: { lookup },
      ratificationThreshold: 0.7,
    });

    const verdict = await ratifier.ratify(candidate({ confidence: 0.5 }));
    expect(verdict.status).toBe("not-required");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("skips hold-type candidates without hitting the cache", async () => {
    const lookup = vi.fn();
    const ratifier = createRatifier({
      mode: "cache-only",
      model: "haiku",
      cacheLookup: { lookup },
    });

    const verdict = await ratifier.ratify(candidate({ type: "hold", confidence: 0.95 }));
    expect(verdict.status).toBe("not-required");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("maps verdictKind=downgrade to status=downgraded", async () => {
    const hits = new Map<string, Awaited<ReturnType<RatificationsLookup["lookup"]>>>();
    hits.set("BTC/USDT|15m|1700000000000", {
      ratifiedType: "buy",
      ratifiedConfidence: 0.5,
      verdictKind: "downgrade",
    });
    const ratifier = createRatifier({
      mode: "cache-only",
      model: "haiku",
      cacheLookup: stubLookup(hits),
    });

    const verdict = await ratifier.ratify(candidate());
    expect(verdict.status).toBe("downgraded");
    expect(verdict.verdictKind).toBe("downgrade");
  });

  it("throws if cacheLookup is not provided", () => {
    expect(() => createRatifier({ mode: "cache-only", model: "haiku" })).toThrow(
      /cache-only mode requires/,
    );
  });
});

// ---------------------------------------------------------------------------
// replay-bedrock mode
// ---------------------------------------------------------------------------

describe("Ratifier replay-bedrock mode", () => {
  function stubInvoker(
    fn: BedrockInvoker["invoke"] = vi.fn().mockResolvedValue({
      verdictKind: "ratify",
      ratifiedConfidence: 0.85,
      inputTokens: 700,
      outputTokens: 150,
    }),
  ): BedrockInvoker {
    return { invoke: fn };
  }

  it("invokes the Bedrock stub once per gated candidate and accumulates cost", async () => {
    const invoker = stubInvoker();
    const ratifier = createRatifier({
      mode: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
    });

    const verdict = await ratifier.ratify(candidate());

    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    expect(verdict.status).toBe("ratified");
    expect(verdict.ratifiedType).toBe("buy");
    expect(verdict.ratifiedConfidence).toBe(0.85);
    expect(verdict.inputTokens).toBe(700);
    expect(verdict.outputTokens).toBe(150);
    // Haiku at 700 in × $0.25/M + 150 out × $1.25/M = $0.000175 + $0.0001875 ≈ $0.0003625
    expect(verdict.costUsd).toBeGreaterThan(0);
    expect(verdict.costUsd).toBeCloseTo(0.0003625, 6);
  });

  it("skips sub-threshold candidates without invoking Bedrock", async () => {
    const invoker = stubInvoker();
    const ratifier = createRatifier({
      mode: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
      ratificationThreshold: 0.7,
    });

    const verdict = await ratifier.ratify(candidate({ confidence: 0.5 }));

    expect(verdict.status).toBe("not-required");
    expect(verdict.costUsd).toBe(0);
    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("skips hold-type candidates without invoking Bedrock", async () => {
    const invoker = stubInvoker();
    const ratifier = createRatifier({
      mode: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
    });

    const verdict = await ratifier.ratify(candidate({ type: "hold" }));

    expect(verdict.status).toBe("not-required");
    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("maps Bedrock verdictKind=downgrade to status=downgraded", async () => {
    const invoker = stubInvoker(
      vi.fn().mockResolvedValue({
        verdictKind: "downgrade",
        ratifiedConfidence: 0.4,
        inputTokens: 700,
        outputTokens: 150,
      }),
    );
    const ratifier = createRatifier({
      mode: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
    });

    const verdict = await ratifier.ratify(candidate());
    expect(verdict.status).toBe("downgraded");
    expect(verdict.verdictKind).toBe("downgrade");
  });

  it("maps Bedrock verdictKind=fallback to status=not-required but still records cost", async () => {
    const invoker = stubInvoker(
      vi.fn().mockResolvedValue({
        verdictKind: "fallback",
        ratifiedConfidence: 0.8,
        inputTokens: 0,
        outputTokens: 0,
      }),
    );
    const ratifier = createRatifier({
      mode: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
    });

    const verdict = await ratifier.ratify(candidate());
    expect(verdict.status).toBe("not-required");
    expect(verdict.verdictKind).toBe("fallback");
  });

  it("Sonnet pricing is higher than Haiku for the same token counts", async () => {
    const haikuInvoker = stubInvoker();
    const sonnetInvoker = stubInvoker();
    const haikuRatifier = createRatifier({
      mode: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: haikuInvoker,
    });
    const sonnetRatifier = createRatifier({
      mode: "replay-bedrock",
      model: "sonnet",
      bedrockInvoker: sonnetInvoker,
    });

    const h = await haikuRatifier.ratify(candidate());
    const s = await sonnetRatifier.ratify(candidate());

    expect(s.costUsd).toBeGreaterThan(h.costUsd);
    // Sonnet is ~12× Haiku — the ratio should be between 8× and 16×.
    expect(s.costUsd / h.costUsd).toBeGreaterThan(8);
    expect(s.costUsd / h.costUsd).toBeLessThan(16);
  });

  it("throws if bedrockInvoker is not provided", () => {
    expect(() => createRatifier({ mode: "replay-bedrock", model: "haiku" })).toThrow(
      /replay-bedrock mode requires/,
    );
  });
});

// ---------------------------------------------------------------------------
// bedrockCallCostUsd helper
// ---------------------------------------------------------------------------

describe("bedrockCallCostUsd", () => {
  it("zero tokens → zero cost", () => {
    expect(bedrockCallCostUsd(0, 0, "haiku")).toBe(0);
    expect(bedrockCallCostUsd(0, 0, "sonnet")).toBe(0);
  });

  it("matches the production pricing constants", () => {
    // Haiku: $0.25 / $1.25 per 1M.
    expect(bedrockCallCostUsd(1_000_000, 0, "haiku")).toBeCloseTo(0.25, 8);
    expect(bedrockCallCostUsd(0, 1_000_000, "haiku")).toBeCloseTo(1.25, 8);
    // Sonnet: $3 / $15 per 1M.
    expect(bedrockCallCostUsd(1_000_000, 0, "sonnet")).toBeCloseTo(3, 8);
    expect(bedrockCallCostUsd(0, 1_000_000, "sonnet")).toBeCloseTo(15, 8);
  });
});

// ---------------------------------------------------------------------------
// Default threshold sanity
// ---------------------------------------------------------------------------

describe("DEFAULT_RATIFICATION_THRESHOLD", () => {
  it("is in (0, 1)", () => {
    expect(DEFAULT_RATIFICATION_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_RATIFICATION_THRESHOLD).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// extractCachedRatification — dual shape (canonical nested + admin-debug flat)
// ---------------------------------------------------------------------------
//
// Background: rows in the production `ratifications` table are written by two
// paths with DIFFERENT field layouts. The reviewer flagged that `DdbRatificationsLookup`
// was only reading the FLAT shape (admin-debug rows, ~1% of rows), silently
// missing the canonical nested shape used by the bulk path.
//
//   - Canonical bulk path (`ingestion/src/lib/ratification-store.ts:putRatificationRecord`):
//     Writes the verdict NESTED under `ratified: BlendedSignal | null`. Used for
//     every per-bar LLM ratification — the dominant production write path.
//
//   - Admin-debug path (`backend/src/services/admin-debug.service.ts:forceRatification`):
//     Writes `ratified` nested AND additionally writes flat top-level fields
//     (`ratifiedType`, `ratifiedConfidence`, `verdictKind`). Manual debug only,
//     ~1% of rows.
//
// These tests exercise BOTH shapes and confirm cache-only mode pulls verdicts
// out of either layout.

describe("extractCachedRatification", () => {
  it("reads the canonical nested shape (production bulk path)", () => {
    // Shape produced by ingestion/src/lib/ratification-store.ts: the verdict
    // lives under `ratified: BlendedSignal`, with no flat top-level fields.
    const item = {
      pair: "BTC/USDT",
      timeframe: "1h",
      validation: { ok: true },
      ratified: {
        type: "buy",
        confidence: 0.72,
        verdictKind: "ratify",
        // BlendedSignal also carries pair/asOf/rulesFired/etc. — we only need
        // type+confidence+verdictKind for cache-only mode.
        pair: "BTC/USDT",
        rulesFired: ["ema-cross"],
        asOf: 1_700_000_000_000,
      },
      cacheHit: false,
      invokedAt: "2026-01-15T10:00:00.000Z",
    };

    const result = extractCachedRatification(item);

    expect(result).not.toBeNull();
    expect(result!.ratifiedType).toBe("buy");
    expect(result!.ratifiedConfidence).toBe(0.72);
    expect(result!.verdictKind).toBe("ratify");
  });

  it("reads the flat admin-debug shape when `ratified` is null", () => {
    // Shape produced by backend/src/services/admin-debug.service.ts on a
    // FALLBACK row — `ratified: null` but flat fields still carry the verdict.
    const item = {
      pair: "BTC/USDT",
      timeframe: "1h",
      validation: { ok: true },
      ratified: null,
      ratifiedType: "sell",
      ratifiedConfidence: 0.65,
      verdictKind: "downgrade",
      invokedReason: "manual",
      invokedAt: "2026-01-15T10:00:00.000Z",
    };

    const result = extractCachedRatification(item);

    expect(result).not.toBeNull();
    expect(result!.ratifiedType).toBe("sell");
    expect(result!.ratifiedConfidence).toBe(0.65);
    expect(result!.verdictKind).toBe("downgrade");
  });

  it("prefers the nested shape when both nested and flat fields exist", () => {
    // Admin-debug writes BOTH shapes simultaneously. The nested shape is
    // canonical, so it must win — flat is a back-compat fallback only.
    const item = {
      pair: "BTC/USDT",
      timeframe: "1h",
      validation: { ok: true },
      ratified: {
        type: "buy",
        confidence: 0.9,
        verdictKind: "ratify",
        pair: "BTC/USDT",
        rulesFired: [],
        asOf: 1_700_000_000_000,
      },
      ratifiedType: "sell", // stale/divergent value — must be ignored
      ratifiedConfidence: 0.3,
      verdictKind: "downgrade",
      invokedAt: "2026-01-15T10:00:00.000Z",
    };

    const result = extractCachedRatification(item);

    expect(result).not.toBeNull();
    expect(result!.ratifiedType).toBe("buy");
    expect(result!.ratifiedConfidence).toBe(0.9);
    expect(result!.verdictKind).toBe("ratify");
  });

  it("returns null when neither shape has usable verdict data", () => {
    // Pure fallback row from canonical path: ratified=null, no flat fields.
    const item = {
      pair: "BTC/USDT",
      timeframe: "1h",
      validation: { ok: false, reason: "bedrock_fallback" },
      ratified: null,
      cacheHit: false,
      fellBackToAlgo: true,
      invokedAt: "2026-01-15T10:00:00.000Z",
    };

    expect(extractCachedRatification(item)).toBeNull();
  });

  it("normalises unknown verdictKind values to 'ratify'", () => {
    const item = {
      pair: "BTC/USDT",
      timeframe: "1h",
      validation: { ok: true },
      ratified: {
        type: "buy",
        confidence: 0.7,
        verdictKind: "some-future-value", // unknown — must fall back
        pair: "BTC/USDT",
        rulesFired: [],
        asOf: 1_700_000_000_000,
      },
      invokedAt: "2026-01-15T10:00:00.000Z",
    };

    const result = extractCachedRatification(item);
    expect(result!.verdictKind).toBe("ratify");
  });
});
