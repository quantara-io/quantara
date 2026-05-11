/**
 * DynamoDB read helpers for the Phase 8 performance API.
 *
 * Tables:
 *   signal_outcomes      — PK: pair, SK: signalId
 *   accuracy_aggregates  — PK: pk ("pair#timeframe"), SK: window
 *   rule_attribution     — PK: pk ("rule#pair#timeframe"), SK: window
 *
 * All table names are resolved from environment variables with a fallback to
 * the TABLE_PREFIX pattern used across the backend codebase.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { z } from "@hono/zod-openapi";

import type {
  SignalOutcomeEntry,
  AccuracyBadge,
  CalibrationBin,
  RuleAttributionEntry,
} from "./schemas/signals-performance.js";

// ---------------------------------------------------------------------------
// Table name resolution
// ---------------------------------------------------------------------------

const TABLE_PREFIX = process.env.TABLE_PREFIX ?? "quantara-dev-";

const SIGNAL_OUTCOMES_TABLE = process.env.TABLE_SIGNAL_OUTCOMES ?? `${TABLE_PREFIX}signal-outcomes`;

const ACCURACY_AGGREGATES_TABLE =
  process.env.TABLE_ACCURACY_AGGREGATES ?? `${TABLE_PREFIX}accuracy-aggregates`;

const RULE_ATTRIBUTION_TABLE =
  process.env.TABLE_RULE_ATTRIBUTION ?? `${TABLE_PREFIX}rule-attribution`;

// ---------------------------------------------------------------------------
// Client (module-level — reused across Lambda invocations)
// ---------------------------------------------------------------------------

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ---------------------------------------------------------------------------
// Window → milliseconds
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<string, number> = {
  "7d": 86400 * 7 * 1000,
  "30d": 86400 * 30 * 1000,
  "90d": 86400 * 90 * 1000,
};

function windowCutoffIso(window: string): string {
  const cutoff = Date.now() - (WINDOW_MS[window] ?? WINDOW_MS["30d"]!);
  return new Date(cutoff).toISOString();
}

// ---------------------------------------------------------------------------
// Calibration bin computation (K=10, width 0.1)
// ---------------------------------------------------------------------------

const ECE_BIN_COUNT = 10;

interface RawOutcomeForCalibration {
  confidence: number;
  outcome: "correct" | "incorrect" | "neutral";
  invalidatedExcluded: boolean;
}

function computeCalibrationBins(
  outcomes: RawOutcomeForCalibration[],
): z.infer<typeof CalibrationBin>[] {
  // Exclude invalidated and neutral outcomes — calibration is directional only.
  const directional = outcomes.filter((o) => !o.invalidatedExcluded && o.outcome !== "neutral");

  const bins: { count: number; sumConfidence: number; correct: number }[] = Array.from(
    { length: ECE_BIN_COUNT },
    () => ({ count: 0, sumConfidence: 0, correct: 0 }),
  );

  for (const o of directional) {
    const idx = Math.min(ECE_BIN_COUNT - 1, Math.floor(o.confidence * ECE_BIN_COUNT));
    bins[idx]!.count++;
    bins[idx]!.sumConfidence += o.confidence;
    if (o.outcome === "correct") bins[idx]!.correct++;
  }

  return bins.map((b, i) => ({
    binLow: i / ECE_BIN_COUNT,
    binHigh: (i + 1) / ECE_BIN_COUNT,
    count: b.count,
    meanConfidence: b.count > 0 ? b.sumConfidence / b.count : (i + 0.5) / ECE_BIN_COUNT,
    actualAccuracy: b.count > 0 ? b.correct / b.count : 0,
  }));
}

// ---------------------------------------------------------------------------
// GET /signals/history
// ---------------------------------------------------------------------------

export interface SignalHistoryPage {
  outcomes: z.infer<typeof SignalOutcomeEntry>[];
  hasMore: boolean;
  nextCursor: string | undefined;
}

/**
 * Query recent resolved signals for a pair, filtered to a rolling window.
 *
 * DDB key: PK=pair, SK=signalId. We Query all rows for the pair, filter by
 * resolvedAt >= cutoff, and paginate via DDB LastEvaluatedKey encoded as a
 * base64url cursor.
 */
export async function getSignalHistory(
  pair: string,
  window: string,
  limit: number,
  cursor: string | undefined,
): Promise<SignalHistoryPage> {
  const cutoff = windowCutoffIso(window);

  const input: QueryCommandInput = {
    TableName: SIGNAL_OUTCOMES_TABLE,
    KeyConditionExpression: "pair = :pair",
    FilterExpression: "resolvedAt >= :cutoff",
    ExpressionAttributeValues: {
      ":pair": pair,
      ":cutoff": cutoff,
    },
    Limit: limit,
    ...(cursor
      ? {
          ExclusiveStartKey: JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
          ) as Record<string, unknown>,
        }
      : {}),
  };

  const result = await client.send(new QueryCommand(input));
  const outcomes = (result.Items ?? []) as z.infer<typeof SignalOutcomeEntry>[];

  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url")
    : undefined;

  return { outcomes, hasMore: !!nextCursor, nextCursor };
}

// ---------------------------------------------------------------------------
// GET /signals/accuracy
// ---------------------------------------------------------------------------

/**
 * Read the pre-aggregated accuracy badge from accuracy_aggregates.
 *
 * accuracy_aggregates PK: "pair#timeframe", SK: window.
 * We query across all timeframe variants for the pair and sum into one badge.
 * Returns null if no aggregate exists yet for this pair+window.
 */
export async function getAccuracyAggregate(
  pair: string,
  window: string,
): Promise<z.infer<typeof AccuracyBadge> | null> {
  // Query all timeframe buckets for this pair using begins_with on pk.
  const result = await client.send(
    new QueryCommand({
      TableName: ACCURACY_AGGREGATES_TABLE,
      KeyConditionExpression: "begins_with(pk, :prefix) AND #w = :window",
      ExpressionAttributeNames: { "#w": "window" },
      ExpressionAttributeValues: {
        ":prefix": `${pair}#`,
        ":window": window,
      },
    }),
  );

  const rows = result.Items ?? [];
  if (rows.length === 0) return null;

  // Sum across all timeframe rows into a single pair-level badge.
  let totalResolved = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let neutralCount = 0;
  let invalidatedCount = 0;
  let latestComputedAt = "";
  let brierSum = 0;
  let brierCount = 0;
  let eceSum = 0;
  let eceCount = 0;

  for (const row of rows) {
    totalResolved += (row["totalResolved"] as number | undefined) ?? 0;
    correctCount += (row["correct"] as number | undefined) ?? 0;
    incorrectCount += (row["incorrect"] as number | undefined) ?? 0;
    neutralCount += (row["neutral"] as number | undefined) ?? 0;
    invalidatedCount += (row["invalidatedExcluded"] as number | undefined) ?? 0;

    const ca = (row["computedAt"] as string | undefined) ?? "";
    if (ca > latestComputedAt) latestComputedAt = ca;

    if (typeof row["brier"] === "number") {
      brierSum += row["brier"] as number;
      brierCount++;
    }
    if (typeof row["ece"] === "number") {
      eceSum += row["ece"] as number;
      eceCount++;
    }
  }

  const directional = correctCount + incorrectCount;
  const accuracyPct = directional > 0 ? correctCount / directional : null;

  return {
    pair,
    window: window as "7d" | "30d" | "90d",
    totalResolved,
    correctCount,
    incorrectCount,
    neutralCount,
    invalidatedCount,
    accuracyPct,
    brier: brierCount > 0 ? brierSum / brierCount : null,
    ece: eceCount > 0 ? eceSum / eceCount : null,
    computedAt: latestComputedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /signals/calibration
// ---------------------------------------------------------------------------

export interface CalibrationResult {
  totalUsed: number;
  bins: z.infer<typeof CalibrationBin>[];
}

/**
 * Compute calibration chart data by reading raw signal_outcomes rows for the
 * given (pair, timeframe) and aggregating on the fly into K=10 bins.
 *
 * Reads up to 1000 rows — acceptable for the calibration endpoint which is
 * called infrequently and cacheable at the edge.
 */
export async function getCalibrationData(
  pair: string,
  timeframe: string,
  window: string,
): Promise<CalibrationResult> {
  const cutoff = windowCutoffIso(window);

  const result = await client.send(
    new QueryCommand({
      TableName: SIGNAL_OUTCOMES_TABLE,
      KeyConditionExpression: "pair = :pair",
      FilterExpression: "resolvedAt >= :cutoff AND emittingTimeframe = :tf",
      ExpressionAttributeValues: {
        ":pair": pair,
        ":cutoff": cutoff,
        ":tf": timeframe,
      },
      // Cap at 1000 rows — enough for calibration; avoids unbounded reads.
      Limit: 1000,
    }),
  );

  const items = (result.Items ?? []) as RawOutcomeForCalibration[];
  const bins = computeCalibrationBins(items);
  const totalUsed = bins.reduce((s, b) => s + b.count, 0);

  return { totalUsed, bins };
}

// ---------------------------------------------------------------------------
// GET /signals/attribution
// ---------------------------------------------------------------------------

/**
 * Fetch all rule attribution rows for a (pair, timeframe, window).
 *
 * rule_attribution PK: "rule#pair#timeframe", SK: window.
 * There is no GSI by pair+timeframe, so we use Scan with a FilterExpression.
 * The table is bounded at ~560 rows (per the Terraform comment), so a full
 * table scan is acceptable and will remain cheap.
 */
export async function getRuleAttributionData(
  pair: string,
  timeframe: string,
  window: string,
): Promise<z.infer<typeof RuleAttributionEntry>[]> {
  // pk suffix uniquely identifies (pair, timeframe) within the rule attribution table.
  const pkSuffix = `#${pair}#${timeframe}`;

  const result = await client.send(
    new ScanCommand({
      TableName: RULE_ATTRIBUTION_TABLE,
      FilterExpression: "contains(pk, :suffix) AND #w = :window",
      ExpressionAttributeNames: { "#w": "window" },
      ExpressionAttributeValues: {
        ":suffix": pkSuffix,
        ":window": window,
      },
    }),
  );

  const items = result.Items ?? [];

  return items.map((row) => ({
    // pk is "rule#pair#timeframe" — rule is the first segment.
    rule: (row["rule"] as string | undefined) ?? (row["pk"] as string).split("#")[0] ?? "",
    fireCount: (row["fireCount"] as number | undefined) ?? 0,
    correctCount: (row["correctCount"] as number | undefined) ?? 0,
    incorrectCount: (row["incorrectCount"] as number | undefined) ?? 0,
    neutralCount: (row["neutralCount"] as number | undefined) ?? 0,
    contribution: typeof row["contribution"] === "number" ? (row["contribution"] as number) : null,
    computedAt: (row["computedAt"] as string | undefined) ?? "",
  }));
}
