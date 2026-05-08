/**
 * Processed-close idempotency marker — Phase 4b follow-up.
 *
 * Stores a per-(pair, timeframe, lastCloseISO) marker in the `ingestion-metadata`
 * table with `attribute_not_exists` conditional semantics so that exactly one
 * invocation of the indicator handler processes any given bar close.
 *
 * Key shape: processed-close#${pair}#${timeframe}#${lastCloseISO}
 * TTL:       24 hours (plenty; the next bar's marker won't conflict)
 */

import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

const MARKER_TTL_SECONDS = 24 * 3600;

/**
 * Attempt to atomically claim a processed-close marker.
 *
 * Returns `true` if the claim succeeded (this invocation should do the work).
 * Returns `false` if the marker already exists (another invocation already handled
 * this close — skip all work for this (pair, tf, lastClose)).
 */
export async function tryClaimProcessedClose(
  pair: string,
  timeframe: string,
  lastClose: number,
): Promise<boolean> {
  const closeISO = new Date(lastClose).toISOString();
  const markerKey = `processed-close#${pair}#${timeframe}#${closeISO}`;
  const ttl = Math.floor(Date.now() / 1000) + MARKER_TTL_SECONDS;

  try {
    await client.send(
      new PutCommand({
        TableName: METADATA_TABLE,
        Item: {
          metaKey: markerKey,
          claimedAt: new Date().toISOString(),
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
