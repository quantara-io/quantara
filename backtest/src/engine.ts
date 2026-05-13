/**
 * BacktestEngine — Phase 1.
 *
 * Replays historical candles through the production algorithm (buildIndicatorState →
 * scoreTimeframe → resolveOutcome) without touching production code paths.
 *
 * Phase 1 constraints:
 *   - Single timeframe (emitting TF only — multi-TF blend is Phase 2)
 *   - Algo-only (no Bedrock ratification — that is Phase 2)
 *   - Source = production candles table (archive backfill is a separate prereq)
 */

import { RULES } from "@quantara/shared";
import type { Candle, Timeframe } from "@quantara/shared";
import { buildIndicatorState } from "quantara-ingestion/src/indicators/index.js";
import { scoreTimeframe } from "quantara-ingestion/src/signals/score.js";
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
  /** Exchange to query candles from. Defaults to "binance". */
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
  /** null if signal hasn't expired by `to` */
  resolvedAt: string | null;
  outcome: "correct" | "incorrect" | "neutral" | null;
  priceMovePct: number | null;
  priceAtSignal: number;
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

// ---------------------------------------------------------------------------
// BacktestEngine
// ---------------------------------------------------------------------------

export class BacktestEngine {
  constructor(private readonly candleStore: HistoricalCandleStore) {}

  async run(input: BacktestInput): Promise<BacktestResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const exchange = input.exchange ?? "binance";
    const { pair, timeframe, from, to } = input;
    const tfMs = TF_MS[timeframe];

    // Extend fetch window back by warmup bars to ensure indicators are seeded.
    const fetchFrom = new Date(from.getTime() - WARMUP_BARS * tfMs);

    const allCandles = await this.candleStore.getCandles(pair, exchange, timeframe, fetchFrom, to);

    if (allCandles.length === 0) {
      return {
        signals: [],
        metrics: emptyMetrics(),
        meta: {
          startedAt,
          durationMs: Date.now() - t0,
          candleCount: 0,
          pair,
          timeframe,
          from: from.toISOString(),
          to: to.toISOString(),
        },
      };
    }

    // Sort candles chronologically (oldest first).
    allCandles.sort((a, b) => a.openTime - b.openTime);

    // Build index from closeTime → candle for O(1) resolution lookups.
    const candleByCloseTime = new Map<number, Candle>();
    for (const c of allCandles) {
      candleByCloseTime.set(c.closeTime, c);
    }

    // Identify candles in the [from, to] window (the "evaluation" window).
    const evalCandles = allCandles.filter(
      (c) => c.closeTime >= from.getTime() && c.closeTime <= to.getTime(),
    );

    const signals: BacktestSignal[] = [];
    // Cooldown tracking: ruleName → bars since last fire.
    const lastFireBars: Record<string, number> = {};

    for (let i = 0; i < evalCandles.length; i++) {
      const candle = evalCandles[i];

      // Find this candle's position in allCandles to slice the lookback window.
      const allIdx = allCandles.indexOf(candle);
      if (allIdx === -1) continue;

      // Build indicator state from all candles up to and including this close.
      const windowCandles = allCandles.slice(0, allIdx + 1);

      const state = buildIndicatorState(windowCandles, {
        pair,
        exchange,
        timeframe,
        fearGreed: null,
        dispersion: null,
      });

      // Increment all cooldown counters before scoring.
      for (const key of Object.keys(lastFireBars)) {
        lastFireBars[key] = (lastFireBars[key] ?? 0) + 1;
      }

      const vote = scoreTimeframe(state, RULES, lastFireBars);

      if (vote === null) {
        // No eligible rules yet (still warming up) — skip.
        continue;
      }

      // Update cooldown for rules that fired.
      for (const ruleName of vote.rulesFired) {
        lastFireBars[ruleName] = 0;
      }

      const priceAtSignal = candle.close;
      const atrPct = state.atr14 !== null ? state.atr14 / priceAtSignal : 0;
      const expiresAtMs = candle.closeTime + EXPIRY_BARS * tfMs;
      const expiresAt = new Date(expiresAtMs).toISOString();

      const signal: BacktestSignal = {
        emittedAt: new Date(candle.closeTime).toISOString(),
        closeTime: candle.closeTime,
        pair,
        timeframe,
        type: vote.type,
        confidence: vote.confidence,
        rulesFired: vote.rulesFired,
        resolvedAt: null,
        outcome: null,
        priceMovePct: null,
        priceAtSignal,
        priceAtResolution: null,
        expiresAt,
      };

      // Resolve outcome if expiresAt is before `to`.
      if (expiresAtMs <= to.getTime()) {
        // Find the candle at expiry (closest candle whose closeTime >= expiresAtMs).
        const resolutionCandle = findNearestCandle(allCandles, expiresAtMs);

        if (resolutionCandle !== null) {
          const priceAtResolution = resolutionCandle.close;

          // Build a synthetic BlendedSignalRecord for resolveOutcome.
          // sk mirrors the signals-v2 composite key format: tf#closeTime.
          const signalId = `backtest-${pair}-${timeframe}-${candle.closeTime}`;
          const signalRecord: BlendedSignalRecord = {
            signalId,
            sk: `${timeframe}#${candle.closeTime}`,
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
        candleCount: allCandles.length,
        pair,
        timeframe,
        from: from.toISOString(),
        to: to.toISOString(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Find the candle whose closeTime is nearest to and >= targetMs.
 * Returns null if no such candle exists in the list.
 */
function findNearestCandle(candles: Candle[], targetMs: number): Candle | null {
  // candles is sorted by openTime ascending; closeTime follows the same order.
  for (const c of candles) {
    if (c.closeTime >= targetMs) return c;
  }
  return null;
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
