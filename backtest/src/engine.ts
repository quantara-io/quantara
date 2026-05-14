/**
 * BacktestEngine — Phase 2.
 *
 * Phase 2 additions on top of Phase 1:
 *   - Multi-TF blend: runs all 4 signal timeframes (15m, 1h, 4h, 1d) in
 *     parallel for the same pair, blends via production `blendTimeframeVotes`,
 *     honoring the strategy's `timeframeWeights` override.
 *   - Strategy parameter: accepts a Strategy (from types.ts) that can override
 *     TF weights and rule enablement. When strategy is omitted the engine
 *     falls back to Phase 1 single-TF behavior for backward compatibility.
 *
 * Phase 1 constraints remain:
 *   - priceAtSignal / priceAtResolution use canonical median-of-exchanges
 *   - IndicatorState uses the consensus-substitution pattern
 *   - evaluateGates is called
 *   - 18 Phase 1 tests continue to pass (single-TF run() is unchanged)
 */

import { RULES, TIMEFRAMES } from "@quantara/shared";
import type { Candle, Timeframe } from "@quantara/shared";
import type { TimeframeVote } from "@quantara/shared";
import { buildIndicatorState } from "quantara-ingestion/src/indicators/index.js";
import { canonicalizeCandle } from "quantara-ingestion/src/lib/canonicalize.js";
import { scoreTimeframe } from "quantara-ingestion/src/signals/score.js";
import { evaluateGates, narrowPair } from "quantara-ingestion/src/signals/gates.js";
import { resolveOutcome } from "quantara-ingestion/src/outcomes/resolver.js";
import type { BlendedSignalRecord } from "quantara-ingestion/src/outcomes/resolver.js";
import {
  blendTimeframeVotes,
  DEFAULT_TIMEFRAME_WEIGHTS,
} from "quantara-ingestion/src/signals/blend.js";

import type { HistoricalCandleStore } from "./store/candle-store.js";
import type { Strategy } from "./strategy/types.js";
import {
  createRatifier,
  type RatificationMode,
  type Ratifier,
  type RatificationStatus,
  type RatificationsLookup,
  type BedrockInvoker,
  type VerdictKind,
} from "./ratification/ratifier.js";
import type { RatificationModel } from "./cost/estimator.js";

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
  /** The emitting timeframe. Phase 1: single-TF only. Phase 2: set to "15m" for multi-TF blend. */
  timeframe: Timeframe;
  from: Date;
  to: Date;
  /** Phase 2: optional strategy to apply (overrides TF weights and rule enablement). */
  strategy?: Strategy;
  /**
   * Phase 2 (PR #373 follow-up): ratification mode.
   *
   *   "skip"           — no LLM, every signal carries `ratificationStatus: "not-required"`
   *   "cache-only"     — read existing rows from the production ratifications table
   *   "replay-bedrock" — invoke Bedrock per gated signal; accumulate USD cost,
   *                      abort mid-run when `maxCostUsd` is exceeded.
   *
   * Default `undefined` is treated as `"skip"` so Phase 1 callers see no
   * behaviour change.
   */
  ratification?: RatificationMode;
  /** Phase 2: LLM model — only consulted when ratification === "replay-bedrock". */
  model?: RatificationModel;
  /**
   * Phase 2: hard cost ceiling in USD. When `actualCostUsd > maxCostUsd`,
   * the engine writes the partial result with `meta.aborted: true` and
   * `meta.abortReason: "cost-ceiling"` and returns early.
   */
  maxCostUsd?: number;
  /**
   * Test/CLI hook — receives the running actual cost after every Bedrock
   * invocation. Returning `false` instructs the engine to abort the same
   * way `maxCostUsd` does. Independent of `maxCostUsd` so callers can
   * observe progress without setting a ceiling.
   */
  onCostUpdate?: (runningCostUsd: number) => boolean | void;
  /** Cache lookup (cache-only mode) — required when mode is "cache-only". */
  ratificationsLookup?: RatificationsLookup;
  /** Bedrock invoker (replay-bedrock mode) — required when mode is "replay-bedrock". */
  bedrockInvoker?: BedrockInvoker;
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
    /** Phase 2: strategy name used for this run, or undefined for single-TF mode. */
    strategyName?: string;
    /** Phase 2: whether multi-TF blend was active. */
    multiTfBlend?: boolean;
    /** Phase 2: whether the run was aborted due to cost ceiling. */
    aborted?: boolean;
    /** Phase 2: reason for abort if aborted is true. */
    abortReason?: string;
    /** Phase 2: cumulative actual Bedrock cost in USD (0 in skip/cache-only modes). */
    actualCostUsd?: number;
    /** Phase 2: cumulative input/output tokens spent on Bedrock ratification. */
    actualTokens?: { input: number; output: number };
    /** Phase 2: ratification mode actually used (echoes input.ratification). */
    ratificationMode?: RatificationMode;
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
  /**
   * Phase 2: ratification status for this signal.
   * "not-required" in algo-only mode (ratification=skip, which is the default).
   */
  ratificationStatus: RatificationStatus;
  /** Phase 2: LLM-ratified type (replay-bedrock / cache-only success). */
  ratifiedType?: string;
  /** Phase 2: LLM-ratified confidence (replay-bedrock / cache-only success). */
  ratifiedConfidence?: number;
  /** Phase 2: LLM verdict kind ("ratify" / "downgrade" / "reject" / "fallback"). */
  verdictKind?: VerdictKind;
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

/** Default expiry bars when a strategy does not specify an n-bars exit policy. */
const DEFAULT_EXPIRY_BARS = 4;

/**
 * Resolve the number of bars to use for signal expiry from the strategy's
 * exitPolicy. Falls back to DEFAULT_EXPIRY_BARS (4) when the strategy is
 * absent or uses a non-n-bars exit kind.
 */
function resolveExpiryBars(strategy: Strategy | undefined): number {
  if (strategy?.exitPolicy?.kind === "n-bars") {
    return strategy.exitPolicy.nBars;
  }
  return DEFAULT_EXPIRY_BARS;
}

/**
 * Warmup bars: max lookback for EMA200 + extra padding.
 * 200 bars for EMA200, +5 for good measure.
 */
const WARMUP_BARS = 205;

/** Mirrors DISPERSION_HISTORY_SIZE in `indicator-handler.ts:500`. */
const DISPERSION_HISTORY_SIZE = 5;

/** Tolerance (ms) for matching the same closeTime across exchanges. */
const CLOSE_TIME_MATCH_TOLERANCE_MS = 1;

/** The four signal timeframes run in production. Matches indicator-handler.ts:94. */
const SIGNAL_TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h", "1d"];

// ---------------------------------------------------------------------------
// Per-TF state (multi-TF blend support)
// ---------------------------------------------------------------------------

interface TfState {
  baseSeries: Candle[];
  baseIndexByCloseTime: Map<number, number>;
  perExchangeByCloseTime: Record<string, Map<number, Candle>>;
  lastFireBars: Record<string, number>;
  dispersionHistory: number[];
}

// ---------------------------------------------------------------------------
// BacktestEngine
// ---------------------------------------------------------------------------

/**
 * Mutable counter for tracking actual Bedrock cost mid-run + driving the
 * mid-run abort path. Created once per `run()` call and threaded through
 * the per-bar loop so a cost-ceiling exceed terminates the loop cleanly
 * (instead of yielding a half-built signal).
 */
interface RatificationRuntime {
  ratifier: Ratifier;
  mode: RatificationMode;
  maxCostUsd: number | undefined;
  onCostUpdate: ((c: number) => boolean | void) | undefined;
  actualCostUsd: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  aborted: boolean;
  abortReason: string | undefined;
}

function buildRatificationRuntime(input: BacktestInput): RatificationRuntime {
  const mode: RatificationMode = input.ratification ?? "skip";
  const ratifier = createRatifier({
    mode,
    model: input.model ?? "haiku",
    ratificationThreshold: input.strategy?.ratificationThreshold,
    cacheLookup: input.ratificationsLookup,
    bedrockInvoker: input.bedrockInvoker,
  });
  return {
    ratifier,
    mode,
    maxCostUsd: input.maxCostUsd,
    onCostUpdate: input.onCostUpdate,
    actualCostUsd: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    aborted: false,
    abortReason: undefined,
  };
}

/**
 * Run the ratifier against a candidate, fold the result back onto the
 * signal, and update the runtime cost. Returns true if the run should
 * continue, false if a cost-ceiling abort just fired.
 */
async function applyRatification(
  rt: RatificationRuntime,
  signal: BacktestSignal,
): Promise<boolean> {
  const verdict = await rt.ratifier.ratify({
    pair: signal.pair,
    timeframe: signal.timeframe,
    closeTime: signal.closeTime,
    type: signal.type,
    confidence: signal.confidence,
    rulesFired: signal.rulesFired,
  });
  signal.ratificationStatus = verdict.status;
  if (verdict.ratifiedType !== undefined) signal.ratifiedType = verdict.ratifiedType;
  if (verdict.ratifiedConfidence !== undefined)
    signal.ratifiedConfidence = verdict.ratifiedConfidence;
  if (verdict.verdictKind !== undefined) signal.verdictKind = verdict.verdictKind;

  if (verdict.costUsd > 0 || verdict.inputTokens > 0 || verdict.outputTokens > 0) {
    rt.actualCostUsd += verdict.costUsd;
    rt.actualInputTokens += verdict.inputTokens;
    rt.actualOutputTokens += verdict.outputTokens;

    const userVeto = rt.onCostUpdate?.(rt.actualCostUsd);
    if (userVeto === false) {
      rt.aborted = true;
      rt.abortReason = "cost-ceiling";
      return false;
    }
    if (rt.maxCostUsd !== undefined && rt.actualCostUsd > rt.maxCostUsd) {
      rt.aborted = true;
      rt.abortReason = "cost-ceiling";
      return false;
    }
  }
  return true;
}

export class BacktestEngine {
  constructor(private readonly candleStore: HistoricalCandleStore) {}

  /**
   * Run a backtest for the given input.
   *
   * Phase 2: when input.strategy is provided, runs in multi-TF blend mode
   * (all 4 signal TFs in parallel, blended via blendTimeframeVotes). When
   * strategy is absent, falls back to Phase 1 single-TF behavior.
   */
  async run(input: BacktestInput): Promise<BacktestResult> {
    if (input.strategy !== undefined) {
      return this.runMultiTf(input);
    }
    return this.runSingleTf(input);
  }

  // ---------------------------------------------------------------------------
  // Phase 2: multi-TF blend run
  // ---------------------------------------------------------------------------

  private async runMultiTf(input: BacktestInput): Promise<BacktestResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const { pair, from, to, strategy } = input;
    const rt = buildRatificationRuntime(input);

    // Build effective TF weight map: start from DEFAULT_TIMEFRAME_WEIGHTS,
    // apply strategy overrides, then renormalize the signal TFs so their sum = 1.
    const effectiveWeights = buildEffectiveWeights(strategy?.timeframeWeights);

    // Enabled rules filter.
    const enabledRuleNames = strategy?.enabledRules ? new Set(strategy.enabledRules) : null;
    const activeRules = enabledRuleNames
      ? RULES.filter((r) => enabledRuleNames.has(r.name))
      : RULES;

    // Fetch candles for all 4 signal TFs in parallel.
    const tfDataMap: Record<string, Record<string, Candle[]>> = {};
    let totalCandles = 0;
    const allCloseTimes = new Set<number>();

    await Promise.all(
      SIGNAL_TIMEFRAMES.map(async (tf) => {
        const tfMs = TF_MS[tf];
        const fetchFrom = new Date(from.getTime() - WARMUP_BARS * tfMs);
        const perExchangeRaw = await this.candleStore.getCandlesForAllExchanges(
          pair,
          tf,
          fetchFrom,
          to,
        );
        tfDataMap[tf] = perExchangeRaw;
        for (const ex of Object.keys(perExchangeRaw)) {
          const sorted = (perExchangeRaw[ex] ?? []).sort((a, b) => a.openTime - b.openTime);
          perExchangeRaw[ex] = sorted;
          totalCandles += sorted.length;
          for (const c of sorted) allCloseTimes.add(c.closeTime);
        }
      }),
    );

    // Build per-TF state objects (indexed lookups, sorted series).
    const tfStates: Record<string, TfState> = {};
    for (const tf of SIGNAL_TIMEFRAMES) {
      const perExchangeRaw = tfDataMap[tf] ?? {};
      const exchanges = Object.keys(perExchangeRaw).sort();
      const perExchangeByCloseTime: Record<string, Map<number, Candle>> = {};

      // Sort each exchange's candles and build closeTime index.
      for (const ex of exchanges) {
        const sorted = perExchangeRaw[ex] ?? [];
        const byClose = new Map<number, Candle>();
        for (const c of sorted) byClose.set(c.closeTime, c);
        perExchangeByCloseTime[ex] = byClose;
      }

      // Base series = longest exchange history.
      const longestExchange = exchanges.reduce((best, ex) => {
        return (perExchangeRaw[ex]?.length ?? 0) > (perExchangeRaw[best]?.length ?? 0) ? ex : best;
      }, exchanges[0] ?? "");

      const baseSeries = longestExchange ? (perExchangeRaw[longestExchange] ?? []) : [];
      const baseIndexByCloseTime = new Map<number, number>();
      for (let i = 0; i < baseSeries.length; i++) {
        baseIndexByCloseTime.set(baseSeries[i]!.closeTime, i);
      }

      tfStates[tf] = {
        baseSeries,
        baseIndexByCloseTime,
        perExchangeByCloseTime,
        lastFireBars: {},
        dispersionHistory: [],
      };
    }

    // The emitting TF (15m by default) drives the evaluation timeline.
    // At each 15m close, we re-score all 4 TFs and blend.
    const emittingTf: Timeframe = "15m";
    const emittingState = tfStates[emittingTf];
    if (!emittingState) {
      return multiTfEmptyResult(startedAt, t0, pair, emittingTf, from, to, 0, strategy);
    }

    const { baseSeries } = emittingState;
    if (baseSeries.length === 0) {
      return multiTfEmptyResult(startedAt, t0, pair, emittingTf, from, to, 0, strategy);
    }

    const evalCandles = baseSeries.filter(
      (c) => c.closeTime >= from.getTime() && c.closeTime <= to.getTime(),
    );

    const sortedCloseTimes = [...allCloseTimes].sort((a, b) => a - b);

    // Per-TF vote cache: keeps the most recent vote for each TF.
    // At each 15m close, we update 15m's vote by scoring and re-blend all 4.
    // For non-15m TFs: re-score if their last bar close is within this 15m window.
    const latestVotes: Record<string, TimeframeVote | null> = {
      "1m": null,
      "5m": null,
      "15m": null,
      "1h": null,
      "4h": null,
      "1d": null,
    };

    const signals: BacktestSignal[] = [];
    let skippedNoConsensus = 0;

    for (const emittingCandle of evalCandles) {
      const closeTime = emittingCandle.closeTime;

      // Score each signal TF at this 15m boundary.
      // For higher TFs (1h/4h/1d): only update when a new bar has closed at or before this 15m close.
      for (const tf of SIGNAL_TIMEFRAMES) {
        const tfState = tfStates[tf];
        if (!tfState) continue;

        const exchanges = Object.keys(tfState.perExchangeByCloseTime).sort();
        if (exchanges.length === 0) continue;

        // For the emitting TF (15m), always score the current bar.
        // For higher TFs, find the most recent closed bar at or before closeTime.
        const targetClose =
          tf === emittingTf
            ? closeTime
            : findMostRecentCloseAtOrBefore(tfState.baseSeries, closeTime);

        if (targetClose === null) continue;

        // Skip if we've already scored this TF's bar in a previous iteration.
        // (We only re-score when the bar is new.)
        const currentBarKey = `${tf}:${targetClose}`;
        const lastScoredKey = (tfState as TfState & { _lastScoredKey?: string })._lastScoredKey;
        if (tf !== emittingTf && lastScoredKey === currentBarKey) {
          // Vote already up to date for this TF bar.
          continue;
        }

        const { perExchange, staleness } = collectPerExchange(
          exchanges,
          tfState.perExchangeByCloseTime,
          targetClose,
        );

        const canon = canonicalizeCandle(perExchange, staleness);
        if (canon === null) {
          if (tf === emittingTf) skippedNoConsensus += 1;
          continue;
        }

        const baseIdx = tfState.baseIndexByCloseTime.get(targetClose);
        if (baseIdx === undefined) continue;

        const baseUpToHere = tfState.baseSeries.slice(0, baseIdx + 1);
        const baseNewestFirst = [...baseUpToHere].reverse();
        const candlesNewestFirst: Candle[] = [canon.consensus, ...baseNewestFirst.slice(1)];
        const candlesOldestFirst = [...candlesNewestFirst].reverse();

        const state = buildIndicatorState(candlesOldestFirst, {
          pair,
          exchange: "consensus",
          timeframe: tf,
          fearGreed: null,
          dispersion: canon.dispersion,
        });

        tfState.dispersionHistory = [canon.dispersion, ...tfState.dispersionHistory].slice(
          0,
          DISPERSION_HISTORY_SIZE,
        );

        for (const key of Object.keys(tfState.lastFireBars)) {
          tfState.lastFireBars[key] = (tfState.lastFireBars[key] ?? 0) + 1;
        }

        let gateResult: ReturnType<typeof evaluateGates>;
        try {
          gateResult = evaluateGates(state, narrowPair(pair), tfState.dispersionHistory, staleness);
        } catch {
          gateResult = { fired: false, reason: null };
        }

        const vote = scoreTimeframe(state, activeRules, tfState.lastFireBars, { gateResult });

        for (const ruleName of vote?.rulesFired ?? []) {
          tfState.lastFireBars[ruleName] = 0;
        }

        latestVotes[tf] = vote;
        (tfState as TfState & { _lastScoredKey?: string })._lastScoredKey = currentBarKey;
      }

      // Blend all TF votes into one headline signal.
      const perTimeframeVotes: Record<Timeframe, TimeframeVote | null> = {
        "1m": null,
        "5m": null,
        "15m": latestVotes["15m"] ?? null,
        "1h": latestVotes["1h"] ?? null,
        "4h": latestVotes["4h"] ?? null,
        "1d": latestVotes["1d"] ?? null,
      };

      const blended = blendTimeframeVotes(pair, perTimeframeVotes, emittingTf, effectiveWeights);

      if (blended === null) continue;
      if (blended.type === "hold" && (blended.gateReason !== null || blended.volatilityFlag)) {
        // Gated holds are recorded as signals per production behavior.
      }

      // Canonical price at emission: use 15m TF consensus.
      const emittingTfState = tfStates[emittingTf];
      const emittingExchanges = emittingTfState
        ? Object.keys(emittingTfState.perExchangeByCloseTime).sort()
        : [];
      const { perExchange: emitPerEx, staleness: emitStaleness } = collectPerExchange(
        emittingExchanges,
        emittingTfState?.perExchangeByCloseTime ?? {},
        closeTime,
      );
      const emitCanon = canonicalizeCandle(emitPerEx, emitStaleness);
      if (emitCanon === null) {
        skippedNoConsensus += 1;
        continue;
      }

      const priceAtSignal = emitCanon.consensus.close;
      const emittingTfMs = TF_MS[emittingTf];
      const expiresAtMs = closeTime + resolveExpiryBars(strategy) * emittingTfMs;
      const expiresAt = new Date(expiresAtMs).toISOString();

      // Compute ATR from the emitting TF state.
      const atrPct = computeAtrPct(
        emittingTfState,
        closeTime,
        emittingExchanges,
        pair,
        emittingTf,
        priceAtSignal,
      );

      const signal: BacktestSignal = {
        emittedAt: new Date(closeTime).toISOString(),
        closeTime,
        pair,
        timeframe: emittingTf,
        type: blended.type as SignalType,
        confidence: blended.confidence,
        rulesFired: blended.rulesFired,
        gateReason: blended.gateReason,
        resolvedAt: null,
        outcome: null,
        priceMovePct: null,
        priceAtSignal,
        priceAtResolution: null,
        expiresAt,
        ratificationStatus: "not-required",
      };

      if (expiresAtMs <= to.getTime()) {
        const resolutionCloseTime = findNearestCloseTime(sortedCloseTimes, expiresAtMs);
        if (resolutionCloseTime !== null) {
          const { perExchange: perExResolution, staleness: stalenessResolution } =
            collectPerExchange(
              emittingExchanges,
              emittingTfState?.perExchangeByCloseTime ?? {},
              resolutionCloseTime,
            );
          const canonResolution = canonicalizeCandle(perExResolution, stalenessResolution);
          if (canonResolution !== null) {
            const priceAtResolution = canonResolution.consensus.close;
            const signalId = `backtest-${pair}-${emittingTf}-${closeTime}`;
            const signalRecord: BlendedSignalRecord = {
              signalId,
              sk: `${emittingTf}#${closeTime}`,
              pair,
              type: toResolverType(blended.type as SignalType),
              confidence: blended.confidence,
              createdAt: signal.emittedAt,
              expiresAt,
              priceAtSignal,
              atrPctAtSignal: atrPct,
              gateReason: blended.gateReason,
              rulesFired: blended.rulesFired,
              emittingTimeframe: emittingTf,
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
      }

      // Ratify (skip / cache-only / replay-bedrock) before pushing so the
      // signal carries the verdict if one exists, and so a cost-ceiling
      // exceed terminates the loop here rather than after another bar.
      const keepGoing = await applyRatification(rt, signal);
      signals.push(signal);
      if (!keepGoing) break;
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
        timeframe: emittingTf,
        from: from.toISOString(),
        to: to.toISOString(),
        skippedNoConsensus,
        strategyName: strategy?.name,
        multiTfBlend: true,
        aborted: rt.aborted || undefined,
        abortReason: rt.abortReason,
        actualCostUsd: rt.actualCostUsd,
        actualTokens: { input: rt.actualInputTokens, output: rt.actualOutputTokens },
        ratificationMode: rt.mode,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1: single-TF run (preserved for backward compatibility)
  // ---------------------------------------------------------------------------

  private async runSingleTf(input: BacktestInput): Promise<BacktestResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const rt = buildRatificationRuntime(input);

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

    // Pick the exchange with the longest history.
    const longestExchange = exchanges.reduce((best, ex) => {
      return (perExchangeSorted[ex]?.length ?? 0) > (perExchangeSorted[best]?.length ?? 0)
        ? ex
        : best;
    }, exchanges[0]!);
    const baseSeries = perExchangeSorted[longestExchange]!;

    if (baseSeries.length === 0) {
      return emptyResult(startedAt, t0, pair, timeframe, from, to, 0);
    }

    const evalCandles = baseSeries.filter(
      (c) => c.closeTime >= from.getTime() && c.closeTime <= to.getTime(),
    );

    const baseIndexByCloseTime = new Map<number, number>();
    for (let i = 0; i < baseSeries.length; i++) {
      baseIndexByCloseTime.set(baseSeries[i]!.closeTime, i);
    }

    const signals: BacktestSignal[] = [];
    const lastFireBars: Record<string, number> = {};
    let dispersionHistory: number[] = [];
    let skippedNoConsensus = 0;

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

      const { perExchange, staleness } = collectPerExchange(
        exchanges,
        perExchangeByCloseTime,
        closeTime,
      );

      const canon = canonicalizeCandle(perExchange, staleness);
      if (canon === null) {
        skippedNoConsensus += 1;
        continue;
      }

      const baseIdx = baseIndexByCloseTime.get(closeTime);
      if (baseIdx === undefined) {
        continue;
      }
      const baseUpToHere = baseSeries.slice(0, baseIdx + 1);
      const baseNewestFirst = [...baseUpToHere].reverse();
      const candlesNewestFirst: Candle[] = [canon.consensus, ...baseNewestFirst.slice(1)];
      const candlesOldestFirst = [...candlesNewestFirst].reverse();

      const state = buildIndicatorState(candlesOldestFirst, {
        pair,
        exchange: "consensus",
        timeframe,
        fearGreed: null,
        dispersion: canon.dispersion,
      });

      dispersionHistory = [canon.dispersion, ...dispersionHistory].slice(
        0,
        DISPERSION_HISTORY_SIZE,
      );

      for (const key of Object.keys(lastFireBars)) {
        lastFireBars[key] = (lastFireBars[key] ?? 0) + 1;
      }

      let gateResult: ReturnType<typeof evaluateGates>;
      try {
        gateResult = evaluateGates(state, narrowPair(pair), dispersionHistory, staleness);
      } catch {
        gateResult = { fired: false, reason: null };
      }

      const vote = scoreTimeframe(state, RULES, lastFireBars, { gateResult });

      if (vote === null) {
        continue;
      }

      for (const ruleName of vote.rulesFired) {
        lastFireBars[ruleName] = 0;
      }

      const priceAtSignal = canon.consensus.close;
      const atrPct = state.atr14 !== null && priceAtSignal > 0 ? state.atr14 / priceAtSignal : 0;
      const expiresAtMs = closeTime + resolveExpiryBars(input.strategy) * tfMs;
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
        ratificationStatus: "not-required",
      };

      if (expiresAtMs <= to.getTime()) {
        const resolutionCloseTime = findNearestCloseTime(sortedCloseTimes, expiresAtMs);

        if (resolutionCloseTime !== null) {
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
        }
      }

      const keepGoing = await applyRatification(rt, signal);
      signals.push(signal);
      if (!keepGoing) break;
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
        aborted: rt.aborted || undefined,
        abortReason: rt.abortReason,
        actualCostUsd: rt.actualCostUsd,
        actualTokens: { input: rt.actualInputTokens, output: rt.actualOutputTokens },
        ratificationMode: rt.mode,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build effective TF weights by starting from DEFAULT_TIMEFRAME_WEIGHTS
 * and applying the strategy's partial override map.
 * After override, the signal TF weights are renormalized to sum to 1.
 */
function buildEffectiveWeights(
  override?: Partial<Record<Timeframe, number>>,
): Record<Timeframe, number> {
  const weights: Record<Timeframe, number> = { ...DEFAULT_TIMEFRAME_WEIGHTS };
  if (override) {
    for (const tf of TIMEFRAMES) {
      if (override[tf] !== undefined) {
        weights[tf] = override[tf]!;
      }
    }
  }
  return weights;
}

/**
 * Compute ATR% from stored indicator state at the given closeTime.
 * Returns 0 when ATR is unavailable (warm-up) or when priceAtSignal is 0.
 */
function computeAtrPct(
  tfState: TfState | undefined,
  closeTime: number,
  exchanges: string[],
  pair: string,
  tf: Timeframe,
  priceAtSignal: number,
): number {
  if (!tfState || priceAtSignal <= 0) return 0;
  const baseIdx = tfState.baseIndexByCloseTime.get(closeTime);
  if (baseIdx === undefined) return 0;

  const { perExchange, staleness } = collectPerExchange(
    exchanges,
    tfState.perExchangeByCloseTime,
    closeTime,
  );
  const canon = canonicalizeCandle(perExchange, staleness);
  if (canon === null) return 0;

  const baseUpToHere = tfState.baseSeries.slice(0, baseIdx + 1);
  const baseNewestFirst = [...baseUpToHere].reverse();
  const candlesNewestFirst: Candle[] = [canon.consensus, ...baseNewestFirst.slice(1)];
  const candlesOldestFirst = [...candlesNewestFirst].reverse();

  const state = buildIndicatorState(candlesOldestFirst, {
    pair,
    exchange: "consensus",
    timeframe: tf,
    fearGreed: null,
    dispersion: canon.dispersion,
  });

  return state.atr14 !== null ? state.atr14 / priceAtSignal : 0;
}

/**
 * Find the most recent closeTime in baseSeries that is <= targetMs.
 * Returns null if the series is empty or all closeTimes are > targetMs.
 */
function findMostRecentCloseAtOrBefore(baseSeries: Candle[], targetMs: number): number | null {
  let result: number | null = null;
  for (const c of baseSeries) {
    if (c.closeTime <= targetMs) {
      if (result === null || c.closeTime > result) {
        result = c.closeTime;
      }
    }
  }
  return result;
}

/**
 * Build the per-exchange Candle map + staleness map at a given closeTime.
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
 */
function toResolverType(type: SignalType): "buy" | "sell" | "hold" {
  if (type === "strong-buy" || type === "buy") return "buy";
  if (type === "strong-sell" || type === "sell") return "sell";
  return "hold";
}

/**
 * Binary search for the first closeTime >= targetMs.
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

/** Phase 2: empty result that carries multi-TF metadata. */
function multiTfEmptyResult(
  startedAt: string,
  t0: number,
  pair: string,
  timeframe: Timeframe,
  from: Date,
  to: Date,
  candleCount: number,
  strategy: Strategy | undefined,
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
      strategyName: strategy?.name,
      multiTfBlend: true,
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
    byType[s.type] = (byType[s.type] ?? 0) + 1;

    if (s.outcome === null) {
      byOutcome.unresolved += 1;
    } else {
      byOutcome[s.outcome] += 1;

      const win = s.outcome === "correct" ? 1 : 0;
      brierSum += (s.confidence - win) ** 2;
      brierCount += 1;

      if (s.type !== "hold") {
        if (s.outcome === "correct") winCount += 1;
        else if (s.outcome === "incorrect") lossCount += 1;
      }

      if ((s.type === "buy" || s.type === "strong-buy") && s.priceMovePct !== null) {
        returnSum += s.priceMovePct;
        returnCount += 1;
      } else if ((s.type === "sell" || s.type === "strong-sell") && s.priceMovePct !== null) {
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
