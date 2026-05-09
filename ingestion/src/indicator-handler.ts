/**
 * Indicator Lambda handler — Phase P2 (v6 design, DDB Streams trigger).
 *
 * Triggered by DDB Streams on `quantara-{env}-candles` with FilterCriteria:
 *   { dynamodb.NewImage.source.S = "live", dynamodb.NewImage.timeframe.S in [15m,1h,4h,1d] }
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
import { putIndicatorState } from "./lib/indicator-state-store.js";
import { makeSignalId } from "./lib/signal-store.js";
import { buildIndicatorState } from "./indicators/index.js";
import { scoreTimeframe } from "./signals/score.js";
import { blendTimeframeVotes, isTrivialChange } from "./signals/blend.js";
import { evaluateGates, narrowPair } from "./signals/gates.js";
import { EXCHANGES } from "./exchanges/config.js";
import { ratifySignal } from "./llm/ratify.js";
import { buildSentimentBundle } from "./news/bundle.js";

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
 */
const REQUIRED_EXCHANGE_COUNT = parseInt(process.env.REQUIRED_EXCHANGE_COUNT ?? "2", 10);

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
  source: "live" | "backfill";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    if (record.eventName !== "INSERT" && record.eventName !== "MODIFY") continue;
    if (!record.dynamodb?.NewImage) continue;

    // Unmarshall from the DDB AttributeValue format used in stream records.
    const candle = unmarshall(
      record.dynamodb.NewImage as Record<string, AttributeValue>,
    ) as StreamCandle;

    // FilterCriteria should have already excluded non-signal timeframes and
    // non-live sources, but guard defensively.
    if (!SIGNAL_TIMEFRAMES.includes(candle.timeframe)) continue;
    if (candle.source !== "live") continue;

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

  // Step 4 — Compute indicators + blend → conditional Put.
  const blended = await computeBlendedSignal(pair, timeframe, closeTime);
  if (!blended) {
    console.log(
      `[IndicatorHandler] ${pair}/${timeframe}: no blended signal produced (all TF votes null or insufficient candles).`,
    );
    return;
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
          type: blended.type,
          confidence: blended.confidence,
          volatilityFlag: blended.volatilityFlag,
          gateReason: blended.gateReason,
          rulesFired: blended.rulesFired,
          perTimeframe: blended.perTimeframe,
          weightsUsed: blended.weightsUsed,
          asOf: blended.asOf,
          emittingTimeframe: blended.emittingTimeframe,
          risk: blended.risk ?? null,
          invalidatedAt: blended.invalidatedAt ?? null,
          invalidationReason: blended.invalidationReason ?? null,
          // 90-day TTL
          ttl: Math.floor(Date.now() / 1000) + 86_400 * 90,
        },
        // Atomic dedup guard — concurrent handlers for same (pair, tf, closeTime) all race
        // to write; first one wins, rest get ConditionalCheckFailedException (idempotent skip).
        ConditionExpression: "attribute_not_exists(pair)",
      }),
    );

    console.log(
      `[IndicatorHandler] ${pair}/${timeframe}: signal written (type=${blended.type} confidence=${blended.confidence.toFixed(3)}).`,
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Another concurrent handler won the race — this is expected and safe.
      console.log(
        `[IndicatorHandler] ${pair}/${timeframe}@${closeTime}: conditional Put lost the race — another handler already wrote the signal. Idempotent skip.`,
      );
      return;
    }
    throw err;
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

async function readLatestVote(pair: string, tf: SignalTimeframe): Promise<TimeframeVote | null> {
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: voteKey(pair, tf) },
    }),
  );
  return (result.Item?.["vote"] as TimeframeVote | null | undefined) ?? null;
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
 * Full indicator computation for a single (pair, timeframe, closeTime) tuple.
 * Pulls 250 bars per exchange, canonicalizes, builds IndicatorState, scores,
 * persists vote, then blends all 4 TF votes for the pair.
 *
 * Returns the final BlendedSignal (after ratification), or null if insufficient data.
 */
async function computeBlendedSignal(
  pair: string,
  tf: SignalTimeframe,
  closeTime: number,
): Promise<import("@quantara/shared").BlendedSignal | null> {
  const fearGreed = await getFearGreed();

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
  const votes = await Promise.all(
    SIGNAL_TIMEFRAMES.map(async (t) => {
      const v = await readLatestVote(pair, t);
      return [t, v] as const;
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

  // §7.5 Ratification gate.
  let final = blended;
  try {
    const sentiment = await buildSentimentBundle(pair);
    const ratifyResult = await ratifySignal({
      pair,
      candidate: blended,
      perTimeframe: perTimeframeVotes,
      sentiment,
      whaleSummary: null,
      pricePoints: [],
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
    console.warn(
      `[IndicatorHandler] ${pair}: ratification failed, using algo signal — ${(err as Error).message}`,
    );
    final = blended;
  }

  const previous = await getLatestSignalForPair(pair);
  const trivial = isTrivialChange(previous, final);
  if (!trivial) {
    console.log(
      `[IndicatorHandler] non-trivial signal change for ${pair}: type=${final.type} confidence=${final.confidence.toFixed(3)}`,
    );
  }

  return final;
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
