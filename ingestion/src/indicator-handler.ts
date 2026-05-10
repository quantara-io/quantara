/**
 * Indicator Lambda handler — Phase P2 (v6 design, DDB Streams trigger).
 *
 * Triggered by DDB Streams on `quantara-{env}-candles` with FilterCriteria:
 *   { dynamodb.NewImage.source.S in ["live", "live-synthesized"],
 *     dynamodb.NewImage.timeframe.S in [15m,1h,4h,1d] }
 *
 * One invocation per candle record that passes the filter.
 *
 * Flow (per candle):
 *   Step 1 — ADD exchange to close-quorum (idempotent String Set ADD).
 *   Step 2 — Check quorum: exchanges.size >= REQUIRED_EXCHANGE_COUNT. If not, stop.
 *   Step 3 — Check signals-v2 for prior processing (PK=pair, SK=tf#closeTime). If exists, stop.
 *   Step 4 — Compute indicators + blend → conditional Put on signals-v2 (dedup guard).
 *
 * SK ordering is tf#closeTime (P2.2 correction — NOT closeTime#tf) so that
 * "latest BTC/USDT 15m signal" can be retrieved with begins_with(SK, "15m#") +
 * ScanIndexForward=false + Limit=1.
 */

import type { DynamoDBStreamEvent, DynamoDBStreamHandler } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Timeframe } from "@quantara/shared";
import { RULES } from "@quantara/shared";
import type { TimeframeVote } from "@quantara/shared";

import { getCandles } from "./lib/candle-store.js";
import { canonicalizeCandle } from "./lib/canonicalize.js";
import { getLastFireBars, tickCooldowns, recordRuleFires } from "./lib/cooldown-store.js";
import { putIndicatorState, getLatestIndicatorState } from "./lib/indicator-state-store.js";
import { makeSignalId, updateSignalRatification } from "./lib/signal-store.js";
import { buildIndicatorState } from "./indicators/index.js";
import { scoreTimeframe } from "./signals/score.js";
import { blendTimeframeVotes, isTrivialChange } from "./signals/blend.js";
import { evaluateGates, narrowPair } from "./signals/gates.js";
import { EXCHANGES } from "./exchanges/config.js";
import { ratifySignal } from "./llm/ratify.js";
import { buildSentimentBundle } from "./news/bundle.js";
import { emitPipelineEventSafe } from "./lib/pipeline-events-store.js";

// ---------------------------------------------------------------------------
// DDB client
// ---------------------------------------------------------------------------

const rawClient = new DynamoDBClient({});
const client = DynamoDBDocumentClient.from(rawClient);

const CLOSE_QUORUM_TABLE =
  process.env.TABLE_CLOSE_QUORUM ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}close-quorum`;

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

/**
 * Minimum number of exchanges that must have reported a close before the
 * IndicatorLambda proceeds. Configurable via env var for testability.
 *
 * Validated on parse: if the env var is malformed (NaN, ≤0), fall back to
 * the default (2). Without validation, NaN would silently disable the
 * quorum check (`exchangeCount < NaN` is always false → handler proceeds
 * without quorum, defeating the whole 2-of-3 dedup design).
 */
const REQUIRED_EXCHANGE_COUNT = (() => {
  const parsed = parseInt(process.env.REQUIRED_EXCHANGE_COUNT ?? "2", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[IndicatorHandler] REQUIRED_EXCHANGE_COUNT env var malformed (got "${process.env.REQUIRED_EXCHANGE_COUNT}"); falling back to 2`,
    );
    return 2;
  }
  return parsed;
})();

// ---------------------------------------------------------------------------
// Timeframe bar durations
// ---------------------------------------------------------------------------

type SignalTimeframe = "15m" | "1h" | "4h" | "1d";

const SIGNAL_TIMEFRAMES: SignalTimeframe[] = ["15m", "1h", "4h", "1d"];

// ---------------------------------------------------------------------------
// Candle shape from DDB stream record (after unmarshalling)
// ---------------------------------------------------------------------------

interface StreamCandle {
  pair: string;
  exchange: string;
  timeframe: SignalTimeframe;
  closeTime: number;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  symbol: string;
  source: "live" | "live-synthesized" | "backfill";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  // Reset per-invocation caches before processing the batch. Lambda warm-pool
  // reuse keeps module-scope state alive across invocations; reset to ensure
  // the first record in each batch refreshes daily-cadence values like Fear/Greed.
  resetFearGreedCache();

  for (const record of event.Records) {
    if (record.eventName !== "INSERT" && record.eventName !== "MODIFY") continue;
    if (!record.dynamodb?.NewImage) continue;

    // Unmarshall from the DDB AttributeValue format used in stream records.
    const candle = unmarshall(
      record.dynamodb.NewImage as Record<string, AttributeValue>,
    ) as StreamCandle;

    // FilterCriteria should have already excluded non-signal timeframes and
    // non-live sources, but guard defensively. Both `live` and
    // `live-synthesized` are accepted — `live-synthesized` is the Kraken
    // silent-window carry-forward from stream.ts (#224) and must vote in
    // close-quorum alongside real `live` candles.
    if (!SIGNAL_TIMEFRAMES.includes(candle.timeframe)) continue;
    if (candle.source !== "live" && candle.source !== "live-synthesized") continue;

    try {
      await processCandleClose(candle);
    } catch (err) {
      console.error(
        `[IndicatorHandler] Error processing ${candle.pair}/${candle.timeframe}@${candle.exchange}: ${(err as Error).message}`,
      );
      // Re-throw so Lambda retries this batch record.
      throw err;
    }
  }
};

// ---------------------------------------------------------------------------
// Core 4-step flow
// ---------------------------------------------------------------------------

async function processCandleClose(candle: StreamCandle): Promise<void> {
  const { pair, timeframe, closeTime, exchange } = candle;
  const quorumId = `${pair}#${timeframe}#${closeTime}`;

  // Step 1 — ADD exchange to close-quorum (idempotent DDB String Set ADD).
  // Also set TTL via if_not_exists so first writer sets it; subsequent writers
  // don't overwrite the TTL (preventing TTL extension on retry).
  const ttlSeconds = Math.floor(closeTime / 1000) + 86_400;

  await client.send(
    new UpdateCommand({
      TableName: CLOSE_QUORUM_TABLE,
      Key: { id: quorumId },
      UpdateExpression: "ADD exchanges :ex SET #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: {
        // DynamoDB Document Client accepts a plain Set for String Set ADD.
        ":ex": new Set([exchange]),
        ":ttl": ttlSeconds,
      },
    }),
  );

  // Step 2 — Check quorum.
  // ConsistentRead is required: an eventually-consistent read after an UpdateItem
  // can return the pre-update image and miss the just-added exchange. If no further
  // exchanges arrive, the slot would be silently abandoned.
  const quorumResult = await client.send(
    new GetCommand({
      TableName: CLOSE_QUORUM_TABLE,
      Key: { id: quorumId },
      ConsistentRead: true,
    }),
  );

  const quorumItem = quorumResult.Item;
  const exchangeSet = quorumItem?.exchanges as Set<string> | undefined;
  const exchangeCount = exchangeSet?.size ?? 0;

  if (exchangeCount < REQUIRED_EXCHANGE_COUNT) {
    console.log(
      `[IndicatorHandler] Quorum not reached for ${quorumId}: ${exchangeCount}/${REQUIRED_EXCHANGE_COUNT} exchanges. Waiting.`,
    );
    return;
  }

  // Step 3 — Check signals-v2 for prior processing (deterministic SK: tf#closeTime per P2.2).
  const sk = `${timeframe}#${closeTime}`;

  const existing = await client.send(
    new GetCommand({
      TableName: SIGNALS_V2_TABLE,
      Key: { pair, sk },
    }),
  );

  if (existing.Item) {
    console.log(
      `[IndicatorHandler] ${pair}/${timeframe}@${closeTime}: signals-v2 row already exists — idempotent skip.`,
    );
    return;
  }

  // Step 4 — Compute indicators + blend → two-stage write (Phase B1).
  const blended = await computeBlendedSignal(pair, timeframe, closeTime);
  if (!blended) {
    console.log(
      `[IndicatorHandler] ${pair}/${timeframe}: no blended signal produced (all TF votes null or insufficient candles).`,
    );
    return;
  }

  // Phase B1 two-stage ratification:
  //   Stage 1 — run ratifySignal immediately to determine ratificationStatus.
  //             Returns synchronously with ratificationStatus = "pending" |
  //             "not-required" | "ratified" (cache hit). When status is
  //             "pending", the result also exposes kickoffRatification(), which
  //             the caller invokes ONLY AFTER the stage-1 DDB Put commits.
  //   Stage 2 — the onStage2 callback fires when the LLM verdict is ready;
  //             it calls updateSignalRatification to UPDATE the DDB row.
  //
  // Race-free ordering: kickoffRatification is the synchronization barrier.
  // We never start the LLM stream before stage-1 Put is durable, so any
  // stage-2 UPDATE is guaranteed to find a row to update.

  let stage1Signal = blended;
  let kickoffRatification: (() => Promise<void>) | undefined;

  try {
    const sentiment = await buildSentimentBundle(pair);
    const ratifyResult = await ratifySignal(
      {
        pair,
        candidate: blended,
        perTimeframe: blended.perTimeframe,
        sentiment,
        whaleSummary: null,
        pricePoints: [],
        fearGreed: {
          value: (await getFearGreedCached()) ?? 50,
          trend24h: sentiment.fearGreed.trend24h ?? 0,
        },
      },
      // onStage2: called when the LLM stream completes (or falls back on error).
      // Performs the stage-2 DDB UPDATE so the row transitions from "pending" to final.
      // Retries up to 3 times on transient failures so a single DDB throttle
      // or 5xx doesn't permanently leave the row stuck on "pending".
      // ConditionalCheckFailedException is NOT retried — it means the row is
      // already in a final state (handled inside updateSignalRatification).
      async (stage2Payload) => {
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            const updated = await updateSignalRatification({
              pair,
              sk,
              ratificationStatus: stage2Payload.ratificationStatus,
              ratificationVerdict: stage2Payload.ratificationVerdict,
              algoVerdict: stage2Payload.algoVerdict,
            });
            if (updated) {
              console.log(
                `[IndicatorHandler] ${pair}/${timeframe}: stage-2 ratification UPDATE written (status=${stage2Payload.ratificationStatus}, attempt=${attempt}).`,
              );
            } else {
              // Conditional check failed — row missing (race-lost stage-1)
              // or already in a final state. Either is benign; log distinctly
              // so operators can tell this from a successful UPDATE.
              console.log(
                `[IndicatorHandler] ${pair}/${timeframe}: stage-2 UPDATE skipped (row missing or already final, status=${stage2Payload.ratificationStatus}, attempt=${attempt}).`,
              );
            }
            return;
          } catch (updateErr) {
            const isLastAttempt = attempt === MAX_ATTEMPTS;
            console.warn(
              `[IndicatorHandler] ${pair}/${timeframe}: stage-2 UPDATE attempt ${attempt}/${MAX_ATTEMPTS} failed${isLastAttempt ? " (giving up)" : ", retrying"}:`,
              updateErr,
            );
            if (isLastAttempt) {
              // Final attempt failed — log and continue. Stage-1 "pending"
              // row remains until the next signal supersedes it; not crashing
              // is better than failing the whole stream batch and re-processing
              // every record on retry.
              return;
            }
            // Linear backoff: 100ms, 200ms before next attempt.
            await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
          }
        }
      },
    );

    stage1Signal = ratifyResult.signal;
    kickoffRatification = ratifyResult.kickoffRatification;
  } catch (err) {
    console.warn(
      `[IndicatorHandler] ${pair}: ratification setup failed, using algo signal — ${(err as Error).message}`,
    );
    // stage1Signal stays as blended (no ratificationStatus field → pre-B1 compatible)
  }

  // Use the same signalId/emittedAt shape as signal-store.putSignal so admin.service
  // and outcomes tooling see consistent rows regardless of which writer produced them.
  const signalId = makeSignalId(closeTime);
  const emittedAt = new Date(closeTime).toISOString();

  try {
    await client.send(
      new PutCommand({
        TableName: SIGNALS_V2_TABLE,
        Item: {
          pair,
          sk,
          signalId,
          emittedAt,
          closeTime,
          timeframe,
          type: stage1Signal.type,
          confidence: stage1Signal.confidence,
          volatilityFlag: stage1Signal.volatilityFlag,
          gateReason: stage1Signal.gateReason,
          gateContext: stage1Signal.gateContext ?? null,
          rulesFired: stage1Signal.rulesFired,
          perTimeframe: stage1Signal.perTimeframe,
          weightsUsed: stage1Signal.weightsUsed,
          asOf: stage1Signal.asOf,
          emittingTimeframe: stage1Signal.emittingTimeframe,
          risk: stage1Signal.risk ?? null,
          invalidatedAt: stage1Signal.invalidatedAt ?? null,
          invalidationReason: stage1Signal.invalidationReason ?? null,
          // Phase B1: persist ratificationStatus so clients see "pending" immediately.
          // "not-required" and "ratified" (cache hit) are already final on stage-1.
          ratificationStatus: stage1Signal.ratificationStatus ?? null,
          ratificationVerdict: stage1Signal.ratificationVerdict ?? null,
          algoVerdict: stage1Signal.algoVerdict ?? null,
          // 90-day TTL
          ttl: Math.floor(Date.now() / 1000) + 86_400 * 90,
        },
        // Atomic dedup guard — concurrent handlers for same (pair, tf, closeTime) all race
        // to write; first one wins, rest get ConditionalCheckFailedException (idempotent skip).
        ConditionExpression: "attribute_not_exists(pair)",
      }),
    );

    console.log(
      `[IndicatorHandler] ${pair}/${timeframe}: stage-1 signal written (type=${stage1Signal.type} confidence=${stage1Signal.confidence.toFixed(3)} ratificationStatus=${stage1Signal.ratificationStatus ?? "n/a"}).`,
    );

    // Activity feed: emit signal-emitted event (fire-and-forget, non-fatal).
    emitPipelineEventSafe({
      type: "signal-emitted",
      pair,
      timeframe,
      signalType: stage1Signal.type,
      confidence: stage1Signal.confidence,
      closeTime: emittedAt,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    // With @aws-sdk/lib-dynamodb the Document Client may surface conditional
    // failures as a generic Error with `.name` set rather than as an instance
    // of ConditionalCheckFailedException. Match the more permissive pattern
    // used in signal-store.ts to avoid false re-throws → unnecessary stream retries.
    if (
      err instanceof ConditionalCheckFailedException ||
      (err instanceof Error &&
        (err.name === "ConditionalCheckFailedException" ||
          (err as { __type?: string }).__type ===
            "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException"))
    ) {
      // Another concurrent handler won the race — this is expected and safe.
      console.log(
        `[IndicatorHandler] ${pair}/${timeframe}@${closeTime}: conditional Put lost the race — another handler already wrote the signal. Idempotent skip.`,
      );
      return;
    }
    throw err;
  }

  // Now that stage-1 is durable, kick off the LLM stream. kickoffRatification
  // is undefined for gated/cache-hit paths — those have no stage-2.
  //
  // Wrap in try/catch defensively: runLlmStream is designed to swallow its own
  // errors (LLM API errors invoke the fallback path; persistence errors are
  // logged but don't propagate). But cache lookup or putRatificationRecord
  // could in principle throw an unexpected error (DDB throttle on cache, schema
  // mismatch). We do NOT want such errors to fail the Lambda invocation here:
  // stage-1 is already committed. Failing the invocation would trigger a stream
  // retry, the retried handler would see signals-v2 has the row already, return
  // early — and stage-2 never fires. Result: row stuck on "pending" forever.
  //
  // Better to log and move on. The signal still has a usable algo verdict;
  // the next signal supersedes it on the next close-boundary.
  if (kickoffRatification) {
    try {
      await kickoffRatification();
    } catch (kickoffErr) {
      console.error(
        `[IndicatorHandler] ${pair}/${timeframe}: kickoffRatification threw — stage-1 row may remain on "pending":`,
        kickoffErr,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Indicator computation (retained from Phase 4b; reused without rewrite)
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
    const map: Record<string, boolean> = {};
    for (const ex of EXCHANGES) map[ex] = false;
    return map;
  }
  return (result.Item["staleness"] as Record<string, boolean>) ?? {};
}

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

async function getFearGreed(): Promise<number | null> {
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

/**
 * Per-invocation Fear/Greed cache.
 *
 * The DDB Streams event source mapping batches up to 10 records per Lambda
 * invocation. Without this cache, computeBlendedSignal would issue a fresh
 * GetItem for fear-greed on every record — wasted reads since the value is
 * updated daily and won't change within a millisecond-scale batch window.
 *
 * Reset on every fresh invocation: Lambda execution context reuse can keep
 * this populated across invocations, but the value still updates daily and
 * the worst-case staleness is the cron interval. For testability and to
 * avoid surprises across long-lived warm Lambdas, the handler resets it at
 * the top of each invocation.
 */
let fearGreedCache: { value: number | null } | null = null;
function resetFearGreedCache(): void {
  fearGreedCache = null;
}
async function getFearGreedCached(): Promise<number | null> {
  if (fearGreedCache !== null) return fearGreedCache.value;
  const value = await getFearGreed();
  fearGreedCache = { value };
  return value;
}

/**
 * Full indicator computation for a single (pair, timeframe, closeTime) tuple.
 * Pulls 250 bars per exchange, canonicalizes, builds IndicatorState, scores,
 * persists vote, then blends all 4 TF votes for the pair.
 *
 * Returns the **pre-ratification** blended signal (or null if insufficient
 * data). Phase B1 (#132): ratification runs in `processCandleClose` AFTER
 * the stage-1 Put commits, so callers should treat this as the algo-only
 * candidate and not assume LLM has touched it.
 */
async function computeBlendedSignal(
  pair: string,
  tf: SignalTimeframe,
  closeTime: number,
): Promise<import("@quantara/shared").BlendedSignal | null> {
  // Memoized per invocation — see getFearGreedCached above. With batch_size=10
  // on the DDB Streams ESM, a non-cached read would multiply DDB GetItem calls
  // ~10× per invocation for a value that changes daily.
  const fearGreed = await getFearGreedCached();

  const CANDLE_LIMIT = 250;
  const perExchangeLatest: Record<string, import("@quantara/shared").Candle | null> = {};
  const perExchangeHistory: Record<string, import("@quantara/shared").Candle[]> = {};

  await Promise.all(
    EXCHANGES.map(async (ex) => {
      const candles = await getCandles(pair, ex, tf, CANDLE_LIMIT);
      perExchangeHistory[ex] = candles;
      const latest = candles.find((c) => Math.abs(c.closeTime - closeTime) <= 1) ?? null;
      if (!latest && candles.length > 0) {
        console.log(
          `[IndicatorHandler] ${pair}/${tf}@${ex}: no candle found for closeTime=${closeTime} (head=${candles[0]?.closeTime}) — treating as stale.`,
        );
      }
      perExchangeLatest[ex] = latest;
    }),
  );

  const exchangeStaleness = await getExchangeStaleness(pair);
  const stalenessMap: Record<string, boolean> = {};
  for (const ex of EXCHANGES) {
    stalenessMap[ex] = (exchangeStaleness[ex] ?? false) || perExchangeLatest[ex] === null;
  }

  const canon = canonicalizeCandle(perExchangeLatest, stalenessMap);
  if (!canon) {
    console.log(
      `[IndicatorHandler] ≥2/3 stale for ${pair}/${tf} — writing sentinel vote and skipping.`,
    );
    await persistVote(pair, tf, null);
    return null;
  }

  const longestExchange = EXCHANGES.reduce((best, ex) => {
    return (perExchangeHistory[ex]?.length ?? 0) > (perExchangeHistory[best]?.length ?? 0)
      ? ex
      : best;
  }, EXCHANGES[0]!);

  const baseCandles = perExchangeHistory[longestExchange] ?? [];
  if (baseCandles.length === 0) {
    console.log(`[IndicatorHandler] No candle history for ${pair}/${tf}. Skipping.`);
    return null;
  }

  const candlesNewestFirst = [canon.consensus, ...baseCandles.slice(1)];
  const candlesOldestFirst = [...candlesNewestFirst].reverse();

  const state = buildIndicatorState(candlesOldestFirst, {
    pair,
    exchange: "consensus",
    timeframe: tf,
    fearGreed,
    dispersion: canon.dispersion,
  });

  await putIndicatorState(state);

  // Activity feed: emit indicator-state-updated event (fire-and-forget, non-fatal).
  emitPipelineEventSafe({
    type: "indicator-state-updated",
    pair,
    timeframe: tf,
    barsSinceStart: state.barsSinceStart,
    rsi14: state.rsi14 ?? undefined,
    ts: new Date().toISOString(),
  });

  await tickCooldowns(pair, tf);
  const lastFireBars = await getLastFireBars(pair, tf);
  const dispersionHistory = await appendDispersionHistory(pair, tf, canon.dispersion);

  const narrowedPair = narrowPair(pair);
  const gateResult = evaluateGates(state, narrowedPair, dispersionHistory, stalenessMap);
  const vote = scoreTimeframe(state, RULES, lastFireBars, { gateResult });

  await persistVote(pair, tf, vote);

  if (vote && vote.rulesFired.length > 0) {
    await recordRuleFires(pair, tf, vote.rulesFired);
  }

  console.log(
    `[IndicatorHandler] ${pair}/${tf}: vote=${vote?.type ?? "null"} confidence=${vote?.confidence?.toFixed(3) ?? "n/a"}`,
  );

  // Blend all 4 TF votes for this pair.
  //
  // Fix (#278): for non-emitting timeframes, re-score from the stored
  // IndicatorState rather than reading the previously-persisted TimeframeVote.
  // The stored TimeframeVote has pre-baked bullishScore/bearishScore derived
  // from whatever rule strengths were in effect when that TF last closed.
  // After a calibration change (e.g. Phase 1 #254), those baked-in scores are
  // stale — the emitting TF uses current RULES while other TFs use old RULES,
  // producing contradictory perTimeframe snapshots in the written signal.
  //
  // IndicatorState is a pure sensor snapshot (candle → indicator numerics)
  // that is independent of rule calibration. Re-running scoreTimeframe on a
  // stored IndicatorState with the current RULES produces scores that reflect
  // the latest calibration on every emission, not just when that TF's own bar
  // closes. If no IndicatorState is available for a TF (first boot, cold start)
  // we fall back to the stored vote (null if never scored) — same as before.
  const votes = await Promise.all(
    SIGNAL_TIMEFRAMES.map(async (t) => {
      // Emitting TF: vote was freshly computed and persisted above — use it directly.
      if (t === tf) {
        return [t, vote] as const;
      }

      // Non-emitting TF: re-score from stored IndicatorState so scores always
      // reflect current RULES regardless of when that TF's bar last closed.
      const storedState = await getLatestIndicatorState(pair, "consensus", t);
      if (storedState !== null) {
        const tfLastFireBars = await getLastFireBars(pair, t);
        const recomputedVote = scoreTimeframe(storedState, RULES, tfLastFireBars);
        return [t, recomputedVote] as const;
      }

      // Fallback: no IndicatorState yet for this TF (cold start). Treat as null.
      return [t, null] as const;
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
  for (const [t, v] of votes) {
    perTimeframeVotes[t] = v;
  }

  const blended = blendTimeframeVotes(pair, perTimeframeVotes, tf as Timeframe);
  if (!blended) {
    console.log(`[IndicatorHandler] ${pair}: all TF votes null, no BlendedSignal.`);
    return null;
  }

  const previous = await getLatestSignalForPair(pair);
  const trivial = isTrivialChange(previous, blended);
  if (!trivial) {
    console.log(
      `[IndicatorHandler] non-trivial signal change for ${pair}: type=${blended.type} confidence=${blended.confidence.toFixed(3)}`,
    );
  }

  return blended;
}

/**
 * Retrieve the most recently written signal for a pair from signals-v2.
 *
 * v6 SK = `tf#closeTime`: a single reverse Query with Limit=1 returns
 * the alphabetically-last TF (e.g. "4h" beats "15m" / "1h" lexically),
 * not the chronologically newest signal. Query each blended TF
 * separately and pick the one with the highest closeTime.
 *
 * Tie-break (multiple TFs share the same closeTime at 4h/1d boundaries):
 * prefer the higher TF (1d > 4h > 1h > 15m) to match §5.2 weighting.
 */
async function getLatestSignalForPair(
  pair: string,
): Promise<import("@quantara/shared").BlendedSignal | null> {
  const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const blendTfs = ["15m", "1h", "4h", "1d"] as const;
  const tfAuthority: Record<(typeof blendTfs)[number], number> = {
    "15m": 0,
    "1h": 1,
    "4h": 2,
    "1d": 3,
  };

  const perTf = await Promise.all(
    blendTfs.map(async (tf) => {
      const result = await client.send(
        new QueryCommand({
          TableName: SIGNALS_V2_TABLE,
          KeyConditionExpression: "#pair = :pair AND begins_with(sk, :tfPrefix)",
          ExpressionAttributeNames: { "#pair": "pair" },
          ExpressionAttributeValues: { ":pair": pair, ":tfPrefix": `${tf}#` },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
      const item = result?.Items?.[0];
      return item ? { tf, item } : undefined;
    }),
  );

  let best: { tf: (typeof blendTfs)[number]; item: Record<string, unknown> } | undefined;
  for (const candidate of perTf) {
    if (!candidate) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const candidateAsOf = Number(candidate.item["asOf"] ?? 0);
    const bestAsOf = Number(best.item["asOf"] ?? 0);
    if (candidateAsOf > bestAsOf) {
      best = candidate;
    } else if (candidateAsOf === bestAsOf && tfAuthority[candidate.tf] > tfAuthority[best.tf]) {
      best = candidate;
    }
  }
  return best ? (best.item as unknown as import("@quantara/shared").BlendedSignal) : null;
}
