import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BlendedSignal } from "@quantara/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

/** 90-day TTL for signals */
const TTL_SECONDS = 86400 * 90;

/**
 * Generate a time-sortable signal ID without a new npm dependency.
 * Format: "<unix-ms-hex-padded>-<uuid>" ensures lexicographic order = emission order.
 * e.g. "000001947a1b2c3d-550e8400-e29b-41d4-a716-446655440000"
 */
function makeSignalId(nowMs: number): string {
  const tsPart = nowMs.toString(16).padStart(14, "0");
  return `${tsPart}-${randomUUID()}`;
}

/**
 * Build the sort key that encodes both timestamp and ID so DDB scans descend
 * by emission time when ScanIndexForward=false.
 * Format: "<emittedAt>#<signalId>"
 */
function buildSortKey(emittedAt: string, signalId: string): string {
  return `${emittedAt}#${signalId}`;
}

export interface SignalRecord {
  signalId: string;
  emittedAt: string;
}

/**
 * Persist a BlendedSignal to the signals-v2 table.
 * Returns the generated signalId and emittedAt ISO8601 string.
 * Does not mutate the input signal.
 */
export async function putSignal(signal: BlendedSignal): Promise<SignalRecord> {
  const emittedAt = new Date(signal.asOf).toISOString();
  const signalId = makeSignalId(signal.asOf);
  const emittedAtSignalId = buildSortKey(emittedAt, signalId);
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  await client.send(
    new PutCommand({
      TableName: SIGNALS_V2_TABLE,
      Item: {
        pair: signal.pair,
        emittedAtSignalId,
        signalId,
        emittedAt,
        type: signal.type,
        confidence: signal.confidence,
        volatilityFlag: signal.volatilityFlag,
        gateReason: signal.gateReason,
        rulesFired: signal.rulesFired,
        perTimeframe: signal.perTimeframe,
        weightsUsed: signal.weightsUsed,
        asOf: signal.asOf,
        emittingTimeframe: signal.emittingTimeframe,
        // risk: null is persisted explicitly so reads can distinguish "no risk" from "old record"
        risk: signal.risk ?? null,
        // Phase 6b: new signals always start with no invalidation; explicit null
        // lets the read path distinguish "freshly emitted" from "old record without the field".
        invalidatedAt: signal.invalidatedAt ?? null,
        invalidationReason: signal.invalidationReason ?? null,
        ttl,
      },
    }),
  );

  return { signalId, emittedAt };
}

/**
 * Retrieve the most recently emitted signal for a pair.
 * Returns null if no signal exists.
 */
export async function getLatestSignal(
  pair: string,
): Promise<(BlendedSignal & SignalRecord) | null> {
  const results = await getRecentSignals(pair, 1);
  return results[0] ?? null;
}

/**
 * Retrieve the N most recently emitted signals for a pair, newest first.
 */
export async function getRecentSignals(
  pair: string,
  limit = 10,
): Promise<Array<BlendedSignal & SignalRecord>> {
  const result = await client.send(
    new QueryCommand({
      TableName: SIGNALS_V2_TABLE,
      KeyConditionExpression: "#pair = :pair",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: { ":pair": pair },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  return (result.Items ?? []).map((item) => ({
    pair: item.pair as string,
    type: item.type as BlendedSignal["type"],
    confidence: item.confidence as number,
    volatilityFlag: item.volatilityFlag as boolean,
    gateReason: item.gateReason as BlendedSignal["gateReason"],
    rulesFired: item.rulesFired as string[],
    perTimeframe: item.perTimeframe as BlendedSignal["perTimeframe"],
    weightsUsed: item.weightsUsed as BlendedSignal["weightsUsed"],
    asOf: item.asOf as number,
    emittingTimeframe: item.emittingTimeframe as BlendedSignal["emittingTimeframe"],
    risk: (item.risk ?? null) as BlendedSignal["risk"],
    invalidatedAt: (item.invalidatedAt ?? null) as string | null,
    invalidationReason: (item.invalidationReason ?? null) as string | null,
    signalId: item.signalId as string,
    emittedAt: item.emittedAt as string,
  }));
}

// ---------------------------------------------------------------------------
// Phase 6b — Breaking-news invalidation helpers
// ---------------------------------------------------------------------------

export interface ActiveSignalRef {
  /** DDB PK */
  pair: string;
  /** DDB SK */
  emittedAtSignalId: string;
  signalId: string;
  emittedAt: string;
  /** DDB TTL epoch-seconds — used as a proxy for expiresAt. */
  ttl: number;
}

/**
 * Find all active, non-invalidated signals for a given pair.
 *
 * "Active" = DDB TTL has not expired (ttl > now in epoch seconds).
 * Queries the most recent 100 signals and filters client-side; in practice
 * a pair will never accumulate more than a handful of live signals.
 */
export async function findActiveSignalsForPair(pair: string): Promise<ActiveSignalRef[]> {
  const nowSec = Math.floor(Date.now() / 1000);

  const result = await client.send(
    new QueryCommand({
      TableName: SIGNALS_V2_TABLE,
      KeyConditionExpression: "#pair = :pair",
      ExpressionAttributeNames: { "#pair": "pair", "#ttl": "ttl" },
      ExpressionAttributeValues: { ":pair": pair },
      // Project only the key fields + ttl + invalidatedAt for efficiency
      ProjectionExpression:
        "#pair, emittedAtSignalId, signalId, emittedAt, #ttl, invalidatedAt",
      ScanIndexForward: false,
      Limit: 100,
    }),
  );

  return (result.Items ?? [])
    .filter((item) => {
      const ttl = item.ttl as number | undefined;
      const invalidatedAt = item.invalidatedAt as string | undefined | null;
      // Keep only live, not-yet-invalidated signals
      return ttl !== undefined && ttl > nowSec && (invalidatedAt === undefined || invalidatedAt === null);
    })
    .map((item) => ({
      pair: item.pair as string,
      emittedAtSignalId: item.emittedAtSignalId as string,
      signalId: item.signalId as string,
      emittedAt: item.emittedAt as string,
      ttl: item.ttl as number,
    }));
}

/**
 * Mark a single signal as invalidated by a breaking news event.
 *
 * Idempotent: if `invalidatedAt` is already set on the record the update is
 * skipped via a condition expression so the original stamp is preserved.
 *
 * @param pair             DDB partition key
 * @param emittedAtSignalId DDB sort key
 * @param reason           User-facing reason string, e.g. "Breaking news: Coinbase delists ETH"
 * @param nowIso           ISO-8601 timestamp to stamp (injectable for tests)
 */
export async function markSignalInvalidated(
  pair: string,
  emittedAtSignalId: string,
  reason: string,
  nowIso = new Date().toISOString(),
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: SIGNALS_V2_TABLE,
        Key: { pair, emittedAtSignalId },
        UpdateExpression: "SET invalidatedAt = :ts, invalidationReason = :reason",
        // Idempotency guard: only write if the attribute does not yet exist
        ConditionExpression: "attribute_not_exists(invalidatedAt)",
        ExpressionAttributeValues: {
          ":ts": nowIso,
          ":reason": reason,
        },
      }),
    );
  } catch (err: unknown) {
    // ConditionalCheckFailedException means the signal was already invalidated — that's fine.
    if (
      err instanceof Error &&
      (err.name === "ConditionalCheckFailedException" ||
        (err as { __type?: string }).__type === "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException")
    ) {
      return; // already invalidated; idempotent no-op
    }
    throw err;
  }
}
