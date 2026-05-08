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

export type InvokedReason = "news" | "vol" | "fng-shift" | "all";

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
