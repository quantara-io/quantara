/**
 * gating.ts — cost gating logic for LLM ratification (Phase 6a).
 *
 * Returns { shouldInvoke: boolean; reason: string } so callers can log the
 * gate decision without coupling to the Anthropic client.
 *
 * Rules (§7.5):
 *   1. Confidence floor: candidate.confidence must be >= 0.6
 *   2. Per-(pair, TF) 5-minute rate limit
 *   3. Per-pair daily cap (100 calls/day); above cap, ALL three conditions must fire
 *   4. At least one trigger condition: recentNews | volatilityFlag | fngShift
 *
 * The three trigger helpers (recentNewsExists, volatilityFlagSet, fngShifted) are
 * exported so they can be tested independently.
 *
 * Design: §7.5 of docs/SIGNALS_AND_RISK.md
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RatifyContext } from "./ratify.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const RATIFICATIONS_TABLE =
  process.env.TABLE_RATIFICATIONS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratifications`;

/** Confidence floor: calls below this are never gated through. */
export const CONFIDENCE_FLOOR = 0.6;

/** Per-(pair, TF) rate-limit window in ms (5 minutes). */
export const RATE_LIMIT_MS = 5 * 60 * 1000;

/** Per-pair daily cap (before all-conditions override). */
export const DAILY_CAP = 100;

/** F&G shift threshold: absolute change >= this triggers. */
export const FNG_SHIFT_THRESHOLD = 15;

// ---------------------------------------------------------------------------
// Trigger condition helpers
// ---------------------------------------------------------------------------

/** True if there are recent news articles (any articleCount > 0). */
export function recentNewsExists(ctx: RatifyContext): boolean {
  return (
    ctx.sentiment.windows["4h"].articleCount > 0 || ctx.sentiment.windows["24h"].articleCount > 0
  );
}

/** True if the candidate signal has volatilityFlag set. */
export function volatilityFlagSet(ctx: RatifyContext): boolean {
  return ctx.candidate.volatilityFlag;
}

/**
 * True if the Fear & Greed index shifted by >= FNG_SHIFT_THRESHOLD points in 24h.
 * trend24h is the absolute 24h delta; we check magnitude.
 */
export function fngShifted(ctx: RatifyContext): boolean {
  return Math.abs(ctx.fearGreed.trend24h) >= FNG_SHIFT_THRESHOLD;
}

/** Build a human-readable reason string from whichever conditions fired. */
export function triggerReason(ctx: RatifyContext): string {
  const parts: string[] = [];
  if (recentNewsExists(ctx)) parts.push("news");
  if (volatilityFlagSet(ctx)) parts.push("vol");
  if (fngShifted(ctx)) parts.push("fng-shift");
  return parts.join("+") || "unknown";
}

// ---------------------------------------------------------------------------
// DynamoDB helpers for rate limiting
// ---------------------------------------------------------------------------

/** ISO string of the start of the current UTC day. */
function todayISO(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/**
 * Returns the invokedAt of the last ratification for (pair, emittingTimeframe),
 * or null if none exists.
 */
export async function getLastRatificationFor(
  pair: string,
  timeframe: string,
): Promise<string | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: RATIFICATIONS_TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :tfPrefix)",
      FilterExpression: "#timeframe = :timeframe",
      ExpressionAttributeNames: {
        "#pk": "pair",
        "#sk": "invokedAtRecordId",
        "#timeframe": "timeframe",
      },
      ExpressionAttributeValues: {
        ":pk": pair,
        ":tfPrefix": new Date(Date.now() - RATE_LIMIT_MS).toISOString().substring(0, 19),
        ":timeframe": timeframe,
      },
      ScanIndexForward: false,
      Limit: 1,
      ProjectionExpression: "invokedAt",
    }),
  );
  if (!result.Items || result.Items.length === 0) return null;
  return (result.Items[0].invokedAt as string) ?? null;
}

/**
 * Returns the count of ratifications for the given pair today.
 * Uses a Query with a begins_with on the sort key to scope to today.
 */
export async function countRatificationsToday(pair: string): Promise<number> {
  const prefix = todayISO().substring(0, 10); // "YYYY-MM-DD"
  const result = await ddb.send(
    new QueryCommand({
      TableName: RATIFICATIONS_TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      ExpressionAttributeNames: { "#pk": "pair", "#sk": "invokedAtRecordId" },
      ExpressionAttributeValues: { ":pk": pair, ":prefix": prefix },
      Select: "COUNT",
    }),
  );
  return result.Count ?? 0;
}

// ---------------------------------------------------------------------------
// Main gate function
// ---------------------------------------------------------------------------

export async function shouldInvokeRatification(
  ctx: RatifyContext,
): Promise<{ shouldInvoke: boolean; reason: string }> {
  // 1. Confidence floor
  if (ctx.candidate.confidence < CONFIDENCE_FLOOR) {
    return { shouldInvoke: false, reason: "candidate confidence < 0.6" };
  }

  // 2. Per-(pair, TF) rate limit (5 min)
  const lastInvocation = await getLastRatificationFor(ctx.pair, ctx.candidate.emittingTimeframe);
  if (lastInvocation && Date.now() - Date.parse(lastInvocation) < RATE_LIMIT_MS) {
    return { shouldInvoke: false, reason: "per-(pair, TF) rate limit" };
  }

  // 3. Per-pair daily cap (100/pair/day)
  const todayCount = await countRatificationsToday(ctx.pair);
  if (todayCount >= DAILY_CAP) {
    // Above cap: only invoke if ALL three trigger conditions fire (rare extreme cases)
    const allConditions = recentNewsExists(ctx) && volatilityFlagSet(ctx) && fngShifted(ctx);
    if (!allConditions) {
      return {
        shouldInvoke: false,
        reason: "per-pair daily cap exceeded; not all gating conditions",
      };
    }
  }

  // 4. At least one trigger condition
  if (recentNewsExists(ctx) || volatilityFlagSet(ctx) || fngShifted(ctx)) {
    return { shouldInvoke: true, reason: triggerReason(ctx) };
  }

  return { shouldInvoke: false, reason: "no trigger condition" };
}
