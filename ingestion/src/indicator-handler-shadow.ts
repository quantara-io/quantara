/**
 * Indicator Handler Shadow — Issue #133 (1m/5m data-collection path).
 *
 * Triggered by DDB Streams on `quantara-{env}-candles` with FilterCriteria:
 *   { dynamodb.NewImage.source.S in ["live", "live-synthesized"],
 *     dynamodb.NewImage.timeframe.S in [1m,5m] }
 *
 * This handler is intentionally separate from `indicator-handler.ts` (the
 * production 15m/1h/4h/1d path) to ensure:
 *   - Shadow signals NEVER land in signals-v2 (the production table).
 *   - The production handler is never invoked on short-TF candles.
 *   - Cost: no LLM ratification call, no WebSocket fanout, no blend.
 *
 * Flow (per candle — same 4-step quorum pattern as the production handler):
 *   Step 1 — ADD exchange to close-quorum (idempotent String Set ADD).
 *   Step 2 — Check quorum: exchanges.size >= REQUIRED_EXCHANGE_COUNT. If not, stop.
 *   Step 3 — Check signals-collection for prior processing (PK=pair, SK=tf#closeTime). If exists, stop.
 *   Step 4 — Compute single-TF score (no blend) → write to signals-collection.
 *             NO ratification, NO fanout, NO pipeline events.
 *
 * Rule subset: all rules are applied, same as the production handler. The
 * data collection goal is to see which rules fire (and how noisily) at 1m/5m.
 * Filtering to a subset would bias the dataset and defeat the purpose. The PR
 * description documents this decision.
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

import { getCandles } from "./lib/candle-store.js";
import { canonicalizeCandle } from "./lib/canonicalize.js";
import { getLastFireBars, tickCooldowns, recordRuleFires } from "./lib/cooldown-store.js";
import { putIndicatorState } from "./lib/indicator-state-store.js";
import { listDisabledRuleKeys } from "./lib/rule-status-store.js";
import { makeSignalId } from "./lib/signal-store.js";
import { buildIndicatorState } from "./indicators/index.js";
import { scoreTimeframe } from "./signals/score.js";
import { evaluateGates, narrowPair } from "./signals/gates.js";
import { EXCHANGES } from "./exchanges/config.js";

// ---------------------------------------------------------------------------
// DDB client
// ---------------------------------------------------------------------------

const rawClient = new DynamoDBClient({});
const client = DynamoDBDocumentClient.from(rawClient);

const CLOSE_QUORUM_TABLE =
  process.env.TABLE_CLOSE_QUORUM ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}close-quorum`;

const SIGNALS_COLLECTION_TABLE =
  process.env.TABLE_SIGNALS_COLLECTION ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-collection`;

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

/** 30-day TTL for shadow signals (data-collection horizon). */
const TTL_30D = 86_400 * 30;

/**
 * Minimum number of exchanges that must have reported a close before processing.
 * Mirrors the production handler's quorum guard.
 */
const REQUIRED_EXCHANGE_COUNT = (() => {
  const parsed = parseInt(process.env.REQUIRED_EXCHANGE_COUNT ?? "2", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[ShadowHandler] REQUIRED_EXCHANGE_COUNT env var malformed (got "${process.env.REQUIRED_EXCHANGE_COUNT}"); falling back to 2`,
    );
    return 2;
  }
  return parsed;
})();

// ---------------------------------------------------------------------------
// Timeframe type for the shadow handler
// ---------------------------------------------------------------------------

type ShadowTimeframe = "1m" | "5m";

const SHADOW_TIMEFRAMES: ShadowTimeframe[] = ["1m", "5m"];

// ---------------------------------------------------------------------------
// Candle shape from DDB stream record (after unmarshalling)
// ---------------------------------------------------------------------------

interface StreamCandle {
  pair: string;
  exchange: string;
  timeframe: ShadowTimeframe;
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

/**
 * Per-invocation cache of auto-disabled rule keys (Phase 8 §10.10).
 *
 * Same rationale as in indicator-handler.ts: the rule_status table is bounded
 * (≤280 rows) and only changes once per day (rule-prune cron), so amortizing
 * one Scan across the records in a DDB Streams batch is the right cost shape.
 * Reset at the top of each invocation so Lambda warm-pool reuse doesn't keep
 * a stale Set alive across invocations.
 */
let disabledRuleKeysCache: { value: ReadonlySet<string> } | null = null;
function resetDisabledRuleKeysCache(): void {
  disabledRuleKeysCache = null;
}
async function getDisabledRuleKeysCached(): Promise<ReadonlySet<string>> {
  if (disabledRuleKeysCache !== null) return disabledRuleKeysCache.value;
  try {
    const value = await listDisabledRuleKeys();
    disabledRuleKeysCache = { value };
    return value;
  } catch (err) {
    console.warn(
      `[ShadowHandler] Failed to load disabled rule keys; proceeding with empty set: ${(err as Error).message}`,
    );
    const empty = new Set<string>() as ReadonlySet<string>;
    disabledRuleKeysCache = { value: empty };
    return empty;
  }
}

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  // Phase 8 §10.10: refresh the per-invocation disabled-rule cache. The Scan is
  // amortized across all records in a single Streams batch. Reset before the
  // first record so the daily rule-prune verdict isn't masked by warm-pool reuse.
  resetDisabledRuleKeysCache();

  for (const record of event.Records) {
    if (record.eventName !== "INSERT" && record.eventName !== "MODIFY") continue;
    if (!record.dynamodb?.NewImage) continue;

    const candle = unmarshall(
      record.dynamodb.NewImage as Record<string, AttributeValue>,
    ) as StreamCandle;

    // FilterCriteria should have excluded non-shadow timeframes and non-live
    // sources, but guard defensively — belt and suspenders against misconfigured
    // ESM or stale FilterCriteria. Both `live` and `live-synthesized` are
    // accepted (Kraken silent-window carry-forward; #224).
    if (!(SHADOW_TIMEFRAMES as string[]).includes(candle.timeframe)) continue;
    if (candle.source !== "live" && candle.source !== "live-synthesized") continue;

    try {
      await processShadowCandleClose(candle);
    } catch (err) {
      console.error(
        `[ShadowHandler] Error processing ${candle.pair}/${candle.timeframe}@${candle.exchange}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
};

// ---------------------------------------------------------------------------
// Core 4-step flow (shadow variant — no LLM, no blend, no fanout)
// ---------------------------------------------------------------------------

async function processShadowCandleClose(candle: StreamCandle): Promise<void> {
  const { pair, timeframe, closeTime, exchange } = candle;
  const quorumId = `${pair}#${timeframe}#${closeTime}`;

  // Step 1 — ADD exchange to close-quorum (idempotent DDB String Set ADD).
  const ttlSeconds = Math.floor(closeTime / 1000) + 86_400;

  await client.send(
    new UpdateCommand({
      TableName: CLOSE_QUORUM_TABLE,
      Key: { id: quorumId },
      UpdateExpression: "ADD exchanges :ex SET #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":ex": new Set([exchange]),
        ":ttl": ttlSeconds,
      },
    }),
  );

  // Step 2 — Check quorum.
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
      `[ShadowHandler] Quorum not reached for ${quorumId}: ${exchangeCount}/${REQUIRED_EXCHANGE_COUNT} exchanges. Waiting.`,
    );
    return;
  }

  // Step 3 — Check signals-collection for prior processing.
  const sk = `${timeframe}#${closeTime}`;

  const existing = await client.send(
    new GetCommand({
      TableName: SIGNALS_COLLECTION_TABLE,
      Key: { pair, sk },
    }),
  );

  if (existing.Item) {
    console.log(
      `[ShadowHandler] ${pair}/${timeframe}@${closeTime}: signals-collection row already exists — idempotent skip.`,
    );
    return;
  }

  // Step 4 — Compute single-TF score (no blend).
  const vote = await computeSingleTimeframeScore(pair, timeframe as Timeframe, closeTime);
  if (!vote) {
    console.log(
      `[ShadowHandler] ${pair}/${timeframe}: no vote produced (insufficient candles or all warm-up blocked).`,
    );
    return;
  }

  // Generate a time-sortable signal ID for back-compat with analysis tooling.
  // Use the shared helper so shadow rows use the exact same id format as
  // production rows (signal-store.makeSignalId).
  const signalId = makeSignalId(closeTime);
  const emittedAt = new Date(closeTime).toISOString();

  try {
    await client.send(
      new PutCommand({
        TableName: SIGNALS_COLLECTION_TABLE,
        Item: {
          pair,
          sk,
          signalId,
          emittedAt,
          closeTime,
          timeframe,
          // `source: "shadow"` is the distinguishing marker for this table.
          source: "shadow",
          type: vote.type,
          confidence: vote.confidence,
          volatilityFlag: vote.volatilityFlag,
          gateReason: vote.gateReason,
          rulesFired: vote.rulesFired,
          bullishScore: vote.bullishScore,
          bearishScore: vote.bearishScore,
          asOf: vote.asOf,
          // 30d TTL — data collection horizon.
          ttl: Math.floor(Date.now() / 1000) + TTL_30D,
        },
        // Atomic dedup guard — mirrors the production handler.
        ConditionExpression: "attribute_not_exists(pair)",
      }),
    );

    console.log(
      `[ShadowHandler] ${pair}/${timeframe}: shadow signal written (type=${vote.type} confidence=${vote.confidence.toFixed(3)} rulesFired=${vote.rulesFired.length}).`,
    );
  } catch (err) {
    if (
      err instanceof ConditionalCheckFailedException ||
      (err instanceof Error &&
        (err.name === "ConditionalCheckFailedException" ||
          (err as { __type?: string }).__type ===
            "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException"))
    ) {
      console.log(
        `[ShadowHandler] ${pair}/${timeframe}@${closeTime}: conditional Put lost the race — idempotent skip.`,
      );
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Single-timeframe score (no blend, no ratification)
// ---------------------------------------------------------------------------

const DISPERSION_HISTORY_SIZE = 5;

function dispersionHistoryKey(pair: string, tf: Timeframe): string {
  return `dispersion-history#${pair}#${tf}`;
}

async function getDispersionHistory(pair: string, tf: Timeframe): Promise<number[]> {
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
  tf: Timeframe,
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

/**
 * Compute a single-TF score for a short-TF close.
 *
 * Differences from production computeBlendedSignal:
 *   - No blend across timeframes (single TF only — there's no 1h/4h/1d
 *     context to blend against at 1m resolution).
 *   - No Fear/Greed weighting (daily refresh cadence doesn't match 1m bars).
 *   - No LLM ratification.
 *   - Writes indicator state for observability (same as production).
 *   - Applies full gate evaluation (same as production).
 *
 * Returns null when insufficient candle data is available.
 */
async function computeSingleTimeframeScore(
  pair: string,
  tf: Timeframe,
  closeTime: number,
): Promise<import("@quantara/shared").TimeframeVote | null> {
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
          `[ShadowHandler] ${pair}/${tf}@${ex}: no candle found for closeTime=${closeTime} — treating as stale.`,
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
    console.log(`[ShadowHandler] >=2/3 stale for ${pair}/${tf} — skipping shadow computation.`);
    return null;
  }

  const longestExchange = EXCHANGES.reduce((best, ex) => {
    return (perExchangeHistory[ex]?.length ?? 0) > (perExchangeHistory[best]?.length ?? 0)
      ? ex
      : best;
  }, EXCHANGES[0]!);

  const baseCandles = perExchangeHistory[longestExchange] ?? [];
  if (baseCandles.length === 0) {
    console.log(`[ShadowHandler] No candle history for ${pair}/${tf}. Skipping.`);
    return null;
  }

  const candlesNewestFirst = [canon.consensus, ...baseCandles.slice(1)];
  const candlesOldestFirst = [...candlesNewestFirst].reverse();

  // Shadow handler does not use Fear/Greed — daily refresh cadence is
  // irrelevant at 1m. Pass null; rules that dereference fearGreed guard on null.
  const state = buildIndicatorState(candlesOldestFirst, {
    pair,
    exchange: "consensus",
    timeframe: tf,
    fearGreed: null,
    dispersion: canon.dispersion,
  });

  await putIndicatorState(state);

  await tickCooldowns(pair, tf);
  const lastFireBars = await getLastFireBars(pair, tf);
  const dispersionHistory = await appendDispersionHistory(pair, tf, canon.dispersion);

  const narrowedPair = narrowPair(pair);
  const gateResult = evaluateGates(state, narrowedPair, dispersionHistory, stalenessMap);
  // Phase 8 §10.10: pass the auto-disabled set so shadow scoring on 1m/5m
  // doesn't fire rules that the prune job has marked Brier-bad at the same
  // (rule, pair, TF) bucket. (Currently rule_status pks are written for the
  // production TFs, but passing the set is harmless and future-proofs the
  // shadow path if/when we start pruning 1m/5m buckets too.)
  const disabledRuleKeys = await getDisabledRuleKeysCached();
  const vote = scoreTimeframe(state, RULES, lastFireBars, { gateResult, disabledRuleKeys });

  if (vote && vote.rulesFired.length > 0) {
    await recordRuleFires(pair, tf, vote.rulesFired);
  }

  console.log(
    `[ShadowHandler] ${pair}/${tf}: vote=${vote?.type ?? "null"} confidence=${vote?.confidence?.toFixed(3) ?? "n/a"} rulesFired=${vote?.rulesFired?.length ?? 0}`,
  );

  return vote;
}
