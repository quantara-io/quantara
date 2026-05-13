/**
 * Outcome Handler Lambda — Phase 8.
 *
 * Triggered by EventBridge every 15 minutes.
 *
 * On each invocation:
 *   1. Find signals where expiresAt < now AND outcome === "pending" (max 200).
 *   2. For each signal:
 *      a. If invalidatedAt is set → store as invalidated-excluded, skip resolution.
 *      b. Otherwise → get canonical price at expiresAt, resolve outcome, persist.
 *      c. Fan out to by-rule GSI sparse rows.
 *   3. Recompute accuracy aggregates for all affected (pair, TF) buckets.
 *   4. Recompute rule attribution for all affected (rule, pair, TF) buckets.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { resolveOutcome } from "./outcomes/resolver.js";
import type { BlendedSignalRecord } from "./outcomes/resolver.js";
import { buildAccuracyAggregate } from "./outcomes/aggregate.js";
import type { AccuracyWindow } from "./outcomes/aggregate.js";
import { buildRuleAttribution, getAffectedAttributionKeys } from "./outcomes/attribution.js";
import type { AttributionWindow } from "./outcomes/attribution.js";
import {
  putOutcome,
  fanOutToRuleAttributionGSI,
  queryOutcomesByPairTimeframe,
  putAccuracyAggregate,
  putRuleAttribution,
  queryOutcomesByRule,
} from "./lib/outcome-store.js";
import { getCandles } from "./lib/candle-store.js";
import { canonicalizeCandle } from "./lib/canonicalize.js";
import { EXCHANGES } from "./exchanges/config.js";
import type { OutcomeRecord } from "./outcomes/resolver.js";

// ---------------------------------------------------------------------------
// DDB client — signals-v2 table (for querying expired pending signals)
// ---------------------------------------------------------------------------

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_PREFIX = process.env.TABLE_PREFIX ?? "quantara-dev-";
const SIGNALS_V2_TABLE = process.env.TABLE_SIGNALS_V2 ?? `${TABLE_PREFIX}signals-v2`;

const MAX_BATCH = 200;

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
  const now = new Date().toISOString();
  console.log(`[OutcomeHandler] Starting outcome resolution at ${now}`);

  // Step 1: Find signals that have expired with outcome "pending".
  const expired = await queryExpiredSignals(now);
  if (expired.length === 0) {
    console.log("[OutcomeHandler] No expired signals to resolve.");
    return;
  }

  console.log(`[OutcomeHandler] Resolving ${expired.length} expired signal(s).`);

  const resolvedOutcomes: OutcomeRecord[] = [];

  // Step 2: Resolve each signal.
  for (const signal of expired) {
    try {
      if (signal.invalidatedAt !== null) {
        // Invalidated signals are stored as excluded (for transparency counters).
        const excluded = resolveOutcome(signal, signal.priceAtSignal, signal.atrPctAtSignal, now);
        await putOutcome(excluded);
        resolvedOutcomes.push(excluded);
        await markSignalOutcomeResolved(signal.pair, signal.sk, "neutral");
        console.log(`[OutcomeHandler] ${signal.signalId}: invalidated — excluded from counts.`);
        continue;
      }

      // Get canonical price at resolution time.
      const priceAtResolution = await getCanonicalPrice(signal.pair, signal.expiresAt);
      if (priceAtResolution === null) {
        console.warn(
          `[OutcomeHandler] ${signal.signalId}: cannot get canonical price at ${signal.expiresAt} — skipping.`,
        );
        continue;
      }

      const resolved = resolveOutcome(signal, priceAtResolution, signal.atrPctAtSignal, now);
      await putOutcome(resolved);
      await fanOutToRuleAttributionGSI(resolved);
      await markSignalOutcomeResolved(signal.pair, signal.sk, resolved.outcome);
      resolvedOutcomes.push(resolved);
      console.log(
        `[OutcomeHandler] ${signal.signalId}: ${signal.type} → ${resolved.outcome} (move=${(resolved.priceMovePct * 100).toFixed(2)}%, threshold=${(resolved.thresholdUsed * 100).toFixed(2)}%)`,
      );
    } catch (err) {
      console.error(
        `[OutcomeHandler] Error resolving ${signal.signalId}: ${(err as Error).message}`,
      );
      // Continue processing remaining signals.
    }
  }

  // Step 3: Recompute accuracy aggregates for affected (pair, TF) buckets.
  const affectedPairTf = new Set(resolvedOutcomes.map((o) => `${o.pair}#${o.emittingTimeframe}`));

  for (const key of affectedPairTf) {
    const [pair, timeframe] = key.split("#") as [string, string];
    for (const window of ["7d", "30d", "90d"] as AccuracyWindow[]) {
      try {
        await recomputeAccuracyAggregate(pair, timeframe, window, now);
      } catch (err) {
        console.error(
          `[OutcomeHandler] Error recomputing accuracy ${key}/${window}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Step 4: Recompute rule attribution for affected (rule, pair, TF) buckets.
  const affectedRuleKeys = getAffectedAttributionKeys(
    resolvedOutcomes.filter((o) => !o.invalidatedExcluded),
  );

  for (const key of affectedRuleKeys) {
    const parts = key.split("#");
    if (parts.length < 3) continue;
    // Key format: "rule#pair#timeframe" (rule may contain # if namespaced).
    // We split at the last two # separators to be safe.
    const timeframe = parts[parts.length - 1]!;
    const pair = parts[parts.length - 2]!;
    const rule = parts.slice(0, parts.length - 2).join("#");

    for (const window of ["30d", "90d"] as AttributionWindow[]) {
      try {
        await recomputeRuleAttribution(rule, pair, timeframe, window, now);
      } catch (err) {
        console.error(
          `[OutcomeHandler] Error recomputing attribution ${key}/${window}: ${(err as Error).message}`,
        );
      }
    }
  }

  console.log(`[OutcomeHandler] Done. Resolved: ${resolvedOutcomes.length} outcomes.`);
}

// ---------------------------------------------------------------------------
// Query expired pending signals
// ---------------------------------------------------------------------------

/**
 * Scan signals-v2 for records where expiresAt < now and outcome === "pending".
 * Uses a GSI by-expiry (or a filter scan since this is a scheduled batch).
 *
 * NOTE: The signals-v2 table does not have an expiresAt GSI in Phase 4a.
 * We use a filter on the base table scan, limited to MAX_BATCH items processed
 * per invocation. Production hardening (dedicated GSI or DDB Streams) is
 * tracked as a Phase 8 follow-up.
 */
async function queryExpiredSignals(now: string): Promise<BlendedSignalRecord[]> {
  const results: BlendedSignalRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        // Use a full table scan with in-process filter (no expiresAt GSI in Phase 4a).
        // Acceptable for small signal volumes; a dedicated GSI is tracked as a Phase 8 follow-up.
        TableName: SIGNALS_V2_TABLE,
        Limit: MAX_BATCH,
        ExclusiveStartKey: lastKey,
      }),
    );
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    // Filter + map in-process.
    for (const item of result.Items ?? []) {
      if (
        typeof item["expiresAt"] === "string" &&
        item["expiresAt"] < now &&
        (item["outcomeStatus"] === "pending" || item["outcomeStatus"] === undefined)
      ) {
        results.push(itemToSignalRecord(item));
        if (results.length >= MAX_BATCH) break;
      }
    }
    if (results.length >= MAX_BATCH) break;
  } while (lastKey !== undefined);

  return results;
}

function itemToSignalRecord(item: Record<string, unknown>): BlendedSignalRecord {
  return {
    signalId: item["signalId"] as string,
    sk: item["sk"] as string,
    pair: item["pair"] as string,
    type: item["type"] as BlendedSignalRecord["type"],
    confidence: item["confidence"] as number,
    createdAt: (item["emittedAt"] as string) ?? new Date().toISOString(),
    expiresAt: item["expiresAt"] as string,
    priceAtSignal: (item["priceAtSignal"] as number) ?? 0,
    atrPctAtSignal: (item["atrPctAtSignal"] as number) ?? 0.02, // default 2% ATR if missing
    gateReason: (item["gateReason"] as string | null) ?? null,
    rulesFired: (item["rulesFired"] as string[]) ?? [],
    emittingTimeframe: (item["emittingTimeframe"] as string) ?? "1h",
    invalidatedAt: (item["invalidatedAt"] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Mark signal outcome resolved (prevents double-resolution on next invocation)
// ---------------------------------------------------------------------------

async function markSignalOutcomeResolved(
  pair: string,
  sk: string,
  _outcome: string,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: SIGNALS_V2_TABLE,
      Key: { pair, sk },
      UpdateExpression: "SET outcomeStatus = :resolved, outcomeAt = :now",
      ExpressionAttributeValues: {
        ":resolved": "resolved",
        ":now": new Date().toISOString(),
      },
      // No ConditionExpression — idempotent: setting an already-resolved row to resolved is safe.
    }),
  );
}

// ---------------------------------------------------------------------------
// Canonical price lookup
// ---------------------------------------------------------------------------

/**
 * Get the consensus (median-of-exchanges) close price for a pair at a given time.
 * Reads the candles table and canonicalizes across exchanges, matching the §2 algorithm.
 *
 * Returns null if no consensus can be established (fewer than 2 non-stale candles).
 */
async function getCanonicalPrice(pair: string, atTime: string): Promise<number | null> {
  const targetMs = new Date(atTime).getTime();

  // For each exchange, find the candle whose closeTime is closest to atTime.
  const perExchangeCandle: Record<string, import("@quantara/shared").Candle | null> = {};
  const staleness: Record<string, boolean> = {};

  await Promise.all(
    EXCHANGES.map(async (ex) => {
      try {
        // Query candles around the target time (limit 5 to find the nearest bar).
        const candles = await getCandles(pair, ex, "1h", 5);
        if (candles.length === 0) {
          perExchangeCandle[ex] = null;
          staleness[ex] = true;
          return;
        }
        // Find candle whose closeTime is nearest to targetMs.
        const best = candles.reduce((prev, curr) => {
          const prevDelta = Math.abs(prev.closeTime - targetMs);
          const currDelta = Math.abs(curr.closeTime - targetMs);
          return currDelta < prevDelta ? curr : prev;
        });
        // Reject candle if it's more than 2 hours off target.
        const deltaMs = Math.abs(best.closeTime - targetMs);
        if (deltaMs > 2 * 3600 * 1000) {
          perExchangeCandle[ex] = null;
          staleness[ex] = true;
        } else {
          perExchangeCandle[ex] = best;
          staleness[ex] = false;
        }
      } catch {
        perExchangeCandle[ex] = null;
        staleness[ex] = true;
      }
    }),
  );

  const canon = canonicalizeCandle(perExchangeCandle, staleness);
  return canon?.consensus.close ?? null;
}

// ---------------------------------------------------------------------------
// Aggregate recomputation
// ---------------------------------------------------------------------------

async function recomputeAccuracyAggregate(
  pair: string,
  timeframe: string,
  window: AccuracyWindow,
  now: string,
): Promise<void> {
  // Look back 90d max (the longest window we support).
  const since = new Date(new Date(now).getTime() - 86400 * 90 * 1000).toISOString();
  const outcomes = await queryOutcomesByPairTimeframe(pair, timeframe, since);

  const agg = buildAccuracyAggregate(pair, timeframe, window, outcomes, now);
  await putAccuracyAggregate(agg);
}

async function recomputeRuleAttribution(
  rule: string,
  pair: string,
  timeframe: string,
  window: AttributionWindow,
  now: string,
): Promise<void> {
  // Look back 90d max.
  const since = new Date(new Date(now).getTime() - 86400 * 90 * 1000).toISOString();
  const outcomes = await queryOutcomesByRule(rule, since);
  // Further filter to this pair/timeframe.
  const filtered = outcomes.filter((o) => o.pair === pair && o.emittingTimeframe === timeframe);

  const attr = buildRuleAttribution(rule, pair, timeframe, window, filtered, now);
  await putRuleAttribution(attr);
}
