/**
 * Indicator Lambda handler — Phase 4b.
 *
 * Triggered by EventBridge every minute (cron(* * * * ? *)).
 *
 * On each invocation:
 *   1. Detect which timeframes just closed within the last 60-second window.
 *   2. For each closed TF × each pair:
 *      a. Pull recent candles per exchange (250 bars for warm-up).
 *      b. Canonicalize cross-exchange → consensus candle + dispersion.
 *      c. Build IndicatorState from the consensus candle series.
 *      d. Persist IndicatorState.
 *      e. Tick cooldowns, retrieve lastFireBars.
 *      f. Evaluate gates, score timeframe, persist vote.
 *   3. For each pair: blend all 4 TF votes → BlendedSignal, persist.
 *      Log non-trivial changes; always persist (isTrivialChange only affects UI).
 */

import type { Timeframe } from "@quantara/shared";
import { PAIRS } from "@quantara/shared";
import { RULES } from "@quantara/shared";
import type { TimeframeVote } from "@quantara/shared";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { getCandles } from "./lib/candle-store.js";
import { canonicalizeCandle } from "./lib/canonicalize.js";
import { getLastFireBars, tickCooldowns, recordRuleFires } from "./lib/cooldown-store.js";
import { putIndicatorState } from "./lib/indicator-state-store.js";
import { putSignal, getLatestSignal } from "./lib/signal-store.js";
import { buildIndicatorState } from "./indicators/index.js";
import { scoreTimeframe } from "./signals/score.js";
import { blendTimeframeVotes, isTrivialChange } from "./signals/blend.js";
import { evaluateGates, narrowPair } from "./signals/gates.js";
import { EXCHANGES } from "./exchanges/config.js";

// ---------------------------------------------------------------------------
// DDB client for vote persistence (ingestion-metadata table)
// ---------------------------------------------------------------------------

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

// ---------------------------------------------------------------------------
// Timeframe bar durations
// ---------------------------------------------------------------------------

type SignalTimeframe = "15m" | "1h" | "4h" | "1d";

const SIGNAL_TIMEFRAMES: SignalTimeframe[] = ["15m", "1h", "4h", "1d"];

const TIMEFRAME_BAR_MS: Record<SignalTimeframe, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Dispersion history helpers (persisted in ingestion-metadata)
// ---------------------------------------------------------------------------

const DISPERSION_HISTORY_SIZE = 5;

function dispersionHistoryKey(pair: string, tf: SignalTimeframe): string {
  return `dispersion-history#${pair}#${tf}`;
}

async function getDispersionHistory(
  pair: string,
  tf: SignalTimeframe,
): Promise<number[]> {
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: dispersionHistoryKey(pair, tf) },
    }),
  );
  return (result.Item?.["values"] as number[] | undefined) ?? [];
}

async function appendDispersionHistory(
  pair: string,
  tf: SignalTimeframe,
  dispersion: number,
): Promise<number[]> {
  const existing = await getDispersionHistory(pair, tf);
  // Prepend new value (most-recent-first) and cap at history size.
  const updated = [dispersion, ...existing].slice(0, DISPERSION_HISTORY_SIZE);
  await client.send(
    new PutCommand({
      TableName: METADATA_TABLE,
      Item: {
        metaKey: dispersionHistoryKey(pair, tf),
        values: updated,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Exchange staleness helpers
// ---------------------------------------------------------------------------

function stalenessKey(pair: string): string {
  return `exchange-staleness#${pair}`;
}

async function getExchangeStaleness(pair: string): Promise<Record<string, boolean>> {
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: stalenessKey(pair) },
    }),
  );
  if (!result.Item) {
    // Default: no exchange is stale.
    const map: Record<string, boolean> = {};
    for (const ex of EXCHANGES) map[ex] = false;
    return map;
  }
  return (result.Item["staleness"] as Record<string, boolean>) ?? {};
}

// ---------------------------------------------------------------------------
// Vote persistence helpers (stored in ingestion-metadata)
// ---------------------------------------------------------------------------

function voteKey(pair: string, tf: SignalTimeframe): string {
  return `vote#${pair}#${tf}`;
}

async function persistVote(
  pair: string,
  tf: SignalTimeframe,
  vote: TimeframeVote | null,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: METADATA_TABLE,
      Item: {
        metaKey: voteKey(pair, tf),
        vote: vote,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

async function readLatestVote(
  pair: string,
  tf: SignalTimeframe,
): Promise<TimeframeVote | null> {
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: voteKey(pair, tf) },
    }),
  );
  return (result.Item?.["vote"] as TimeframeVote | null | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Fear & Greed helper — reads the latest value stored by NewsPoller
// ---------------------------------------------------------------------------

async function getFearGreed(): Promise<number | null> {
  // The fear-greed record is stored by news/fear-greed.ts with a top-level
  // `value` numeric field (not inside `metadata`). getCursor returns the raw item,
  // but the IngestionCursor type only exposes `metadata`. Read raw via GetCommand.
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: "market:fear-greed" },
    }),
  );
  if (!result.Item) return null;
  const value = result.Item["value"];
  if (typeof value === "number") return value;
  return null;
}

// ---------------------------------------------------------------------------
// EventBridge event type
// ---------------------------------------------------------------------------

interface EventBridgeEvent {
  source?: string;
  "detail-type"?: string;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(_event: EventBridgeEvent): Promise<void> {
  const now = Date.now();

  // Step 1: Determine which TFs just closed (bar closed within last 60s).
  const closedTfs: SignalTimeframe[] = [];
  for (const tf of SIGNAL_TIMEFRAMES) {
    const barMs = TIMEFRAME_BAR_MS[tf];
    const lastClose = Math.floor(now / barMs) * barMs;
    if (now - lastClose < 60_000) closedTfs.push(tf);
  }

  if (closedTfs.length === 0) {
    console.log("[IndicatorHandler] No TF closed in this minute. Exiting.");
    return;
  }

  console.log(`[IndicatorHandler] Closed TFs: ${closedTfs.join(", ")}`);

  const fearGreed = await getFearGreed();

  // Step 2: For each closed TF × each pair.
  for (const tf of closedTfs) {
    for (const pair of PAIRS) {
      try {
        await processTimeframePair(pair, tf, fearGreed, now);
      } catch (err) {
        console.error(
          `[IndicatorHandler] Error processing ${pair}/${tf}: ${(err as Error).message}`,
        );
        // Continue with other pairs/TFs — don't let one failure abort the batch.
      }
    }
  }

  // Step 3: For each pair, blend all 4 TF votes and persist the BlendedSignal.
  const emittingTf = closedTfs[closedTfs.length - 1]! as Timeframe;
  for (const pair of PAIRS) {
    try {
      await blendAndPersist(pair, emittingTf);
    } catch (err) {
      console.error(
        `[IndicatorHandler] Error blending ${pair}: ${(err as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Per-TF/pair processing
// ---------------------------------------------------------------------------

async function processTimeframePair(
  pair: string,
  tf: SignalTimeframe,
  fearGreed: number | null,
  _now: number,
): Promise<void> {
  // 2a. Pull recent candles per exchange (250 for warm-up).
  const CANDLE_LIMIT = 250;
  const perExchangeLatest: Record<string, import("@quantara/shared").Candle | null> = {};
  const perExchangeHistory: Record<string, import("@quantara/shared").Candle[]> = {};

  await Promise.all(
    EXCHANGES.map(async (ex) => {
      const candles = await getCandles(pair, ex, tf, CANDLE_LIMIT);
      perExchangeHistory[ex] = candles;
      // "Latest candle" = most recent closed candle (index 0 = newest from QueryCommand with ScanIndexForward=false).
      perExchangeLatest[ex] = candles.length > 0 ? candles[0]! : null;
    }),
  );

  // 2b. Determine per-exchange staleness (from ingestion-metadata).
  const exchangeStaleness = await getExchangeStaleness(pair);

  // Ensure exactly 3 entries for gateStale (which requires exactly 3).
  const stalenessMap: Record<string, boolean> = {};
  for (const ex of EXCHANGES) {
    stalenessMap[ex] = exchangeStaleness[ex] ?? false;
  }

  // 2b (cont). Canonicalize → consensus candle.
  const canon = canonicalizeCandle(perExchangeLatest, stalenessMap);
  if (!canon) {
    console.log(
      `[IndicatorHandler] ≥2/3 stale for ${pair}/${tf} — skipping (no consensus).`,
    );
    return;
  }

  // Build consensus candle series: use the exchange with the most candles as base
  // series, replacing the most recent candle with the consensus candle.
  const longestExchange = EXCHANGES.reduce((best, ex) => {
    return (perExchangeHistory[ex]?.length ?? 0) >
      (perExchangeHistory[best]?.length ?? 0)
      ? ex
      : best;
  }, EXCHANGES[0]!);

  const baseCandles = perExchangeHistory[longestExchange] ?? [];
  if (baseCandles.length === 0) {
    console.log(`[IndicatorHandler] No candle history for ${pair}/${tf}. Skipping.`);
    return;
  }

  // Replace the most recent candle (index 0 = newest) with the consensus candle.
  // buildIndicatorState expects chronological order (oldest first), so we reverse.
  const candlesNewestFirst = [canon.consensus, ...baseCandles.slice(1)];
  const candlesOldestFirst = [...candlesNewestFirst].reverse();

  // 2c. Build IndicatorState.
  const state = buildIndicatorState(candlesOldestFirst, {
    pair,
    exchange: "consensus",
    timeframe: tf,
    fearGreed,
    dispersion: canon.dispersion,
  });

  // 2d. Persist IndicatorState.
  await putIndicatorState(state);

  // 2e. Tick cooldowns, retrieve lastFireBars.
  await tickCooldowns(pair, tf);
  const lastFireBars = await getLastFireBars(pair, tf);

  // Append dispersion history for the dispersion gate (most-recent-first).
  const dispersionHistory = await appendDispersionHistory(pair, tf, canon.dispersion);

  // 2f. Evaluate gates + score timeframe.
  const narrowedPair = narrowPair(pair);
  const gateResult = evaluateGates(state, narrowedPair, dispersionHistory, stalenessMap);
  const vote = scoreTimeframe(state, RULES, lastFireBars, { gateResult });

  // Persist this TF's vote for the blending step.
  await persistVote(pair, tf, vote);

  // Record which rules fired (for cooldown tracking).
  if (vote && vote.rulesFired.length > 0) {
    await recordRuleFires(pair, tf, vote.rulesFired);
  }

  console.log(
    `[IndicatorHandler] ${pair}/${tf}: vote=${vote?.type ?? "null"} confidence=${vote?.confidence?.toFixed(3) ?? "n/a"}`,
  );
}

// ---------------------------------------------------------------------------
// Blend + persist BlendedSignal
// ---------------------------------------------------------------------------

async function blendAndPersist(pair: string, emittingTf: Timeframe): Promise<void> {
  // Collect all 4 TF votes.
  const votes = await Promise.all(
    SIGNAL_TIMEFRAMES.map(async (tf) => {
      const vote = await readLatestVote(pair, tf);
      return [tf, vote] as const;
    }),
  );

  const perTimeframeVotes: Record<Timeframe, TimeframeVote | null> = {
    "1m": null,
    "5m": null,
    "15m": null,
    "1h": null,
    "4h": null,
    "1d": null,
  };
  for (const [tf, vote] of votes) {
    perTimeframeVotes[tf] = vote;
  }

  const blended = blendTimeframeVotes(pair, perTimeframeVotes, emittingTf);
  if (!blended) {
    console.log(`[IndicatorHandler] ${pair}: all TF votes null, no BlendedSignal.`);
    return;
  }

  const previous = await getLatestSignal(pair);
  const trivial = isTrivialChange(previous, blended);

  // Always persist — isTrivialChange only affects UI emit downstream.
  await putSignal(blended);

  if (!trivial) {
    console.log(
      `[IndicatorHandler] non-trivial signal change for ${pair}: type=${blended.type} confidence=${blended.confidence.toFixed(3)}`,
    );
  }
}
