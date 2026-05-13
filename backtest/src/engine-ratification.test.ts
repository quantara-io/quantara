/**
 * BacktestEngine ratification-mode tests — Phase 2 follow-up
 * (PR #373 review findings 1 & 2).
 *
 * Verify that the engine:
 *   - threads `input.ratification` through to the per-signal Ratifier,
 *   - applies cache-only verdicts to BacktestSignal.ratifiedType/Confidence,
 *   - applies replay-bedrock verdicts and accumulates `meta.actualCostUsd`,
 *   - aborts mid-run when `maxCostUsd` is exceeded, writing
 *     `meta.aborted: true` and `meta.abortReason: "cost-ceiling"`.
 *
 * No real AWS calls — the cache lookup and Bedrock invoker are in-memory stubs.
 *
 * Fixture strategy (PR #373 reviewer round 3):
 * ----------------------------------------------
 * Earlier revisions used a flat-close candle stream — every bar's close equal
 * to the last — which scored as `hold` for every emit (no rule could fire on
 * zero-delta returns). The ratification assertions below all live downstream
 * of the gate that BedrockRatifier / CacheOnlyRatifier apply on holds, so a
 * flat fixture exercises zero of the load-bearing paths. Tests passed by
 * accident because every assertion was wrapped in `if (calls.length > 0)`.
 *
 * This rewrite uses a STEADY-DECLINE fixture: every bar closes -0.5% from the
 * previous. Properties:
 *   - Constant log returns → realized-vol stdev = 0, so the vol gate stays off.
 *   - All deltas negative → RSI = 0 after warmup, firing `rsi-oversold-strong`
 *     (bullish, strength 1.5 ≥ MIN_CONFLUENCE) on every emit.
 *   - Result: a stream of `buy` signals with confidence ≈ 0.679, which clears
 *     `DEFAULT_RATIFICATION_THRESHOLD` (0.6) so the ratifier ACTUALLY runs.
 *
 * All ratifier assertions below are now UNCONDITIONAL — no `if (calls > 0)`
 * guards. If the fixture stops producing non-holds (e.g. the rule library or
 * threshold changes), the failure should be loud, not silent.
 */

import { describe, it, expect, vi } from "vitest";
import type { Candle, Timeframe } from "@quantara/shared";

import { BacktestEngine } from "./engine.js";
import type { HistoricalCandleStore } from "./store/candle-store.js";
import type {
  BedrockInvocationResult,
  BedrockInvoker,
  CachedRatification,
  RatificationCandidate,
  RatificationsLookup,
} from "./ratification/ratifier.js";

// ---------------------------------------------------------------------------
// Synthetic candle factories
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000_000;
const TF_MS_1H = 3_600_000;
const PRODUCTION_EXCHANGES = ["binanceus", "coinbase", "kraken"] as const;

/**
 * Flat-close stream — every close equals `baseClose`. Used only to verify the
 * `skip` mode default (which short-circuits before the ratifier sees the
 * candidate type, so a flat stream is fine here).
 */
function makeFlatCandles(
  count: number,
  baseClose = 30_000,
  pair = "BTC/USDT",
  timeframe: Timeframe = "1h",
  tfMs = TF_MS_1H,
): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = BASE_TIME + i * tfMs;
    const closeTime = openTime + tfMs - 1;
    return {
      exchange: "binanceus",
      symbol: pair,
      pair,
      timeframe,
      openTime,
      closeTime,
      open: baseClose,
      high: baseClose * 1.001,
      low: baseClose * 0.999,
      close: baseClose,
      volume: 100,
      isClosed: true,
      source: "backfill" as const,
    };
  });
}

/**
 * Steady-decline candle stream. Each bar closes (1 - dropPct) × the previous
 * close. Because log returns are constant the realized-vol gate stays off,
 * and because every delta is negative RSI converges to 0 → fires the bullish
 * `rsi-oversold-strong` rule (strength 1.5). Result: every post-warmup emit
 * is a `buy` with confidence ≈ 0.679 — above the default 0.6 ratification
 * threshold so the ratifier fires.
 *
 * Producing roughly 55 non-hold emits across the standard eval window
 * (bars 205..259), which is enough to:
 *   - prove cost-accumulation works,
 *   - construct mid-run cost-ceiling aborts at a chosen N,
 *   - construct cache-hit assertions on the same closeTimes the engine emits.
 */
function makeDecliningCandles(
  count: number,
  basePrice = 30_000,
  dropPct = 0.005,
  pair = "BTC/USDT",
  timeframe: Timeframe = "1h",
  tfMs = TF_MS_1H,
): Candle[] {
  const result: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const openTime = BASE_TIME + i * tfMs;
    const closeTime = openTime + tfMs - 1;
    const prevPrice = price;
    price = price * (1 - dropPct);
    result.push({
      exchange: "binanceus",
      symbol: pair,
      pair,
      timeframe,
      openTime,
      closeTime,
      open: prevPrice,
      high: prevPrice * 1.0005,
      low: price * 0.9995,
      close: price,
      volume: 100,
      isClosed: true,
      source: "backfill" as const,
    });
  }
  return result;
}

function mockStore(
  candles: Candle[],
  pair = "BTC/USDT",
  timeframe: Timeframe = "1h",
): HistoricalCandleStore {
  const perExchange: Record<string, Candle[]> = {};
  for (const ex of PRODUCTION_EXCHANGES) {
    perExchange[ex] = candles.map((c) => ({ ...c, exchange: ex }));
  }
  return {
    getCandles: vi.fn().mockResolvedValue([]),
    getCandlesForAllExchanges: vi.fn().mockImplementation(async (callPair, callTf) => {
      if (callPair !== pair || callTf !== timeframe) return {};
      return perExchange;
    }),
  };
}

// ---------------------------------------------------------------------------
// In-memory ratification stubs
// ---------------------------------------------------------------------------

function recordingInvoker(
  responseFor: (c: RatificationCandidate) => BedrockInvocationResult,
): BedrockInvoker & { calls: RatificationCandidate[] } {
  const calls: RatificationCandidate[] = [];
  return {
    calls,
    invoke: vi.fn().mockImplementation(async (c: RatificationCandidate) => {
      calls.push(c);
      return responseFor(c);
    }),
  } as BedrockInvoker & { calls: RatificationCandidate[] };
}

function recordingLookup(
  cache: Map<string, CachedRatification>,
): RatificationsLookup & { calls: number } {
  const wrapper = { calls: 0 } as RatificationsLookup & { calls: number };
  wrapper.lookup = vi
    .fn()
    .mockImplementation(async (pair: string, tf: string, closeTime: number) => {
      wrapper.calls += 1;
      return cache.get(`${pair}|${tf}|${closeTime}`) ?? null;
    });
  return wrapper;
}

// ---------------------------------------------------------------------------
// Skip mode (default — Phase 1 parity)
// ---------------------------------------------------------------------------

describe("BacktestEngine ratification=skip (default)", () => {
  it("emits signals with ratificationStatus=not-required and no Bedrock cost", async () => {
    // Skip mode short-circuits at the ratifier — flat candles are fine because
    // the assertions don't depend on signal type, only on `ratificationStatus`.
    const candles = makeFlatCandles(260);
    const engine = new BacktestEngine(mockStore(candles));

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS_1H),
      to: new Date(BASE_TIME + 259 * TF_MS_1H),
    });

    expect(result.meta.actualCostUsd).toBe(0);
    expect(result.meta.aborted).toBeFalsy();
    expect(result.meta.ratificationMode).toBe("skip");
    for (const sig of result.signals) {
      expect(sig.ratificationStatus).toBe("not-required");
      expect(sig.ratifiedType).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Cache-only mode
// ---------------------------------------------------------------------------

describe("BacktestEngine ratification=cache-only", () => {
  it("hydrates ratifiedType/Confidence from the cache when a row exists", async () => {
    // Steady-decline fixture → bars 205..259 emit `buy` (rsi-oversold-strong).
    const candles = makeDecliningCandles(260);
    const cache = new Map<string, CachedRatification>();
    // Seed the cache for every emitting bar in the eval window.
    for (let i = 205; i < 260; i++) {
      const closeTime = BASE_TIME + i * TF_MS_1H + TF_MS_1H - 1;
      cache.set(`BTC/USDT|1h|${closeTime}`, {
        ratifiedType: "buy",
        ratifiedConfidence: 0.77,
        verdictKind: "ratify",
      });
    }
    const lookup = recordingLookup(cache);
    const engine = new BacktestEngine(mockStore(candles));

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS_1H),
      to: new Date(BASE_TIME + 259 * TF_MS_1H),
      ratification: "cache-only",
      ratificationsLookup: lookup,
    });

    expect(result.meta.ratificationMode).toBe("cache-only");
    expect(result.meta.actualCostUsd).toBe(0);

    // UNCONDITIONAL: the fixture is engineered to produce ratifiable non-holds.
    // If this assertion fails, the fixture is broken — do NOT wrap in a guard.
    const hits = result.signals.filter((s) => s.ratificationStatus === "ratified");
    expect(hits.length).toBeGreaterThan(0);
    expect(lookup.calls).toBeGreaterThan(0);

    for (const sig of hits) {
      expect(sig.ratifiedType).toBe("buy");
      expect(sig.ratifiedConfidence).toBe(0.77);
      expect(sig.verdictKind).toBe("ratify");
    }
  });

  it("falls back to not-required on cache miss (zero Bedrock cost)", async () => {
    const candles = makeDecliningCandles(260);
    const lookup = recordingLookup(new Map());
    const engine = new BacktestEngine(mockStore(candles));

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS_1H),
      to: new Date(BASE_TIME + 259 * TF_MS_1H),
      ratification: "cache-only",
      ratificationsLookup: lookup,
    });

    expect(result.meta.actualCostUsd).toBe(0);
    // Cache empty → every gated signal misses → all status=not-required.
    for (const sig of result.signals) {
      expect(sig.ratificationStatus).toBe("not-required");
    }
    // The fixture produces non-holds — the lookup MUST have been consulted.
    expect(lookup.calls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Replay-bedrock mode + cost-ceiling abort
// ---------------------------------------------------------------------------

describe("BacktestEngine ratification=replay-bedrock", () => {
  it("invokes the bedrock stub for gated signals and accumulates actualCostUsd", async () => {
    const candles = makeDecliningCandles(260);
    const invoker = recordingInvoker(() => ({
      verdictKind: "ratify",
      ratifiedConfidence: 0.81,
      inputTokens: 700,
      outputTokens: 150,
    }));
    const engine = new BacktestEngine(mockStore(candles));

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS_1H),
      to: new Date(BASE_TIME + 259 * TF_MS_1H),
      ratification: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
    });

    expect(result.meta.ratificationMode).toBe("replay-bedrock");

    // UNCONDITIONAL: the fixture produces non-holds; the invoker MUST be called.
    expect(invoker.calls.length).toBeGreaterThan(0);
    expect(result.meta.actualCostUsd).toBeGreaterThan(0);
    expect(result.meta.actualTokens?.input ?? 0).toBeGreaterThan(0);
    expect(result.meta.actualTokens?.output ?? 0).toBeGreaterThan(0);

    // Cost should equal calls × per-call cost. Haiku: 700 in × $0.25/M
    // + 150 out × $1.25/M = $0.0003625 per call.
    const expectedPerCall = (700 / 1_000_000) * 0.25 + (150 / 1_000_000) * 1.25;
    expect(result.meta.actualCostUsd).toBeCloseTo(invoker.calls.length * expectedPerCall, 6);

    const ratified = result.signals.filter((s) => s.ratificationStatus === "ratified");
    expect(ratified.length).toBe(invoker.calls.length);
    for (const sig of ratified) {
      expect(sig.ratifiedConfidence).toBe(0.81);
      expect(sig.verdictKind).toBe("ratify");
    }
  });

  it("aborts mid-run at exactly call N when maxCostUsd is exceeded", async () => {
    // Engineer the per-call cost and ceiling so abort fires after a KNOWN call
    // count well below the total non-hold count (~55).
    //   per-call cost (Haiku, 10k in + 10k out)
    //     = (10_000 / 1_000_000) * 0.25 + (10_000 / 1_000_000) * 1.25
    //     = 0.0025 + 0.0125
    //     = 0.015
    //   ceiling = 0.04 → cumulative cost crosses ceiling at call 3 ($0.045 > $0.04)
    // So we expect exactly 3 bedrock invocations and meta.aborted=true.
    const candles = makeDecliningCandles(260);
    const invoker = recordingInvoker(() => ({
      verdictKind: "ratify",
      ratifiedConfidence: 0.85,
      inputTokens: 10_000,
      outputTokens: 10_000,
    }));
    const engine = new BacktestEngine(mockStore(candles));

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS_1H),
      to: new Date(BASE_TIME + 259 * TF_MS_1H),
      ratification: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
      maxCostUsd: 0.04,
    });

    // UNCONDITIONAL: the fixture produces enough non-holds to exceed the ceiling.
    expect(result.meta.aborted).toBe(true);
    expect(result.meta.abortReason).toBe("cost-ceiling");
    expect(invoker.calls.length).toBe(3);
    expect(result.meta.actualCostUsd).toBeCloseTo(0.045, 6);
    expect(result.meta.actualCostUsd).toBeGreaterThan(0.04);
    // The aborting signal IS still included in the partial result, so we
    // should have at least one signal (the one whose ratification tipped over).
    expect(result.signals.length).toBeGreaterThan(0);
    // ...but also FEWER signals than the unbounded run would have produced
    // (~55 emits). Easy lower bound: there are at most as many signals as
    // bars in the eval window, but if abort works there should be far fewer
    // than ~55 emits.
    expect(result.signals.length).toBeLessThan(55);
  });

  it("honours onCostUpdate veto (returning false aborts the run)", async () => {
    const candles = makeDecliningCandles(260);
    let observedCost = 0;
    const invoker = recordingInvoker(() => ({
      verdictKind: "ratify",
      ratifiedConfidence: 0.85,
      inputTokens: 700,
      outputTokens: 150,
    }));
    const engine = new BacktestEngine(mockStore(candles));

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS_1H),
      to: new Date(BASE_TIME + 259 * TF_MS_1H),
      ratification: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
      onCostUpdate: (c) => {
        observedCost = c;
        // Veto on the very first call.
        return false;
      },
    });

    // UNCONDITIONAL: fixture produces a non-hold on the very first eval bar.
    expect(observedCost).toBeGreaterThan(0);
    expect(result.meta.aborted).toBe(true);
    expect(result.meta.abortReason).toBe("cost-ceiling");
    expect(invoker.calls.length).toBe(1);
  });

  it("does not abort when running cost stays under maxCostUsd", async () => {
    const candles = makeDecliningCandles(260);
    const invoker = recordingInvoker(() => ({
      verdictKind: "ratify",
      ratifiedConfidence: 0.85,
      inputTokens: 700,
      outputTokens: 150,
    }));
    const engine = new BacktestEngine(mockStore(candles));

    const result = await engine.run({
      pair: "BTC/USDT",
      timeframe: "1h",
      from: new Date(BASE_TIME + 205 * TF_MS_1H),
      to: new Date(BASE_TIME + 259 * TF_MS_1H),
      ratification: "replay-bedrock",
      model: "haiku",
      bedrockInvoker: invoker,
      maxCostUsd: 1000, // generous ceiling
    });

    expect(result.meta.aborted).toBeFalsy();
    expect(result.meta.abortReason).toBeUndefined();
    // UNCONDITIONAL: with no ceiling pressure the fixture's full non-hold
    // stream should be ratified.
    expect(invoker.calls.length).toBeGreaterThan(10);
  });
});
