/**
 * BacktestEngine — Phase 1.
 *
 * Replays historical candles through the production algorithm
 * (canonicalizeCandle → buildIndicatorState → evaluateGates → scoreTimeframe
 * → resolveOutcome) without touching production code paths.
 *
 * Phase 1 constraints (faithful-reproduction commitments — see PR #372 reviewer
 * findings 1-4):
 *   - Single timeframe (emitting TF only — multi-TF blend is Phase 2)
 *   - Algo-only (no Bedrock ratification — that is Phase 2)
 *   - Source = production candles table (archive backfill is a separate prereq)
 *   - priceAtSignal / priceAtResolution use canonical median-of-exchanges close
 *     (mirrors `indicator-handler.ts:706`).
 *   - IndicatorState built from the longest exchange history with the head bar
 *     substituted by the canonical consensus candle (mirrors
 *     `indicator-handler.ts:727-728`).
 *   - Gates evaluated via `evaluateGates` and passed into `scoreTimeframe`.
 *   - fearGreed and (per-bar historical) dispersion are stubbed to null —
 *     rules that depend on them will not fire. See PR description (Path B).
 */

import { RULES } from "@quantara/shared";
import type { Candle, Timeframe } from "@quantara/shared";
import { buildIndicatorState } from "quantara-ingestion/src/indicators/index.js";
import { canonicalizeCandle } from "quantara-ingestion/src/lib/canonicalize.js";
import { scoreTimeframe } from "quantara-ingestion/src/signals/score.js";
import { evaluateGates, narrowPair } from "quantara-ingestion/src/signals/gates.js";
import { resolveOutcome } from "quantara-ingestion/src/outcomes/resolver.js";
import type { BlendedSignalRecord } from "quantara-ingestion/src/outcomes/resolver.js";

import type { HistoricalCandleStore } from "./store/candle-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 5-tier signal type (buy/sell/hold/strong-buy/strong-sell). */
export type SignalType = "strong-buy" | "buy" | "hold" | "sell" | "strong-sell";

export interface BacktestInput {
  pair: string;
  /**
   * Deprecated in Phase 1 §canonicalize: candles are now fetched for all
   * production exchanges and combined via `canonicalizeCandle`. The field is
   * preserved so existing callers don't break; it is ignored by `run()` when
   * canonicalization is in effect (i.e. always, in this phase).
   */
  exchange?: string;
  /** The emitting timeframe. Phase 1: single-TF only. */
  timeframe: Timeframe;
  from: Date;
  to: Date;
}

export interface BacktestResult {
  signals: BacktestSignal[];
  metrics: AggregateMetrics;
  meta: {
    startedAt: string;
    durationMs: number;
    candleCount: number;
    pair: string;
    timeframe: Timeframe;
    from: string;
    to: string;
    /** Number of evaluation bars skipped because canonicalizeCandle returned null. */
    skippedNoConsensus: number;
  };
}

export interface BacktestSignal {
  emittedAt: string;
  closeTime: number;
  pair: string;
  timeframe: Timeframe;
  type: SignalType;
  confidence: number;
  rulesFired: string[];
  /** Gate decision from evaluateGates — null when no gate fired. */
  gateReason: "vol" | "dispersion" | "stale" | null;
  /** null if signal hasn't expired by `to`, or if resolution candle has no consensus. */
  resolvedAt: string | null;
  outcome: "correct" | "incorrect" | "neutral" | null;
  priceMovePct: number | null;
  /** Canonical (median-of-exchanges) close at emission. */
  priceAtSignal: number;
  /** Canonical (median-of-exchanges) close at expiresAt — null when no consensus. */
  priceAtResolution: number | null;
  expiresAt: string;
}

export interface AggregateMetrics {
  totalSignals: number;
  byType: Partial<Record<SignalType, number>>;
  byOutcome: {
    correct: number;
    incorrect: number;
    neutral: number;
    unresolved: number;
  };
  /** Mean (confidence − outcome_win)^2 across resolved signals. null when no resolved signals. */
  brierScore: number | null;
  /** correct / (correct + incorrect). null when no resolved directional signals. */
  winRate: number | null;
  /** Mean directional price move pct across resolved buy/sell signals. null when none. */
  meanReturnPct: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Timeframe duration in milliseconds — mirrors higher-tf-poller-handler.ts.
 * 4-bar expiry per PR #359 convention.
 */
const TF_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

const EXPIRY_BARS = 4;

/**
 * Warmup bars: max lookback for EMA200 + extra padding.
 * 200 bars for EMA200, +5 for good measure.
 */
const WARMUP_BARS = 205;

/** Mirrors DISPERSION_HISTORY_SIZE in `indicator-handler.ts:500`. */
const DISPERSION_HISTORY_SIZE = 5;

/** Tolerance (ms) for matching the same closeTime across exchanges. */
const CLOSE_TIME_MATCH_TOLERANCE_MS = 1;

// ---------------------------------------------------------------------------
// BacktestEngine
// ---------------------------------------------------------------------------

export class BacktestEngine {
  constructor(private readonly candleStore: HistoricalCandleStore) {}

  async run(input: BacktestInput): Promise<BacktestResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const { pair, timeframe, from, to } = input;
    const tfMs = TF_MS[timeframe];

    // Extend fetch window back by warmup bars to ensure indicators are seeded.
    const fetchFrom = new Date(from.getTime() - WARMUP_BARS * tfMs);

    // §canonicalize: pull all three production exchanges and combine per bar.
    const perExchangeHistoryRaw = await this.candleStore.getCandlesForAllExchanges(
      pair,
      timeframe,
      fetchFrom,
      to,
    );

    const exchanges = Object.keys(perExchangeHistoryRaw).sort();
    if (exchanges.length === 0) {
      return emptyResult(startedAt, t0, pair, timeframe, from, to, 0);
    }

    // Sort each exchange's candles chronologically (oldest first) and build a
    // closeTime→Candle Map per exchange for O(1) lookups in the hot loop.
    // The Map also doubles as the "exchange has a candle at this closeTime"
    // staleness signal (consistent with how indicator-handler.ts treats a
    // missing candle at a closeTime as stale, see lines 690-703).
    const perExchangeSorted: Record<string, Candle[]> = {};
    const perExchangeByCloseTime: Record<string, Map<number, Candle>> = {};
    let totalCandles = 0;
    for (const ex of exchanges) {
      const sorted = [...perExchangeHistoryRaw[ex]!].sort((a, b) => a.openTime - b.openTime);
      perExchangeSorted[ex] = sorted;
      const byClose = new Map<number, Candle>();
      for (const c of sorted) {
        byClose.set(c.closeTime, c);
      }
      perExchangeByCloseTime[ex] = byClose;
      totalCandles += sorted.length;
    }

    // Pick the exchange with the longest history — used as the "base" candle
    // series for buildIndicatorState (head bar substituted by consensus).
    // Mirrors indicator-handler.ts:715-719.
    const longestExchange = exchanges.reduce((best, ex) => {
      return (perExchangeSorted[ex]?.length ?? 0) > (perExchangeSorted[best]?.length ?? 0)
        ? ex
        : best;
    }, exchanges[0]!);
    const baseSeries = perExchangeSorted[longestExchange]!;

    if (baseSeries.length === 0) {
      return emptyResult(startedAt, t0, pair, timeframe, from, to, 0);
    }

    // Iterate the longest exchange's series as the candidate emission timeline.
    // Evaluation candles are those whose closeTime is in [from, to]. Production
    // indicator-handler.ts:223 treats expiresAt <= now as resolvable (inclusive),
    // so we use closeTime <= to.getTime() for emission too — keeping the
    // resolution-boundary semantic consistent with production.
    const evalCandles = baseSeries.filter(
      (c) => c.closeTime >= from.getTime() && c.closeTime <= to.getTime(),
    );

    // Build a closeTime → index map on baseSeries so the per-eval-bar lookback
    // slice is O(1) (replaces the O(n²) Array.indexOf in the previous impl,
    // see PR #372 reviewer finding 5).
    const baseIndexByCloseTime = new Map<number, number>();
    for (let i = 0; i < baseSeries.length; i++) {
      baseIndexByCloseTime.set(baseSeries[i]!.closeTime, i);
    }

    const signals: BacktestSignal[] = [];
    // Cooldown tracking: ruleName → bars since last fire.
    const lastFireBars: Record<string, number> = {};
    // Rolling dispersion history (most-recent first, length ≤ DISPERSION_HISTORY_SIZE).
    let dispersionHistory: number[] = [];
    let skippedNoConsensus = 0;

    // For finding canonical close at resolution time, we union all candle
    // closeTimes across exchanges so resolution-bar lookups can find candles
    // that exist on exchanges other than the base series.
    const allCloseTimes = new Set<number>();
    for (const ex of exchanges) {
      for (const c of perExchangeSorted[ex]!) {
        allCloseTimes.add(c.closeTime);
      }
    }
    const sortedCloseTimes = [...allCloseTimes].sort((a, b) => a - b);

    for (let i = 0; i < evalCandles.length; i++) {
      const candle = evalCandles[i]!;
      const closeTime = candle.closeTime;

      // §canonicalize: gather per-exchange candle at this closeTime + staleness.
      const { perExchange, staleness } = collectPerExchange(
        exchanges,
        perExchangeByCloseTime,
        closeTime,
      );

      const canon = canonicalizeCandle(perExchange, staleness);
      if (canon === null) {
        // <2 eligible exchanges → no consensus. Treat as ungatable: skip and
        // record for meta. Documented in PR description.
        skippedNoConsensus += 1;
        continue;
      }

      // §indicator-state: substitute consensus candle for the head bar of the
      // longest-history exchange's series, then build state on
      // chronologically-ordered slice up to and including this close.
      const baseIdx = baseIndexByCloseTime.get(closeTime);
      if (baseIdx === undefined) {
        // The base series doesn't have a bar at this closeTime (shouldn't
        // happen because evalCandles iterates baseSeries) — skip defensively.
        continue;
      }
      // Slice baseSeries up through the current bar, then replace the head
      // (most-recent) candle with the canonical consensus candle. Production
      // does this by building [canon.consensus, ...baseCandles.slice(1)] in
      // newest-first order, then reversing — we replicate that exactly.
      const baseUpToHere = baseSeries.slice(0, baseIdx + 1);
      const baseNewestFirst = [...baseUpToHere].reverse();
      const candlesNewestFirst: Candle[] = [canon.consensus, ...baseNewestFirst.slice(1)];
      const candlesOldestFirst = [...candlesNewestFirst].reverse();

      // §3 Path B: fearGreed stays null in Phase 1. Logged once at the smoke
      // entry point — see smoke.ts.
      const state = buildIndicatorState(candlesOldestFirst, {
        pair,
        exchange: "consensus",
        timeframe,
        fearGreed: null,
        dispersion: canon.dispersion,
      });

      // Update dispersion history (most-recent first), then evaluate gates.
      dispersionHistory = [canon.dispersion, ...dispersionHistory].slice(
        0,
        DISPERSION_HISTORY_SIZE,
      );

      // Increment all cooldown counters before scoring.
      for (const key of Object.keys(lastFireBars)) {
        lastFireBars[key] = (lastFireBars[key] ?? 0) + 1;
      }

      // §4 evaluateGates: requires staleness to have exactly 3 keys (asserted
      // in gates.ts:111). We pass the full per-exchange staleness map (one
      // entry per production exchange, present even when empty), matching
      // indicator-handler.ts:755.
      let gateResult: ReturnType<typeof evaluateGates>;
      try {
        gateResult = evaluateGates(state, narrowPair(pair), dispersionHistory, staleness);
      } catch {
        // narrowPair throws for non-production pairs (test fixtures, e.g.).
        // Without a recognised pair we can't run the vol gate; pass a no-fire
        // result so the backtest still produces signals — Phase 1 acceptable.
        gateResult = { fired: false, reason: null };
      }

      const vote = scoreTimeframe(state, RULES, lastFireBars, { gateResult });

      if (vote === null) {
        // No eligible rules yet (still warming up) — skip.
        continue;
      }

      // Update cooldown for rules that fired.
      for (const ruleName of vote.rulesFired) {
        lastFireBars[ruleName] = 0;
      }

      const priceAtSignal = canon.consensus.close;
      // §5 atr-pct guard: only divide when priceAtSignal > 0 (matches
      // indicator-handler.ts production guard).
      const atrPct = state.atr14 !== null && priceAtSignal > 0 ? state.atr14 / priceAtSignal : 0;
      const expiresAtMs = closeTime + EXPIRY_BARS * tfMs;
      const expiresAt = new Date(expiresAtMs).toISOString();

      const signal: BacktestSignal = {
        emittedAt: new Date(closeTime).toISOString(),
        closeTime,
        pair,
        timeframe,
        type: vote.type,
        confidence: vote.confidence,
        rulesFired: vote.rulesFired,
        gateReason: vote.gateReason ?? null,
        resolvedAt: null,
        outcome: null,
        priceMovePct: null,
        priceAtSignal,
        priceAtResolution: null,
        expiresAt,
      };

      // §9 boundary: production resolves when expiresAt <= now (inclusive).
      // We mirror that with <= to.getTime() so a bar that expires exactly at
      // the window edge still resolves.
      if (expiresAtMs <= to.getTime()) {
        const resolutionCloseTime = findNearestCloseTime(sortedCloseTimes, expiresAtMs);

        if (resolutionCloseTime !== null) {
          // §canonicalize: priceAtResolution is canonical, same as priceAtSignal.
          const { perExchange: perExResolution, staleness: stalenessResolution } =
            collectPerExchange(exchanges, perExchangeByCloseTime, resolutionCloseTime);
          const canonResolution = canonicalizeCandle(perExResolution, stalenessResolution);

          if (canonResolution !== null) {
            const priceAtResolution = canonResolution.consensus.close;
            const signalId = `backtest-${pair}-${timeframe}-${closeTime}`;
            const signalRecord: BlendedSignalRecord = {
              signalId,
              sk: `${timeframe}#${closeTime}`,
              pair,
              type: toResolverType(vote.type),
              confidence: vote.confidence,
              createdAt: signal.emittedAt,
              expiresAt,
              priceAtSignal,
              atrPctAtSignal: atrPct,
              gateReason: vote.gateReason,
              rulesFired: vote.rulesFired,
              emittingTimeframe: timeframe,
              invalidatedAt: null,
            };

            const outcomeRecord = resolveOutcome(
              signalRecord,
              priceAtResolution,
              atrPct,
              new Date(expiresAtMs).toISOString(),
            );

            signal.resolvedAt = outcomeRecord.resolvedAt;
            signal.outcome = outcomeRecord.outcome;
            signal.priceMovePct = outcomeRecord.priceMovePct;
            signal.priceAtResolution = priceAtResolution;
          }
          // If canonResolution is null we leave the signal unresolved — the
          // resolution bar lacks cross-exchange consensus, which we cannot
          // fabricate without diverging from production semantics.
        }
      }

      signals.push(signal);
    }

    const metrics = computeMetrics(signals);

    return {
      signals,
      metrics,
      meta: {
        startedAt,
        durationMs: Date.now() - t0,
        candleCount: totalCandles,
        pair,
        timeframe,
        from: from.toISOString(),
        to: to.toISOString(),
        skippedNoConsensus,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the per-exchange Candle map + staleness map at a given closeTime.
 * staleness[ex] = true when the exchange has no candle at this closeTime
 * (within tolerance) — matches the "missing candle ⇒ stale" rule in
 * indicator-handler.ts:703.
 */
function collectPerExchange(
  exchanges: string[],
  perExchangeByCloseTime: Record<string, Map<number, Candle>>,
  closeTime: number,
): { perExchange: Record<string, Candle | null>; staleness: Record<string, boolean> } {
  const perExchange: Record<string, Candle | null> = {};
  const staleness: Record<string, boolean> = {};
  for (const ex of exchanges) {
    const byClose = perExchangeByCloseTime[ex]!;
    // Exact-match O(1) lookup first; fall back to a small tolerance window
    // (some exchanges report closeTime off by 1ms — same as indicator-handler).
    let match = byClose.get(closeTime) ?? null;
    if (match === null && CLOSE_TIME_MATCH_TOLERANCE_MS > 0) {
      for (let delta = 1; delta <= CLOSE_TIME_MATCH_TOLERANCE_MS; delta++) {
        match = byClose.get(closeTime + delta) ?? byClose.get(closeTime - delta) ?? null;
        if (match !== null) break;
      }
    }
    perExchange[ex] = match;
    staleness[ex] = match === null;
  }
  return { perExchange, staleness };
}

/**
 * Map the 5-tier SignalType to the resolver's 3-type SignalType.
 * strong-buy → buy, strong-sell → sell, hold → hold.
 */
function toResolverType(type: SignalType): "buy" | "sell" | "hold" {
  if (type === "strong-buy" || type === "buy") return "buy";
  if (type === "strong-sell" || type === "sell") return "sell";
  return "hold";
}

/**
 * Binary search for the first closeTime >= targetMs.
 * Returns null if no such entry exists.
 *
 * Replaces the previous O(n) linear scan; the eval loop calls this once per
 * resolved signal, so on a 30-day 1h backtest (~700 signals × 925 candles)
 * the speed-up is meaningful.
 */
function findNearestCloseTime(sortedCloseTimes: number[], targetMs: number): number | null {
  let lo = 0;
  let hi = sortedCloseTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedCloseTimes[mid]! < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo < sortedCloseTimes.length ? sortedCloseTimes[lo]! : null;
}

function emptyMetrics(): AggregateMetrics {
  return {
    totalSignals: 0,
    byType: {},
    byOutcome: { correct: 0, incorrect: 0, neutral: 0, unresolved: 0 },
    brierScore: null,
    winRate: null,
    meanReturnPct: null,
  };
}

function emptyResult(
  startedAt: string,
  t0: number,
  pair: string,
  timeframe: Timeframe,
  from: Date,
  to: Date,
  candleCount: number,
): BacktestResult {
  return {
    signals: [],
    metrics: emptyMetrics(),
    meta: {
      startedAt,
      durationMs: Date.now() - t0,
      candleCount,
      pair,
      timeframe,
      from: from.toISOString(),
      to: to.toISOString(),
      skippedNoConsensus: 0,
    },
  };
}

function computeMetrics(signals: BacktestSignal[]): AggregateMetrics {
  if (signals.length === 0) return emptyMetrics();

  const byType: Partial<Record<SignalType, number>> = {};
  const byOutcome = { correct: 0, incorrect: 0, neutral: 0, unresolved: 0 };

  let brierSum = 0;
  let brierCount = 0;
  let winCount = 0;
  let lossCount = 0;
  let returnSum = 0;
  let returnCount = 0;

  for (const s of signals) {
    // Count by type.
    byType[s.type] = (byType[s.type] ?? 0) + 1;

    // Count by outcome.
    if (s.outcome === null) {
      byOutcome.unresolved += 1;
    } else {
      byOutcome[s.outcome] += 1;

      // Brier score: (confidence − outcome_win)^2
      // outcome_win = 1 if correct, 0 otherwise (for directional signals).
      // Hold "correct" = price didn't move much — treated as win for Brier.
      const win = s.outcome === "correct" ? 1 : 0;
      brierSum += (s.confidence - win) ** 2;
      brierCount += 1;

      // Win rate: correct / (correct + incorrect) for directional signals only.
      if (s.type !== "hold") {
        if (s.outcome === "correct") winCount += 1;
        else if (s.outcome === "incorrect") lossCount += 1;
      }

      // Mean return: directional signals only.
      if ((s.type === "buy" || s.type === "strong-buy") && s.priceMovePct !== null) {
        returnSum += s.priceMovePct;
        returnCount += 1;
      } else if ((s.type === "sell" || s.type === "strong-sell") && s.priceMovePct !== null) {
        // Invert price move for sell signals (negative move = positive return).
        returnSum += -s.priceMovePct;
        returnCount += 1;
      }
    }
  }

  const directional = winCount + lossCount;

  return {
    totalSignals: signals.length,
    byType,
    byOutcome,
    brierScore: brierCount > 0 ? brierSum / brierCount : null,
    winRate: directional > 0 ? winCount / directional : null,
    meanReturnPct: returnCount > 0 ? returnSum / returnCount : null,
  };
}
