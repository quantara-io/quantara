/**
 * outcome-store.ts — Phase 8.
 *
 * Read/write helpers for three DynamoDB tables:
 *   - signal-outcomes
 *   - accuracy-aggregates
 *   - rule-attribution
 *
 * Also exposes getKellyStats() for Phase 7 risk module.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import type { OutcomeRecord } from "../outcomes/resolver.js";
import type { AccuracyAggregate, AccuracyWindow } from "../outcomes/aggregate.js";
import type { RuleAttribution } from "../outcomes/attribution.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ---------------------------------------------------------------------------
// Table names (resolved from env vars; fall back to dev prefix convention)
// ---------------------------------------------------------------------------

const TABLE_PREFIX = process.env.TABLE_PREFIX ?? "quantara-dev-";

const OUTCOMES_TABLE = process.env.TABLE_SIGNAL_OUTCOMES ?? `${TABLE_PREFIX}signal-outcomes`;

const ACCURACY_TABLE =
  process.env.TABLE_ACCURACY_AGGREGATES ?? `${TABLE_PREFIX}accuracy-aggregates`;

const ATTRIBUTION_TABLE = process.env.TABLE_RULE_ATTRIBUTION ?? `${TABLE_PREFIX}rule-attribution`;

// ---------------------------------------------------------------------------
// signal-outcomes writes
// ---------------------------------------------------------------------------

/**
 * Persist a single resolved outcome.
 * Does not overwrite an existing resolved outcome (condition: attribute_not_exists).
 * Note: invalidated-excluded outcomes are stored but NOT included in aggregate counts.
 */
export async function putOutcome(outcome: OutcomeRecord): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: OUTCOMES_TABLE,
      Item: {
        pair: outcome.pair,
        signalId: outcome.signalId,
        type: outcome.type,
        confidence: outcome.confidence,
        createdAt: outcome.createdAt,
        expiresAt: outcome.expiresAt,
        resolvedAt: outcome.resolvedAt,
        priceAtSignal: outcome.priceAtSignal,
        priceAtResolution: outcome.priceAtResolution,
        priceMovePct: outcome.priceMovePct,
        atrPctAtSignal: outcome.atrPctAtSignal,
        thresholdUsed: outcome.thresholdUsed,
        outcome: outcome.outcome,
        rulesFired: outcome.rulesFired,
        gateReason: outcome.gateReason,
        emittingTimeframe: outcome.emittingTimeframe,
        invalidatedExcluded: outcome.invalidatedExcluded,
        ttl: outcome.ttl,
      },
      ConditionExpression: "attribute_not_exists(signalId)",
    }),
  );
}

/**
 * Fan out one row per rule into the by-rule GSI sparse projection.
 * Each row is: PK=rule, SK=createdAt#signalId.
 * Batch-written for efficiency (up to 25 rules per signal).
 */
export async function fanOutToRuleAttributionGSI(outcome: OutcomeRecord): Promise<void> {
  if (outcome.rulesFired.length === 0) return;

  const batches: Array<typeof outcome.rulesFired> = [];
  for (let i = 0; i < outcome.rulesFired.length; i += 25) {
    batches.push(outcome.rulesFired.slice(i, i + 25));
  }

  for (const batch of batches) {
    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [OUTCOMES_TABLE]: batch.map((rule) => ({
            PutRequest: {
              Item: {
                // Sparse GSI: pk = rule, sk = createdAt#signalId
                pair: outcome.pair, // table PK (required)
                signalId: `rule-fan-out#${rule}#${outcome.signalId}`, // unique SK for fan-out row
                rule,
                createdAtSignalId: `${outcome.createdAt}#${outcome.signalId}`,
                outcome: outcome.outcome,
                confidence: outcome.confidence,
                emittingTimeframe: outcome.emittingTimeframe,
                // Required by buildRuleAttribution's filter (attribution.ts:70-72):
                rulesFired: outcome.rulesFired, // full array — filter checks .includes(rule)
                resolvedAt: outcome.resolvedAt, // o.resolvedAt >= windowStart guard
                invalidatedExcluded: outcome.invalidatedExcluded, // !o.invalidatedExcluded guard
                ttl: outcome.ttl,
              },
            },
          })),
        },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// signal-outcomes reads
// ---------------------------------------------------------------------------

/**
 * Retrieve all resolved outcomes for a (pair, timeframe) bucket.
 * Used by the aggregator to recompute accuracy windows.
 *
 * @param pair        Trading pair.
 * @param timeframe   Emitting timeframe.
 * @param since       ISO8601 lower bound (oldest resolvedAt to include).
 */
export async function queryOutcomesByPairTimeframe(
  pair: string,
  timeframe: string,
  since: string,
): Promise<OutcomeRecord[]> {
  const results: OutcomeRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: OUTCOMES_TABLE,
        KeyConditionExpression: "#pair = :pair",
        FilterExpression: "#emittingTimeframe = :tf AND #resolvedAt >= :since",
        ExpressionAttributeNames: {
          "#pair": "pair",
          "#emittingTimeframe": "emittingTimeframe",
          "#resolvedAt": "resolvedAt",
        },
        ExpressionAttributeValues: {
          ":pair": pair,
          ":tf": timeframe,
          ":since": since,
        },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      results.push(item as OutcomeRecord);
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey !== undefined);

  return results;
}

/**
 * Retrieve all resolved outcomes where a given rule fired.
 * Uses the by-rule GSI (PK=rule, SK=createdAt#signalId).
 *
 * @param rule    Rule identifier.
 * @param since   ISO8601 lower bound.
 */
export async function queryOutcomesByRule(rule: string, since: string): Promise<OutcomeRecord[]> {
  const results: OutcomeRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: OUTCOMES_TABLE,
        IndexName: "by-rule",
        KeyConditionExpression: "#rule = :rule AND #sk >= :since",
        ExpressionAttributeNames: {
          "#rule": "rule",
          "#sk": "createdAtSignalId",
        },
        ExpressionAttributeValues: {
          ":rule": rule,
          ":since": since,
        },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      results.push(item as OutcomeRecord);
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey !== undefined);

  return results;
}

// ---------------------------------------------------------------------------
// accuracy-aggregates writes / reads
// ---------------------------------------------------------------------------

/** Persist (overwrite) an accuracy aggregate. */
export async function putAccuracyAggregate(agg: AccuracyAggregate): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: ACCURACY_TABLE,
      Item: {
        pk: agg.pk,
        window: agg.window,
        pair: agg.pair,
        timeframe: agg.timeframe,
        totalResolved: agg.totalResolved,
        correct: agg.correct,
        incorrect: agg.incorrect,
        neutral: agg.neutral,
        invalidatedExcluded: agg.invalidatedExcluded,
        accuracyPct: agg.accuracyPct,
        brier: agg.brier,
        ece: agg.ece,
        computedAt: agg.computedAt,
        ttl: agg.ttl,
      },
    }),
  );
}

/** Read the accuracy aggregate for a (pair#timeframe, window) key. */
export async function getAccuracyAggregate(
  pk: string,
  window: AccuracyWindow,
): Promise<AccuracyAggregate | null> {
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const result = await client.send(
    new GetCommand({
      TableName: ACCURACY_TABLE,
      Key: { pk, window },
    }),
  );
  return (result.Item as AccuracyAggregate | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// rule-attribution writes / reads
// ---------------------------------------------------------------------------

/** Persist (overwrite) a rule attribution record. */
export async function putRuleAttribution(attr: RuleAttribution): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: ATTRIBUTION_TABLE,
      Item: {
        pk: attr.pk,
        window: attr.window,
        rule: attr.rule,
        pair: attr.pair,
        timeframe: attr.timeframe,
        fireCount: attr.fireCount,
        correctCount: attr.correctCount,
        incorrectCount: attr.incorrectCount,
        neutralCount: attr.neutralCount,
        contribution: attr.contribution,
        computedAt: attr.computedAt,
        ttl: attr.ttl,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// KellyStats — Phase 7 interface
// ---------------------------------------------------------------------------

/**
 * Kelly statistics for a (pair, timeframe) bucket — used by Phase 7 risk module
 * to size positions via the Kelly criterion.
 */
export interface KellyStats {
  pair: string;
  timeframe: string;
  /** Win rate (correct / directional) over the best available window (90d → 30d → 7d). */
  winRate: number | null;
  /**
   * Average odds (not currently tracked per signal; defaults to 1.0 until Phase 8.1
   * backtest harness captures P&L magnitude).
   */
  avgOdds: number;
  /** Number of directional samples used for this estimate. */
  sampleCount: number;
  /** Which accuracy window was used to derive winRate. */
  sourceWindow: AccuracyWindow;
  computedAt: string;
}

/**
 * Get Kelly statistics for a (pair, timeframe) bucket by reading the best
 * available accuracy aggregate (prefers 90d for stability, falls back to 30d,
 * then 7d).
 *
 * Returns null when no aggregate is available or there are no directional outcomes.
 */
export async function getKellyStats(pair: string, timeframe: string): Promise<KellyStats | null> {
  const pk = `${pair}#${timeframe}`;
  const windows: AccuracyWindow[] = ["90d", "30d", "7d"];

  for (const window of windows) {
    const agg = await getAccuracyAggregate(pk, window);
    if (!agg || agg.accuracyPct === null) continue;

    const directional = agg.correct + agg.incorrect;
    if (directional === 0) continue;

    return {
      pair,
      timeframe,
      winRate: agg.accuracyPct,
      avgOdds: 1.0, // placeholder until Phase 8.1 P&L capture
      sampleCount: directional,
      sourceWindow: window,
      computedAt: agg.computedAt,
    };
  }

  return null;
}
