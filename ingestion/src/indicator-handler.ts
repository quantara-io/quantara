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
import {
  tryClaimProcessedClose,
  commitProcessedClose,
  clearProcessedClose,
} from "./lib/processed-close-store.js";
import { ratifySignal } from "./llm/ratify.js";
import { buildSentimentBundle } from "./news/bundle.js";

// ---------------------------------------------------------------------------
// DDB client for vote persistence (ingestion-metadata table)
// ---------------------------------------------------------------------------

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

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

async function getDispersionHistory(pair: string, tf: SignalTimeframe): Promise<number[]> {
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

async function readLatestVote(pair: string, tf: SignalTimeframe): Promise<TimeframeVote | null> {
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
  const closedTfs: Array<{ tf: SignalTimeframe; lastClose: number }> = [];
  for (const tf of SIGNAL_TIMEFRAMES) {
    const barMs = TIMEFRAME_BAR_MS[tf];
    const lastClose = Math.floor(now / barMs) * barMs;
    if (now - lastClose < 60_000) closedTfs.push({ tf, lastClose });
  }

  if (closedTfs.length === 0) {
    console.log("[IndicatorHandler] No TF closed in this minute. Exiting.");
    return;
  }

  console.log(`[IndicatorHandler] Closed TFs: ${closedTfs.map((c) => c.tf).join(", ")}`);

  const fearGreed = await getFearGreed();

  // Step 2: For each closed TF × each pair.
  for (const { tf, lastClose } of closedTfs) {
    for (const pair of PAIRS) {
      try {
        await processTimeframePair(pair, tf, fearGreed, lastClose);
      } catch (err) {
        console.error(
          `[IndicatorHandler] Error processing ${pair}/${tf}: ${(err as Error).message}`,
        );
        // Continue with other pairs/TFs — don't let one failure abort the batch.
      }
    }
  }

  // Step 3: For each pair, blend all 4 TF votes and persist the BlendedSignal.
  const emittingTf = closedTfs[closedTfs.length - 1]!.tf as Timeframe;
  for (const pair of PAIRS) {
    try {
      await blendAndPersist(pair, emittingTf, fearGreed);
    } catch (err) {
      console.error(`[IndicatorHandler] Error blending ${pair}: ${(err as Error).message}`);
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
  lastClose: number,
): Promise<void> {
  // Idempotency: claim this (pair, tf, lastClose) — if another invocation already
  // processed it (EventBridge at-least-once), skip all work.
  // NOTE: The marker is written here as an "in-progress" lock to prevent duplicate
  // work. It is committed (status → "committed") only after the vote is safely
  // persisted, and cleared on any error so retries can re-enter.
  const claimed = await tryClaimProcessedClose(pair, tf, lastClose);
  if (!claimed) {
    console.log(
      `[IndicatorHandler] ${pair}/${tf} close@${new Date(lastClose).toISOString()} already processed — skipping (duplicate invocation).`,
    );
    return;
  }

  // All subsequent work is wrapped in try/finally so the marker is either committed
  // (on success) or cleared (on error) before this function returns.
  try {
    await processTimeframePairWork(pair, tf, fearGreed, lastClose);

    // Marker commit: the vote/sentinel is now safely written — other invocations
    // that see status="committed" should skip.
    await commitProcessedClose(pair, tf, lastClose);
  } catch (err) {
    // Clear the in-progress marker so the next retry can reclaim the slot.
    await clearProcessedClose(pair, tf, lastClose);
    throw err;
  }
}

/**
 * Inner implementation of per-TF/pair processing — separated so the outer
 * function can cleanly handle the marker commit/clear lifecycle without
 * muddying the business logic.
 */
async function processTimeframePairWork(
  pair: string,
  tf: SignalTimeframe,
  fearGreed: number | null,
  lastClose: number,
): Promise<void> {
  // 2a. Pull recent candles per exchange (250 for warm-up).
  const CANDLE_LIMIT = 250;
  const perExchangeLatest: Record<string, import("@quantara/shared").Candle | null> = {};
  const perExchangeHistory: Record<string, import("@quantara/shared").Candle[]> = {};

  await Promise.all(
    EXCHANGES.map(async (ex) => {
      const candles = await getCandles(pair, ex, tf, CANDLE_LIMIT);
      perExchangeHistory[ex] = candles;
      // Scan for the candle whose closeTime matches lastClose exactly.
      // candles is newest-first (ScanIndexForward=false); backfill can write a
      // newer in-progress bar (isClosed: false) ahead of the just-closed bar, so
      // blindly taking candles[0] would pick the wrong slot.
      const latest = candles.find((c) => Math.abs(c.closeTime - lastClose) <= 1) ?? null;
      if (latest) {
        perExchangeLatest[ex] = latest;
      } else {
        perExchangeLatest[ex] = null;
        const head = candles.length > 0 ? candles[0] : null;
        if (head) {
          console.log(
            `[IndicatorHandler] ${pair}/${tf}@${ex}: no candle found for lastClose ${lastClose} (head.closeTime=${head.closeTime}) — treating exchange as stale.`,
          );
        }
      }
    }),
  );

  // 2b. Determine per-exchange staleness (from ingestion-metadata).
  const exchangeStaleness = await getExchangeStaleness(pair);

  // Ensure exactly 3 entries for gateStale (which requires exactly 3).
  // An exchange is stale if (a) the streamer reported it stale, OR (b) its candle
  // wasn't fresh for this bar close.
  const stalenessMap: Record<string, boolean> = {};
  for (const ex of EXCHANGES) {
    stalenessMap[ex] = (exchangeStaleness[ex] ?? false) || perExchangeLatest[ex] === null;
  }

  // 2b (cont). Canonicalize → consensus candle.
  const canon = canonicalizeCandle(perExchangeLatest, stalenessMap);
  if (!canon) {
    console.log(
      `[IndicatorHandler] ≥2/3 stale for ${pair}/${tf} — writing sentinel vote and skipping.`,
    );
    // P2 #2: Write a sentinel null vote so the blender doesn't pick up a stale
    // previous-bar vote for this TF.
    await persistVote(pair, tf, null);
    return;
  }

  // Build consensus candle series: use the exchange with the most candles as base
  // series, replacing the most recent candle with the consensus candle.
  const longestExchange = EXCHANGES.reduce((best, ex) => {
    return (perExchangeHistory[ex]?.length ?? 0) > (perExchangeHistory[best]?.length ?? 0)
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

async function blendAndPersist(
  pair: string,
  emittingTf: Timeframe,
  fearGreed: number | null,
): Promise<void> {
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

  // §7.5 Ratification gate — attempt LLM ratification when gating conditions are met.
  // On any failure, fall back to the algo signal unchanged (graceful degradation).
  let final = blended;
  try {
    const sentiment = await buildSentimentBundle(pair);
    const ratifyResult = await ratifySignal({
      pair,
      candidate: blended,
      perTimeframe: perTimeframeVotes,
      sentiment,
      whaleSummary: null, // Phase 9+
      pricePoints: [], // Phase 9+
      fearGreed: {
        value: fearGreed ?? 50,
        trend24h: sentiment.fearGreed.trend24h ?? 0,
      },
    });
    final = ratifyResult.signal;
    if (!ratifyResult.fellBackToAlgo) {
      console.log(
        `[IndicatorHandler] ${pair}: ratified → type=${final.type} confidence=${final.confidence.toFixed(3)}`,
      );
    }
  } catch (err) {
    // Graceful degradation: ratification failure must not block signal persistence.
    console.warn(
      `[IndicatorHandler] ${pair}: ratification failed, using algo signal — ${(err as Error).message}`,
    );
    final = blended;
  }

  const previous = await getLatestSignal(pair);
  const trivial = isTrivialChange(previous, final);

  // Always persist — isTrivialChange only affects UI emit downstream.
  await putSignal(final);

  if (!trivial) {
    console.log(
      `[IndicatorHandler] non-trivial signal change for ${pair}: type=${final.type} confidence=${final.confidence.toFixed(3)}`,
    );
  }
}
