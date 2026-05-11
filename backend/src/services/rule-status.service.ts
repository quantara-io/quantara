/**
 * rule-status.service.ts — Phase 8 §10.10.
 *
 * Backend service for the admin rule-status API routes:
 *   GET  /api/admin/rule-status        — list all rule_status rows
 *   PATCH /api/admin/rule-status/{key} — set manual-override on a bucket
 *
 * The rule_status table is written by the rule-prune Lambda (ingestion side).
 * The API Lambda only reads it (GET) and overrides it (PATCH).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_PREFIX = process.env.TABLE_PREFIX ?? "quantara-dev-";
const RULE_STATUS_TABLE = process.env.TABLE_RULE_STATUS ?? `${TABLE_PREFIX}rule-status`;

// ---------------------------------------------------------------------------
// Types (mirrored from ingestion side — duplicated to avoid cross-workspace dep)
// ---------------------------------------------------------------------------

export type RuleStatusValue = "enabled" | "disabled" | "manual-override";

export interface RuleStatusRecord {
  /** "{rule}#{pair}#{TF}" */
  pk: string;
  status: RuleStatusValue;
  reason?: string;
  brier?: number;
  n?: number;
  disabledAt?: string;
  manualOverrideUntil?: string;
  highBrierWindows?: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Scan all rule_status rows.
 * The table has ≤280 rows (14 rules × 5 pairs × 4 TFs) — a Scan is acceptable.
 */
export async function listRuleStatuses(): Promise<RuleStatusRecord[]> {
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

/**
 * Get a single rule_status record by its composite pk.
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

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SetManualOverrideOptions {
  /** Composite pk: "{rule}#{pair}#{TF}" */
  pk: string;
  /**
   * When "manual-override": the bucket is excluded from auto-disable logic
   * until `manualOverrideUntil` (if set) or indefinitely.
   * When "enabled": clears a previous manual-override and re-enables the rule.
   */
  status: "manual-override" | "enabled" | "disabled";
  reason?: string;
  /** ISO8601 date-time after which the prune job may resume auto-disable. */
  manualOverrideUntil?: string;
  /** userId of the admin performing the override (for audit). */
  updatedBy: string;
}

/**
 * Upsert a rule_status row with a manual override.
 * Preserves existing brier/n/highBrierWindows/disabledAt from the current row
 * so that context isn't lost when an admin overrides a decision.
 */
export async function setManualOverride(opts: SetManualOverrideOptions): Promise<RuleStatusRecord> {
  const existing = await getRuleStatusByPk(opts.pk);
  const nowIso = new Date().toISOString();

  const record: RuleStatusRecord & { updatedBy?: string } = {
    pk: opts.pk,
    status: opts.status,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    // Preserve existing metrics from the prune job.
    ...(existing?.brier !== undefined ? { brier: existing.brier } : {}),
    ...(existing?.n !== undefined ? { n: existing.n } : {}),
    ...(existing?.disabledAt !== undefined ? { disabledAt: existing.disabledAt } : {}),
    ...(existing?.highBrierWindows !== undefined
      ? { highBrierWindows: existing.highBrierWindows }
      : {}),
    ...(opts.manualOverrideUntil !== undefined
      ? { manualOverrideUntil: opts.manualOverrideUntil }
      : {}),
    updatedAt: nowIso,
    updatedBy: opts.updatedBy,
  };

  await client.send(
    new PutCommand({
      TableName: RULE_STATUS_TABLE,
      Item: record,
    }),
  );

  // Return without the internal updatedBy field (not part of the public type).
  const { updatedBy: _drop, ...publicRecord } = record;
  return publicRecord;
}
