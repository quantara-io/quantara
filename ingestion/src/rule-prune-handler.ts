/**
 * Rule Prune Handler Lambda — Phase 8 §10.10.
 *
 * Triggered by EventBridge daily at 02:00 UTC.
 *
 * Algorithm per (rule, pair, TF) bucket:
 *   1. Read the 90d rule_attribution row. Skip if fireCount < 30.
 *   2. Compute Brier from signal_outcomes (by-rule GSI) for the 90d window.
 *   3. Read existing rule_status row to get the consecutive-window counter.
 *   4. If brier > BRIER_DISABLE_THRESHOLD (0.30):
 *        highBrierWindows++
 *        If highBrierWindows >= CONSECUTIVE_WINDOWS_REQUIRED (2):
 *          status → "disabled" (unless status === "manual-override")
 *   5. If brier < BRIER_REENABLE_THRESHOLD (0.25) AND status === "disabled":
 *        status → "enabled", reset highBrierWindows to 0.
 *   6. Otherwise: keep existing status, update brier/n/highBrierWindows.
 *
 * Idempotent: running twice in the same day overwrites with the same result
 * (the 90d window is a rolling view of the same outcome records).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import type { RuleAttribution } from "./outcomes/attribution.js";
import type { OutcomeRecord } from "./outcomes/resolver.js";
import { computeBrier } from "./outcomes/aggregate.js";
import { getRuleStatusByPk, putRuleStatus } from "./lib/rule-status-store.js";
import type { RuleStatusRecord, RuleStatusValue } from "./lib/rule-status-store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BRIER_DISABLE_THRESHOLD = 0.3;
const BRIER_REENABLE_THRESHOLD = 0.25;
const CONSECUTIVE_WINDOWS_REQUIRED = 2;
const MIN_N = 30;
// 90d window in ISO time (used to bound the by-rule outcome query).
const WINDOW_90D_MS = 86400 * 90 * 1000;

// ---------------------------------------------------------------------------
// DDB clients
// ---------------------------------------------------------------------------

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_PREFIX = process.env.TABLE_PREFIX ?? "quantara-dev-";
const ATTRIBUTION_TABLE = process.env.TABLE_RULE_ATTRIBUTION ?? `${TABLE_PREFIX}rule-attribution`;
const OUTCOMES_TABLE = process.env.TABLE_SIGNAL_OUTCOMES ?? `${TABLE_PREFIX}signal-outcomes`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Scan all 90d rule_attribution rows. ≤280 rows — Scan is acceptable. */
async function scanAttribution90d(): Promise<RuleAttribution[]> {
  const results: RuleAttribution[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: ATTRIBUTION_TABLE,
        FilterExpression: "#window = :w",
        ExpressionAttributeNames: { "#window": "window" },
        ExpressionAttributeValues: { ":w": "90d" },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      results.push(item as RuleAttribution);
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey !== undefined);

  return results;
}

/**
 * Query signal_outcomes for a given rule over the 90d window via the by-rule GSI.
 * Returns outcome records for Brier computation.
 */
async function queryOutcomesByRule90d(rule: string, since: string): Promise<OutcomeRecord[]> {
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
// Handler
// ---------------------------------------------------------------------------

interface EventBridgeEvent {
  source?: string;
  "detail-type"?: string;
  detail?: unknown;
}

export async function handler(_event: EventBridgeEvent): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const since90d = new Date(now.getTime() - WINDOW_90D_MS).toISOString();

  console.log(`[RulePrune] Starting rule prune at ${nowIso}`);

  // Step 1: Scan all 90d attribution rows.
  const rows = await scanAttribution90d();
  console.log(`[RulePrune] Found ${rows.length} attribution bucket(s) (90d window).`);

  let disabled = 0;
  let reenabled = 0;
  let skipped = 0;

  for (const attr of rows) {
    const pk = attr.pk; // "{rule}#{pair}#{TF}"

    // Step 2: Skip if n < 30 (not enough data to make a reliable decision).
    if (attr.fireCount < MIN_N) {
      skipped++;
      continue;
    }

    // Step 3: Compute Brier from signal_outcomes via by-rule GSI.
    const outcomes = await queryOutcomesByRule90d(attr.rule, since90d);

    // Filter to the specific (pair, timeframe) bucket (the GSI is rule-only).
    const bucketOutcomes = outcomes.filter(
      (o) =>
        o.pair === attr.pair && o.emittingTimeframe === attr.timeframe && !o.invalidatedExcluded,
    );

    const brier = computeBrier(bucketOutcomes);

    // Step 4: Load existing rule_status to get consecutive-window counter.
    const existing = await getRuleStatusByPk(pk);
    const currentStatus: RuleStatusValue = existing?.status ?? "enabled";
    const currentHighBrierWindows = existing?.highBrierWindows ?? 0;

    // Step 5: Skip manual-override buckets (never auto-disable).
    if (currentStatus === "manual-override") {
      // Still update brier/n so the admin can see the current score.
      const updated: RuleStatusRecord = {
        ...existing!,
        brier,
        n: attr.fireCount,
        updatedAt: nowIso,
      };
      await putRuleStatus(updated);
      continue;
    }

    // Step 6: Apply disable / re-enable logic.
    let newStatus: RuleStatusValue = currentStatus;
    let newHighBrierWindows = currentHighBrierWindows;
    let disabledAt = existing?.disabledAt;
    let reason: string | undefined = existing?.reason;

    if (brier > BRIER_DISABLE_THRESHOLD) {
      newHighBrierWindows = currentHighBrierWindows + 1;
      if (newHighBrierWindows >= CONSECUTIVE_WINDOWS_REQUIRED && currentStatus !== "disabled") {
        newStatus = "disabled";
        disabledAt = nowIso;
        reason = `Brier ${brier.toFixed(4)} > ${BRIER_DISABLE_THRESHOLD} for ${newHighBrierWindows} consecutive 90d window(s)`;
        console.log(
          `[RulePrune] Disabling ${pk}: brier=${brier.toFixed(4)}, windows=${newHighBrierWindows}`,
        );
        disabled++;
      }
    } else if (brier < BRIER_REENABLE_THRESHOLD && currentStatus === "disabled") {
      newStatus = "enabled";
      newHighBrierWindows = 0;
      disabledAt = undefined;
      reason = `Re-enabled: Brier ${brier.toFixed(4)} < ${BRIER_REENABLE_THRESHOLD}`;
      console.log(`[RulePrune] Re-enabling ${pk}: brier=${brier.toFixed(4)}`);
      reenabled++;
    } else if (brier <= BRIER_DISABLE_THRESHOLD) {
      // Brier is good (between threshold and re-enable) — reset consecutive counter.
      // Note: this branch also runs when status === "disabled" and brier sits in
      // the (BRIER_REENABLE_THRESHOLD, BRIER_DISABLE_THRESHOLD] band (neither bad
      // enough to keep disabled nor good enough to re-enable). Resetting the
      // counter here is intentional and benign: the counter only governs the
      // enabled→disabled transition (Step 6's first branch gates on
      // `currentStatus !== "disabled"`), and the persisted disabledAt/reason are
      // not rewritten by this branch, so the "re-enable when brier < 0.25"
      // verdict is unaffected.
      newHighBrierWindows = 0;
    }

    const record: RuleStatusRecord = {
      pk,
      status: newStatus,
      ...(reason !== undefined ? { reason } : {}),
      brier,
      n: attr.fireCount,
      ...(disabledAt !== undefined ? { disabledAt } : {}),
      highBrierWindows: newHighBrierWindows,
      updatedAt: nowIso,
    };

    await putRuleStatus(record);
  }

  console.log(
    `[RulePrune] Done. disabled=${disabled} re-enabled=${reenabled} skipped=${skipped} (n<${MIN_N}) total=${rows.length}`,
  );
}
