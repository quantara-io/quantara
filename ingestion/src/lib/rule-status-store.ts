/**
 * rule-status-store.ts — Phase 8 §10.10.
 *
 * Read/write helpers for the rule_status DynamoDB table.
 *
 * Schema:
 *   PK: pk (S) — "{rule}#{pair}#{TF}"
 *   status: "enabled" | "disabled" | "manual-override"
 *   reason?:               string
 *   brier?:                number
 *   n?:                    number  (fireCount from the 90d attribution window)
 *   disabledAt?:           string  (ISO8601)
 *   manualOverrideUntil?:  string  (ISO8601)
 *   highBrierWindows?:     number  (consecutive 90d eval windows where brier > 0.30)
 *   updatedAt:             string  (ISO8601)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_PREFIX = process.env.TABLE_PREFIX ?? "quantara-dev-";
const RULE_STATUS_TABLE = process.env.TABLE_RULE_STATUS ?? `${TABLE_PREFIX}rule-status`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuleStatusValue = "enabled" | "disabled" | "manual-override";

export interface RuleStatusRecord {
  /** "{rule}#{pair}#{TF}" */
  pk: string;
  status: RuleStatusValue;
  reason?: string;
  brier?: number;
  /** fireCount from the 90d attribution window (n >= 30 threshold). */
  n?: number;
  disabledAt?: string;
  /** If set, the auto-disable logic skips this bucket until after this date. */
  manualOverrideUntil?: string;
  /** Number of consecutive 90d evaluation windows where brier > 0.30. */
  highBrierWindows?: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Get the rule status record for a single (rule, pair, TF) bucket.
 * Returns null if the row has never been written (defaults to "enabled").
 */
export async function getRuleStatus(
  rule: string,
  pair: string,
  timeframe: string,
): Promise<RuleStatusRecord | null> {
  const pk = `${rule}#${pair}#${timeframe}`;
  const result = await client.send(
    new GetCommand({
      TableName: RULE_STATUS_TABLE,
      Key: { pk },
    }),
  );
  return (result.Item as RuleStatusRecord | undefined) ?? null;
}

/**
 * Get the rule status for a single bucket by its composite PK.
 * Returns null if not found.
 */
export async function getRuleStatusByPk(pk: string): Promise<RuleStatusRecord | null> {
  const result = await client.send(
    new GetCommand({
      TableName: RULE_STATUS_TABLE,
      Key: { pk },
    }),
  );
  return (result.Item as RuleStatusRecord | undefined) ?? null;
}

/**
 * Scan all rule status records.
 * The table has ≤280 buckets (14 rules × 5 pairs × 4 TFs) — a full Scan is acceptable.
 */
export async function scanAllRuleStatuses(): Promise<RuleStatusRecord[]> {
  const results: RuleStatusRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: RULE_STATUS_TABLE,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      results.push(item as RuleStatusRecord);
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey !== undefined);

  return results;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Persist (overwrite) a rule status record.
 */
export async function putRuleStatus(record: RuleStatusRecord): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: RULE_STATUS_TABLE,
      Item: {
        pk: record.pk,
        status: record.status,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
        ...(record.brier !== undefined ? { brier: record.brier } : {}),
        ...(record.n !== undefined ? { n: record.n } : {}),
        ...(record.disabledAt !== undefined ? { disabledAt: record.disabledAt } : {}),
        ...(record.manualOverrideUntil !== undefined
          ? { manualOverrideUntil: record.manualOverrideUntil }
          : {}),
        ...(record.highBrierWindows !== undefined
          ? { highBrierWindows: record.highBrierWindows }
          : {}),
        updatedAt: record.updatedAt,
      },
    }),
  );
}
