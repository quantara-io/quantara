import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BlendedSignal, Timeframe } from "@quantara/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

/** 90-day TTL for signals */
const TTL_SECONDS = 86400 * 90;

/**
 * v6 schema: signals-v2 PK = `pair`, SK = `tf#closeTime` (deterministic).
 * Concurrent handlers on the same close-boundary write the same SK, so
 * a conditional Put with `attribute_not_exists(pair)` is the dedup mechanism.
 */
const BLEND_TIMEFRAMES: readonly Timeframe[] = ["15m", "1h", "4h", "1d"];

function buildSignalSk(timeframe: Timeframe, closeTimeMs: number): string {
  return `${timeframe}#${closeTimeMs}`;
}

/**
 * Generate a time-sortable signal ID kept for back-compat in returned metadata.
 * The SK no longer embeds it; signalId is purely informational on read.
 */
function makeSignalId(nowMs: number): string {
  const tsPart = nowMs.toString(16).padStart(14, "0");
  return `${tsPart}-${randomUUID()}`;
}

export interface SignalRecord {
  signalId: string;
  emittedAt: string;
  /** v6: deterministic SK = `tf#closeTime` so callers can address the row. */
  sk: string;
}

/**
 * Persist a BlendedSignal to the signals-v2 table.
 *
 * v6: writes use deterministic PK=pair, SK=`tf#closeTime`. Two concurrent
 * writers for the same (pair, tf, closeTime) target the same DDB item;
 * the conditional Put (`attribute_not_exists(pair)`) guarantees only one
 * wins. Losers receive ConditionalCheckFailedException, which is treated
 * as an idempotent skip — the SignalRecord still reflects the slot's
 * deterministic keys so callers can address the winning row.
 *
 * Returns the generated signalId, emittedAt, and the SK so callers can
 * later reference this row (e.g. for invalidation).
 */
export async function putSignal(signal: BlendedSignal): Promise<SignalRecord> {
  const emittedAt = new Date(signal.asOf).toISOString();
  const signalId = makeSignalId(signal.asOf);
  const sk = buildSignalSk(signal.emittingTimeframe, signal.asOf);
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  try {
    await client.send(
      new PutCommand({
        TableName: SIGNALS_V2_TABLE,
        Item: {
          pair: signal.pair,
          sk,
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
        // v6 dedup guarantee: only one writer wins per (pair, sk).
        ConditionExpression: "attribute_not_exists(pair)",
      }),
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === "ConditionalCheckFailedException" ||
        (err as { __type?: string }).__type ===
          "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException")
    ) {
      // Another concurrent writer (or a retry) already wrote this slot — idempotent.
      return { signalId, emittedAt, sk };
    }
    throw err;
  }

  return { signalId, emittedAt, sk };
}

// Exported for indicator-handler so both writers produce identically-shaped
// signals-v2 rows (admin.service.getSignals and outcomes tooling expect
// `signalId` to be present on every row).
export { makeSignalId };

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
 *
 * v6: signals-v2 SK is `tf#closeTime`, so reverse-scan returns
 * the alphabetically-last TF, not chronologically-newest. Issue one Query per
 * blended TF and merge by `asOf` descending.
 */
export async function getRecentSignals(
  pair: string,
  limit = 10,
): Promise<Array<BlendedSignal & SignalRecord>> {
  const perTfResults = await Promise.all(
    BLEND_TIMEFRAMES.map(async (tf) => {
      const result = await client.send(
        new QueryCommand({
          TableName: SIGNALS_V2_TABLE,
          KeyConditionExpression: "#pair = :pair AND begins_with(sk, :tfPrefix)",
          ExpressionAttributeNames: { "#pair": "pair" },
          ExpressionAttributeValues: { ":pair": pair, ":tfPrefix": `${tf}#` },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return result?.Items ?? [];
    }),
  );

  const merged = perTfResults.flat();
  merged.sort((a, b) => Number(b["asOf"] ?? 0) - Number(a["asOf"] ?? 0));

  return merged.slice(0, limit).map((item) => ({
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
    sk:
      (item.sk as string) ??
      buildSignalSk(item.emittingTimeframe as Timeframe, item.asOf as number),
  }));
}

// ---------------------------------------------------------------------------
// Phase 6b — Breaking-news invalidation helpers
// ---------------------------------------------------------------------------

export interface ActiveSignalRef {
  /** DDB PK */
  pair: string;
  /** v6 DDB SK = `tf#closeTime`. */
  sk: string;
  signalId: string;
  emittedAt: string;
  /** DDB TTL epoch-seconds — used as a proxy for expiresAt. */
  ttl: number;
}

/**
 * Find all active, non-invalidated signals for a given pair.
 *
 * "Active" = DDB TTL has not expired (ttl > now in epoch seconds).
 *
 * v6: signals-v2 SK is `tf#closeTime` — query each blended TF separately
 * and merge. Per-pair active signal count is bounded by # of live close
 * boundaries (handful at any moment), so the per-TF Limit=100 is generous.
 */
export async function findActiveSignalsForPair(pair: string): Promise<ActiveSignalRef[]> {
  const nowSec = Math.floor(Date.now() / 1000);

  const perTf = await Promise.all(
    BLEND_TIMEFRAMES.map(async (tf) => {
      const result = await client.send(
        new QueryCommand({
          TableName: SIGNALS_V2_TABLE,
          KeyConditionExpression: "#pair = :pair AND begins_with(#sk, :tfPrefix)",
          ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk", "#ttl": "ttl" },
          ExpressionAttributeValues: { ":pair": pair, ":tfPrefix": `${tf}#` },
          // Project only the key fields + ttl + invalidatedAt for efficiency.
          ProjectionExpression: "#pair, #sk, signalId, emittedAt, #ttl, invalidatedAt",
          ScanIndexForward: false,
          Limit: 100,
        }),
      );
      return result?.Items ?? [];
    }),
  );

  return perTf
    .flat()
    .filter((item) => {
      const ttl = item.ttl as number | undefined;
      const invalidatedAt = item.invalidatedAt as string | undefined | null;
      // Keep only live, not-yet-invalidated signals
      return (
        ttl !== undefined && ttl > nowSec && (invalidatedAt === undefined || invalidatedAt === null)
      );
    })
    .map((item) => ({
      pair: item.pair as string,
      sk: item.sk as string,
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
 * @param pair    DDB partition key
 * @param sk      v6 DDB sort key = `tf#closeTime`
 * @param reason  User-facing reason string, e.g. "Breaking news: Coinbase delists ETH"
 * @param nowIso  ISO-8601 timestamp to stamp (injectable for tests)
 */
export async function markSignalInvalidated(
  pair: string,
  sk: string,
  reason: string,
  nowIso = new Date().toISOString(),
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: SIGNALS_V2_TABLE,
        Key: { pair, sk },
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
        (err as { __type?: string }).__type ===
          "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException")
    ) {
      return; // already invalidated; idempotent no-op
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Phase B1 — ratification stage-2 UPDATE
// ---------------------------------------------------------------------------

export type RatificationStatusFinal = "ratified" | "downgraded";

export interface RatificationVerdictRecord {
  type: "buy" | "sell" | "hold";
  confidence: number;
  reasoning: string;
}

export interface UpdateSignalRatificationParams {
  /** DDB partition key */
  pair: string;
  /** v6 DDB sort key = `tf#closeTime` */
  sk: string;
  /** Final status after LLM verdict */
  ratificationStatus: RatificationStatusFinal;
  /** The LLM verdict (or algo as fallback on graceful error) */
  ratificationVerdict: RatificationVerdictRecord;
  /**
   * Original algo signal fields — populated when downgraded so the UI
   * can show what changed. null when status is "ratified".
   */
  algoVerdict: RatificationVerdictRecord | null;
}

/**
 * Stage-2 UPDATE: write ratification verdict fields onto an existing
 * signals-v2 row. Also overwrites the top-level type/confidence fields
 * if the signal was downgraded.
 *
 * Idempotent: skips (silently) if ratificationStatus is already final
 * (i.e., the row was concurrently updated — e.g., a retry race).
 */
export async function updateSignalRatification(
  params: UpdateSignalRatificationParams,
): Promise<void> {
  const { pair, sk, ratificationStatus, ratificationVerdict, algoVerdict } = params;

  try {
    await client.send(
      new UpdateCommand({
        TableName: SIGNALS_V2_TABLE,
        Key: { pair, sk },
        // Update ratification fields. Also overwrite top-level type/confidence/reasoning
        // so reads see the canonical final values without needing to chase ratificationVerdict.
        UpdateExpression:
          "SET ratificationStatus = :status, ratificationVerdict = :verdict, " +
          "algoVerdict = :algoVerdict, #signalType = :type, " +
          "confidence = :confidence",
        ExpressionAttributeNames: {
          "#signalType": "type", // "type" is a reserved word in DDB expressions
        },
        ExpressionAttributeValues: {
          ":status": ratificationStatus,
          ":verdict": ratificationVerdict,
          ":algoVerdict": algoVerdict,
          ":type": ratificationVerdict.type,
          ":confidence": ratificationVerdict.confidence,
          // Guard: only update if the row is still in pending state (prevents double-write).
          ":pending": "pending",
        },
        ConditionExpression:
          "attribute_exists(#signalType) AND ratificationStatus = :pending",
      }),
    );
  } catch (err: unknown) {
    // ConditionalCheckFailedException: row doesn't exist OR already in final state — idempotent.
    if (
      err instanceof Error &&
      (err.name === "ConditionalCheckFailedException" ||
        (err as { __type?: string }).__type ===
          "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException")
    ) {
      return;
    }
    throw err;
  }
}
