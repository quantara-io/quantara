/**
 * cache.ts — bin-and-hash cache helpers for LLM ratification (Phase 6a).
 *
 * The cache key is a SHA-256 over a stable set of context fields, each
 * binned at low resolution so minor fluctuations don't bust the cache.
 * TTL is 5 minutes per §7.6.
 *
 * Table: quantara-{env}-ratification-cache
 * Schema: PK=cacheKey (S), ttl (N)
 *
 * Design: §7.6 of docs/SIGNALS_AND_RISK.md
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { BlendedSignal } from "@quantara/shared";
import type { RatifyContext } from "./ratify.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CACHE_TABLE =
  process.env.TABLE_RATIFICATION_CACHE ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratification-cache`;

/** TTL in seconds for a cache entry (5 minutes). */
export const CACHE_TTL_SEC = 5 * 60;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** Bin a number to the nearest `size`-sized bucket (flooring). */
function bin(v: number, size: number): number {
  return Math.floor(v / size) * size;
}

/**
 * Derive a stable cache key from the ratification context.
 * Bins continuous values so minor fluctuations reuse the same cache entry.
 */
export function deriveCacheKey(ctx: RatifyContext): string {
  const sentiment4h = ctx.sentiment.windows["4h"];
  const parts = [
    ctx.pair,
    ctx.candidate.emittingTimeframe,
    ctx.candidate.type,
    bin(ctx.candidate.confidence, 0.02).toFixed(2),
    bin(sentiment4h.meanScore ?? 0, 0.05).toFixed(2),
    bin(sentiment4h.meanMagnitude ?? 0, 0.05).toFixed(2),
    String(sentiment4h.articleCount),
    String(bin(ctx.fearGreed.value, 1)),
  ];
  return crypto.createHash("sha256").update(parts.join(":")).digest("hex");
}

// ---------------------------------------------------------------------------
// DynamoDB I/O
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached ratified signal.
 * Returns null on cache miss or if the item has no `signal` attribute.
 */
export async function getCachedRatification(key: string): Promise<BlendedSignal | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: CACHE_TABLE,
      Key: { cacheKey: key },
      ProjectionExpression: "#sig",
      ExpressionAttributeNames: { "#sig": "signal" },
    }),
  );
  if (!result.Item) return null;
  return (result.Item.signal as BlendedSignal) ?? null;
}

/**
 * Write a ratified signal to the cache with a TTL.
 * @param ttlSec   TTL in seconds from now (default CACHE_TTL_SEC = 300).
 */
export async function putCachedRatification(
  key: string,
  signal: BlendedSignal,
  ttlSec: number = CACHE_TTL_SEC,
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + ttlSec;
  await ddb.send(
    new PutCommand({
      TableName: CACHE_TABLE,
      Item: { cacheKey: key, signal, ttl },
    }),
  );
}
