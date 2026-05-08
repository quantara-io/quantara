/**
 * Cooldown tracking helpers — Phase 4b.
 *
 * Persist and read the lastFireBars map per (pair, timeframe) in the existing
 * `ingestion-metadata` table (same table as fearGreed, backfill cursors).
 * No new DDB table needed.
 *
 * Key shape:  cooldown#${pair}#${timeframe}
 * Value:      Record<ruleName, barsSinceLastFire>
 *
 * Semantics (mirrors scoreRules cooldown convention):
 *   - `barsSinceLastFire[ruleName]` is the number of bars that have elapsed
 *     since the rule last fired (0 = fired at the current bar).
 *   - `tickCooldowns` increments ALL counters by 1 at the top of each handler
 *     invocation for a (pair, TF), representing one bar having passed.
 *   - `recordRuleFires` resets fired rules' counters to 0 (they fired this bar).
 *   - `getLastFireBars` returns the persisted map (empty object if no entry yet).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Timeframe } from "@quantara/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

function cooldownKey(pair: string, timeframe: Timeframe): string {
  return `cooldown#${pair}#${timeframe}`;
}

/**
 * Retrieve the lastFireBars map for a given (pair, timeframe).
 * Returns an empty object if no entry exists yet.
 */
export async function getLastFireBars(
  pair: string,
  timeframe: Timeframe,
): Promise<Record<string, number>> {
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: cooldownKey(pair, timeframe) },
    }),
  );

  if (!result.Item) return {};
  return (result.Item["lastFireBars"] as Record<string, number>) ?? {};
}

/**
 * Increment all existing bar counters by 1 for a (pair, TF).
 * Represents one bar having passed without those rules firing.
 * If no entry exists yet, this is a no-op (nothing to increment).
 */
export async function tickCooldowns(
  pair: string,
  timeframe: Timeframe,
): Promise<void> {
  const existing = await getLastFireBars(pair, timeframe);
  if (Object.keys(existing).length === 0) return;

  const incremented: Record<string, number> = {};
  for (const [ruleName, bars] of Object.entries(existing)) {
    incremented[ruleName] = bars + 1;
  }

  await client.send(
    new PutCommand({
      TableName: METADATA_TABLE,
      Item: {
        metaKey: cooldownKey(pair, timeframe),
        lastFireBars: incremented,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * Reset the bar counters for the fired rules to 0, and merge with the existing
 * state for rules that didn't fire (preserving their accumulated bar counts).
 *
 * Called after scoring, once we know which rules fired this bar.
 */
export async function recordRuleFires(
  pair: string,
  timeframe: Timeframe,
  ruleNames: string[],
): Promise<void> {
  if (ruleNames.length === 0) return;

  const existing = await getLastFireBars(pair, timeframe);

  const updated: Record<string, number> = { ...existing };
  for (const name of ruleNames) {
    updated[name] = 0;
  }

  await client.send(
    new PutCommand({
      TableName: METADATA_TABLE,
      Item: {
        metaKey: cooldownKey(pair, timeframe),
        lastFireBars: updated,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}
