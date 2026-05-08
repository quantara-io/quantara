/**
 * signal-service — backend read path for trading signals.
 *
 * On every fetch, the user record is lazily bootstrapped (getOrCreateUserRecord)
 * so that:
 *  - First-time users get tier="free" + conservative risk defaults automatically.
 *  - Existing users' profiles (including per-pair overrides) are preserved.
 *
 * This is the ONLY place where user-store bootstrap is invoked from the
 * signal read path. It is never called from auth routes or JWT middleware.
 *
 * Read path:
 *   signals_v2 table — PK: pair, SK: emittedAtSignalId (ISO8601#uuid).
 *   Queried with ScanIndexForward: false, Limit: 1 to get the latest signal
 *   for a pair, or Limit: N to get recent signals across all pairs.
 *
 *   The table is written by the indicator Lambda handler (ingestion service).
 *   If the table is empty (no signals emitted yet), these functions return
 *   null / [] — that is the correct empty-state behavior, not a bug.
 *   Once the indicator handler has emitted at least one signal for a pair,
 *   the read path returns it without any further code changes.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { BlendedSignal } from "@quantara/shared";
import { PAIRS, type TradingPair } from "@quantara/shared";

import { BlendedSignalSchema } from "./schemas/genie.js";
import { getOrCreateUserRecord } from "./user-store.js";

export type { TradingPair };
export { PAIRS };

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Map a raw DynamoDB item to a BlendedSignal.
 *
 * Validates against BlendedSignalSchema rather than blind-casting — schemas
 * exist to gate trust at the system boundary. If the persisted shape diverges
 * from the schema (e.g. an indicator-handler regression writes garbage),
 * we throw early at parse time with a clear error rather than propagating
 * undefined fields to callers.
 */
function itemToBlendedSignal(item: Record<string, unknown>): BlendedSignal {
  const parsed = BlendedSignalSchema.parse(item);
  // The parsed shape is structurally identical to BlendedSignal; cast through unknown to
  // satisfy TypeScript without a runtime trip (parse already validated).
  return parsed as unknown as BlendedSignal;
}

/**
 * Fetch the latest signal for a pair, enriching with the user's risk profile.
 * Bootstraps the user record on first call.
 *
 * Returns null when no signal has been emitted for this pair yet — this is
 * normal during early deployment before the indicator handler has processed
 * sufficient candle data for the pair.
 *
 * @param userId  Authenticated user id (AuthContext.userId).
 * @param pair    Trading pair — must be a member of PAIRS.
 * @param email   Optional email from JWT claims passed to bootstrap.
 * @returns       The latest BlendedSignal, or null if no signal is available yet.
 */
export async function getSignalForUser(
  userId: string,
  pair: TradingPair,
  email?: string,
): Promise<BlendedSignal | null> {
  // Lazy bootstrap — creates record with tier="free" on first authenticated request.
  await getOrCreateUserRecord(userId, email);

  const result = await client.send(
    new QueryCommand({
      TableName: SIGNALS_V2_TABLE,
      KeyConditionExpression: "#pair = :pair",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: { ":pair": pair },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  const item = result.Items?.[0];
  if (!item) return null;
  return itemToBlendedSignal(item);
}

/**
 * Fetch all latest signals (one per pair), bootstrapping the user record if needed.
 *
 * Returns an empty array when no signals have been emitted yet — correct
 * empty-state behavior while the indicator handler warms up.
 *
 * @param userId  Authenticated user id.
 * @param email   Optional email from JWT claims.
 * @returns       Array of latest BlendedSignals (one per pair, empty when none available).
 */
export async function getAllSignalsForUser(
  userId: string,
  email?: string,
): Promise<BlendedSignal[]> {
  await getOrCreateUserRecord(userId, email);

  // Fetch the latest signal for each pair in parallel.
  const results = await Promise.all(
    PAIRS.map(async (pair) => {
      const result = await client.send(
        new QueryCommand({
          TableName: SIGNALS_V2_TABLE,
          KeyConditionExpression: "#pair = :pair",
          ExpressionAttributeNames: { "#pair": "pair" },
          ExpressionAttributeValues: { ":pair": pair },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
      return result.Items?.[0] ? itemToBlendedSignal(result.Items[0]) : null;
    }),
  );

  return results.filter((s): s is BlendedSignal => s !== null);
}
