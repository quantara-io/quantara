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
  GetCommand,
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
 *
 * The `signal_outcomes` partition also contains rule-fan-out rows
 * (signalId = "rule-fan-out#{rule}#{signalId}") written by
 * `fanOutToRuleAttributionGSI` — those rows have no `resolvedAt`, and we
 * never want to return them from /history. We add `attribute_exists(resolvedAt)`
 * to the FilterExpression to drop them.
 *
 * DDB applies FilterExpression AFTER Limit, so fan-out rows still count
 * against the page size and would leave pages sparse. As a heuristic, we
 * scan 4x the requested limit internally and trim after filtering. This
 * keeps the response dense in steady state without unbounded reads.
 * Pagination cursor still uses DDB's LastEvaluatedKey (pre-filter) — the
 * client may see slightly variable page sizes near partition boundaries.
 */
const HISTORY_LIMIT_SAFETY_FACTOR = 4;

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
    // attribute_exists(resolvedAt) drops rule-fan-out rows (no resolvedAt attr).
    FilterExpression: "attribute_exists(resolvedAt) AND resolvedAt >= :cutoff",
    ExpressionAttributeValues: {
      ":pair": pair,
      ":cutoff": cutoff,
    },
    // 4x safety factor: DDB filter runs AFTER Limit, so fan-out rows would
    // leave pages sparse. Over-scan internally, then trim to `limit` below.
    Limit: limit * HISTORY_LIMIT_SAFETY_FACTOR,
    ...(cursor
      ? {
          ExclusiveStartKey: JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
          ) as Record<string, unknown>,
        }
      : {}),
  };

  const result = await client.send(new QueryCommand(input));
  const allMatches = (result.Items ?? []) as z.infer<typeof SignalOutcomeEntry>[];
  const outcomes = allMatches.slice(0, limit);

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
 * accuracy_aggregates schema: hash key `pk = "{pair}#{timeframe}"`,
 * range key `window`. We do a direct GetItem on the composite key — there is
 * no honest way to aggregate across timeframes from a hash-key Query
 * (DDB only allows `=` on a hash key, not `begins_with`), and summing
 * pre-aggregated per-timeframe rows would also be statistically wrong
 * (Brier / ECE are not linear across populations). The caller must pick
 * a (pair, timeframe, window).
 *
 * Returns null if no aggregate exists for this (pair, timeframe, window).
 */
export async function getAccuracyAggregate(
  pair: string,
  timeframe: string,
  window: string,
): Promise<z.infer<typeof AccuracyBadge> | null> {
  const result = await client.send(
    new GetCommand({
      TableName: ACCURACY_AGGREGATES_TABLE,
      Key: {
        pk: `${pair}#${timeframe}`,
        window,
      },
    }),
  );

  const row = result.Item;
  if (!row) return null;

  const totalResolved = (row["totalResolved"] as number | undefined) ?? 0;
  const correctCount = (row["correct"] as number | undefined) ?? 0;
  const incorrectCount = (row["incorrect"] as number | undefined) ?? 0;
  const neutralCount = (row["neutral"] as number | undefined) ?? 0;
  const invalidatedCount = (row["invalidatedExcluded"] as number | undefined) ?? 0;
  const computedAt = (row["computedAt"] as string | undefined) ?? "";

  const directional = correctCount + incorrectCount;
  const accuracyPct = directional > 0 ? correctCount / directional : null;

  return {
    pair,
    timeframe,
    window: window as "7d" | "30d" | "90d",
    totalResolved,
    correctCount,
    incorrectCount,
    neutralCount,
    invalidatedCount,
    accuracyPct,
    brier: typeof row["brier"] === "number" ? (row["brier"] as number) : null,
    ece: typeof row["ece"] === "number" ? (row["ece"] as number) : null,
    computedAt,
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
 * Target sample is ~1000 directional rows for K=10 bins to be statistically
 * meaningful. DDB applies FilterExpression AFTER Limit and the `signal_outcomes`
 * partition contains rule-fan-out rows (no resolvedAt) + cross-timeframe rows
 * that will be filtered out, so we over-scan by 4x and let the filter trim
 * down. `attribute_exists(resolvedAt)` drops fan-out rows explicitly.
 */
const CALIBRATION_TARGET_SAMPLE = 1000;
const CALIBRATION_LIMIT_SAFETY_FACTOR = 4;

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
      // attribute_exists(resolvedAt) drops rule-fan-out rows (no resolvedAt attr).
      FilterExpression:
        "attribute_exists(resolvedAt) AND resolvedAt >= :cutoff AND emittingTimeframe = :tf",
      ExpressionAttributeValues: {
        ":pair": pair,
        ":cutoff": cutoff,
        ":tf": timeframe,
      },
      // 4x safety factor: filter runs after Limit, so a Limit of 1000 yields
      // far fewer post-filter rows in partitions with fan-out + multi-tf rows.
      Limit: CALIBRATION_TARGET_SAMPLE * CALIBRATION_LIMIT_SAFETY_FACTOR,
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
