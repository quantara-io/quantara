/**
 * Processed-close idempotency marker — Phase 4b follow-up.
 *
 * Stores a per-(pair, timeframe, lastCloseISO) marker in the `ingestion-metadata`
 * table with `attribute_not_exists` conditional semantics so that exactly one
 * invocation of the indicator handler processes any given bar close.
 *
 * Key shape: processed-close#${pair}#${timeframe}#${lastCloseISO}
 * TTL:       24 hours (plenty; the next bar's marker won't conflict)
 *
 * Marker lifecycle:
 *   1. `tryClaimProcessedClose` writes the marker early (distributed lock — blocks
 *      duplicate invocations from duplicating work).
 *   2. On success the caller commits the marker by calling `commitProcessedClose`.
 *   3. On failure the caller calls `clearProcessedClose` so the next retry can
 *      reclaim the slot and re-run the full pipeline.
 */

import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

const MARKER_TTL_SECONDS = 24 * 3600;

/** Build the DynamoDB key for a processed-close marker. */
function markerKey(pair: string, timeframe: string, lastClose: number): string {
  return `processed-close#${pair}#${timeframe}#${new Date(lastClose).toISOString()}`;
}

/**
 * Attempt to atomically claim a processed-close marker (distributed lock).
 *
 * Returns `true` if the claim succeeded (this invocation should do the work).
 * Returns `false` if the marker already exists (another invocation already handled
 * this close — skip all work for this (pair, tf, lastClose)).
 *
 * IMPORTANT: the marker written here is a *tentative* lock. The caller must call
 * `commitProcessedClose` after the vote is safely persisted, or `clearProcessedClose`
 * if the pipeline throws so the next retry can reclaim the slot.
 */
export async function tryClaimProcessedClose(
  pair: string,
  timeframe: string,
  lastClose: number,
): Promise<boolean> {
  const key = markerKey(pair, timeframe, lastClose);
  const ttl = Math.floor(Date.now() / 1000) + MARKER_TTL_SECONDS;

  try {
    await client.send(
      new PutCommand({
        TableName: METADATA_TABLE,
        Item: {
          metaKey: key,
          claimedAt: new Date().toISOString(),
          status: "in-progress",
          ttl,
        },
        ConditionExpression: "attribute_not_exists(metaKey)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}

/**
 * Mark the processed-close marker as committed (pipeline completed successfully).
 *
 * Uses attribute_exists condition so a stale commit of an already-cleared marker
 * does not silently recreate it (idempotent no-op if marker was cleared by a
 * concurrent failure path).
 */
export async function commitProcessedClose(
  pair: string,
  timeframe: string,
  lastClose: number,
): Promise<void> {
  const key = markerKey(pair, timeframe, lastClose);
  const ttl = Math.floor(Date.now() / 1000) + MARKER_TTL_SECONDS;

  try {
    await client.send(
      new PutCommand({
        TableName: METADATA_TABLE,
        Item: {
          metaKey: key,
          claimedAt: new Date().toISOString(),
          status: "committed",
          ttl,
        },
        ConditionExpression: "attribute_exists(metaKey)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Marker was already cleared (concurrent failure path) — safe to ignore.
      return;
    }
    throw err;
  }
}

/**
 * Delete the in-progress processed-close marker so a subsequent retry can
 * reclaim the slot and re-run the full pipeline.
 *
 * Called from the `finally` block on the error path in indicator-handler.ts.
 * Swallows errors — the goal is best-effort cleanup; if DDB is unavailable,
 * the marker TTL (24 h) limits the blast radius to one bar cycle.
 */
export async function clearProcessedClose(
  pair: string,
  timeframe: string,
  lastClose: number,
): Promise<void> {
  const key = markerKey(pair, timeframe, lastClose);

  try {
    await client.send(
      new DeleteCommand({
        TableName: METADATA_TABLE,
        Key: { metaKey: key },
      }),
    );
  } catch (err) {
    // Best-effort — log and continue.
    console.warn(
      `[ProcessedCloseStore] Failed to clear marker ${key}: ${(err as Error).message}`,
    );
  }
}
