/**
 * ratification-store.ts — RatificationRecord persistence (Phase 6a).
 *
 * Every LLM ratification call (cache hit or miss) is persisted here.
 * Table: quantara-{env}-ratifications
 * Schema: PK=pair (S), SK=invokedAtRecordId (S), TTL=ttl (N, 30 days)
 *
 * Design: §7.9 of docs/SIGNALS_AND_RISK.md
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { BlendedSignal, Timeframe } from "@quantara/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const RATIFICATIONS_TABLE =
  process.env.TABLE_RATIFICATIONS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratifications`;

/** TTL: 30 days in seconds. */
const TTL_SECONDS = 86400 * 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why ratification was either invoked or skipped on this slot.
 *
 * Trigger reasons (LLM was actually called):
 *   - "news"     — news event triggered the gate
 *   - "vol"      — volatility regime change triggered the gate
 *   - "fng-shift"— Fear/Greed shift triggered the gate
 *   - "all"      — multiple trigger conditions fired together
 *   - "sentiment_shock" — out-of-cycle trigger from a sentiment aggregate shock
 *
 * Skip reasons (gate returned shouldInvoke=false; LLM was not called):
 *   - "skip-low-confidence"  — candidate confidence below the floor
 *   - "skip-rate-limited"    — per-(pair, TF) rate limit hit
 *   - "skip-daily-cap"       — per-pair daily cap exceeded
 *   - "skip-no-trigger"      — no trigger condition matched (the common case)
 */
export type InvokedReason =
  | "news"
  | "vol"
  | "fng-shift"
  | "all"
  | "sentiment_shock"
  | "skip-low-confidence"
  | "skip-rate-limited"
  | "skip-daily-cap"
  | "skip-no-trigger";

/**
 * What caused this ratification to be created.
 *
 *   - "bar_close"       — regular per-bar-close ratification path
 *   - "sentiment_shock" — out-of-cycle trigger driven by a large sentiment swing
 *
 * Absent on pre-#167 rows; mapping code defaults to "bar_close".
 */
export type RatificationTrigger = "bar_close" | "sentiment_shock";

export interface RatificationRecord {
  pair: string;
  timeframe: Timeframe;
  algoCandidate: BlendedSignal;
  llmRequest: {
    model: string;
    systemHash: string;
    userJsonHash: string;
  };
  llmRawResponse: object | null;
  cacheHit: boolean;
  validation: { ok: boolean; reason?: string };
  ratified: BlendedSignal | null;
  fellBackToAlgo: boolean;
  latencyMs: number;
  costUsd: number;
  invokedReason: InvokedReason;
  invokedAt: string;
  /**
   * Why this ratification was triggered. Absent on pre-#167 rows; treat as "bar_close".
   *
   * Distinguishes scheduled bar-close ratifications from out-of-cycle sentiment-shock
   * triggers so the two can be analysed independently.
   */
  triggerReason?: RatificationTrigger;
  /**
   * For sentiment_shock records: the recordId of the most-recent bar_close
   * ratification for this pair at the time of the shock. Allows tracing which
   * bar-close verdict was superseded.
   *
   * Absent on bar_close records and on shock records where no prior bar-close
   * ratification exists for the pair.
   */
  previousRatificationId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the composite sort key: "<invokedAt>#<recordId>" */
function buildSortKey(invokedAt: string, recordId: string): string {
  return `${invokedAt}#${recordId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a RatificationRecord.
 * Returns the recordId that was generated.
 */
export async function putRatificationRecord(record: RatificationRecord): Promise<string> {
  const recordId = crypto.randomUUID();
  const invokedAtRecordId = buildSortKey(record.invokedAt, recordId);
  const ttl = Math.floor(Date.parse(record.invokedAt) / 1000) + TTL_SECONDS;

  await ddb.send(
    new PutCommand({
      TableName: RATIFICATIONS_TABLE,
      Item: {
        ...record,
        recordId,
        invokedAtRecordId,
        ttl,
      },
    }),
  );

  return recordId;
}

/**
 * Retrieve recent ratification records for a pair.
 * Newest first (ScanIndexForward=false).
 */
export async function getRecentRatifications(
  pair: string,
  limit = 10,
): Promise<RatificationRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: RATIFICATIONS_TABLE,
      KeyConditionExpression: "#pair = :pair",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: { ":pair": pair },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as RatificationRecord[];
}

/**
 * Retrieve recent sentiment-shock ratification records for a pair within a
 * time window (for cost-gate checks).
 *
 * Returns records where triggerReason="sentiment_shock" and invokedAt >= sinceIso,
 * newest first. Uses a table scan limited by the SK range — this is acceptable
 * because records are keyed by invokedAt (the first component of the composite SK).
 *
 * @param pair      DDB partition key
 * @param sinceIso  ISO-8601 lower bound — only records with invokedAt >= sinceIso
 * @param limit     DDB Limit (max rows scanned; not a page cap)
 */
export async function getRecentShockRatifications(
  pair: string,
  sinceIso: string,
  limit = 20,
): Promise<RatificationRecord[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: RATIFICATIONS_TABLE,
      KeyConditionExpression: "#pair = :pair AND invokedAtRecordId >= :since",
      FilterExpression: "triggerReason = :shock",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: {
        ":pair": pair,
        ":since": sinceIso,
        ":shock": "sentiment_shock" satisfies RatificationTrigger,
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []) as RatificationRecord[];
}
