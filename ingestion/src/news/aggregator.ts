/**
 * aggregator.ts — sentiment aggregation for (pair, window) buckets.
 *
 * Reads from the `news-events-by-pair` table (scalar PK = pair), which avoids
 * the DynamoDB GSI limitation where array attributes can't be indexed.
 *
 * Writes the result to the `sentiment-aggregates` table for downstream consumers
 * (e.g. Phase 6a LLM ratification, API routes).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { queryNewsByPair } from "../lib/news-by-pair-store.js";
import type { FearGreedHistoryEntry } from "./fear-greed.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SENTIMENT_AGGREGATES_TABLE =
  process.env.TABLE_SENTIMENT_AGGREGATES ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}sentiment-aggregates`;

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

export type AggregationWindow = "4h" | "24h";

/** Window durations in milliseconds */
const WINDOW_MS: Record<AggregationWindow, number> = {
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export interface SentimentAggregate {
  pair: string;
  window: AggregationWindow;
  computedAt: string;
  articleCount: number;
  /** Mean sentiment score of non-duplicate articles in the window, null when no articles. */
  meanScore: number | null;
  /** Mean sentiment magnitude, null when no articles. */
  meanMagnitude: number | null;
  /** Fear & Greed 24h trend: positive = improving, negative = worsening, null when < 2 data points. */
  fearGreedTrend24h: number | null;
  /** Most recent Fear & Greed value, null when unavailable. */
  fearGreedLatest: number | null;
}

export interface RecomputeResult {
  /** The freshly-computed aggregate (just written to DDB). */
  aggregate: SentimentAggregate;
  /**
   * The previous aggregate that was in DDB before this write, or null if this
   * is the first-ever computation for this (pair, window).
   *
   * Exposed so callers can hand it to the sentiment-shock detector for a
   * prev/next comparison without a second DDB read.
   */
  previousAggregate: SentimentAggregate | null;
}

/**
 * Compute and persist a sentiment aggregate for the given pair and window.
 * Idempotent: overwrites any existing row for the same (pair, window).
 *
 * Returns both the new aggregate and the prior aggregate so callers can detect
 * sentiment shocks without an extra DDB read.
 *
 * Concurrency safety: read-then-write is gated by a conditional Put on the
 * previously-observed `computedAt` (or absence-of-row). If a concurrent
 * invocation slips a write between our Get and Put, our Put fails with
 * `ConditionalCheckFailedException` and we retry up to MAX_CONCURRENCY_RETRIES
 * times. This guarantees the returned `previousAggregate` actually corresponds
 * to the row that was overwritten — without it, two concurrent recomputes
 * could hand the sentiment-shock detector inconsistent prev→next deltas.
 */
const MAX_CONCURRENCY_RETRIES = 3;

export async function recomputeSentimentAggregate(
  pair: string,
  window: AggregationWindow,
): Promise<RecomputeResult> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt++) {
    try {
      return await recomputeSentimentAggregateOnce(pair, window);
    } catch (err) {
      // Only retry the optimistic-lock conflict; everything else propagates.
      const name = (err as { name?: string } | null)?.name;
      if (name !== "ConditionalCheckFailedException") {
        throw err;
      }
      lastError = err;
      console.warn(
        `[Aggregator] Concurrent write detected for ${pair}/${window}, retrying (attempt ${attempt + 1}/${MAX_CONCURRENCY_RETRIES})`,
      );
    }
  }

  throw new Error(
    `[Aggregator] Failed to recompute ${pair}/${window} after ${MAX_CONCURRENCY_RETRIES} concurrent-write retries: ${(lastError as Error)?.message ?? "unknown"}`,
  );
}

async function recomputeSentimentAggregateOnce(
  pair: string,
  window: AggregationWindow,
): Promise<RecomputeResult> {
  const now = Date.now();
  const sinceISO = new Date(now - WINDOW_MS[window]).toISOString();

  // Read the current (previous) aggregate before overwriting it, so callers
  // can do a prev/next shock comparison in a single pass.
  const prevResult = await client.send(
    new GetCommand({
      TableName: SENTIMENT_AGGREGATES_TABLE,
      Key: { pair, window },
    }),
  );
  const previousAggregate = (prevResult.Item as SentimentAggregate | undefined) ?? null;

  // Query all fan-out rows for this pair published within the window.
  const articles = await queryNewsByPair(pair, sinceISO);

  // Exclude duplicates from the mean calculation (they would double-count sentiment).
  const unique = articles.filter((a) => a.duplicateOf === null);

  const articleCount = unique.length;
  const meanScore =
    articleCount > 0 ? unique.reduce((sum, a) => sum + a.sentimentScore, 0) / articleCount : null;
  const meanMagnitude =
    articleCount > 0
      ? unique.reduce((sum, a) => sum + a.sentimentMagnitude, 0) / articleCount
      : null;

  // Read Fear & Greed history for trend computation (only relevant for 24h window).
  const { fearGreedTrend24h, fearGreedLatest } = await getFearGreedContext();

  const aggregate: SentimentAggregate = {
    pair,
    window,
    computedAt: new Date(now).toISOString(),
    articleCount,
    meanScore,
    meanMagnitude,
    fearGreedTrend24h: window === "24h" ? fearGreedTrend24h : null,
    fearGreedLatest,
  };

  // Optimistic concurrency: only overwrite if the row is still the one we
  // just read (or no row existed). On conflict the outer loop re-reads.
  const condition = previousAggregate
    ? {
        ConditionExpression: "computedAt = :prevComputedAt",
        ExpressionAttributeValues: { ":prevComputedAt": previousAggregate.computedAt },
      }
    : {
        ConditionExpression: "attribute_not_exists(computedAt)",
      };

  await client.send(
    new PutCommand({
      TableName: SENTIMENT_AGGREGATES_TABLE,
      Item: aggregate,
      ...condition,
    }),
  );

  console.log(
    `[Aggregator] ${pair}/${window}: articles=${articleCount}, meanScore=${meanScore?.toFixed(3) ?? "null"}`,
  );

  return { aggregate, previousAggregate };
}

interface FearGreedContext {
  fearGreedTrend24h: number | null;
  fearGreedLatest: number | null;
}

async function getFearGreedContext(): Promise<FearGreedContext> {
  try {
    const result = await client.send(
      new GetCommand({
        TableName: METADATA_TABLE,
        Key: { metaKey: "market:fear-greed" },
        ProjectionExpression: "#v, #h",
        ExpressionAttributeNames: { "#v": "value", "#h": "history" },
      }),
    );

    if (!result.Item) {
      return { fearGreedTrend24h: null, fearGreedLatest: null };
    }

    const latest = result.Item.value as number | undefined;
    const history = (result.Item.history as FearGreedHistoryEntry[] | undefined) ?? [];

    return {
      fearGreedLatest: latest ?? null,
      fearGreedTrend24h: computeTrend24h(history),
    };
  } catch {
    return { fearGreedTrend24h: null, fearGreedLatest: null };
  }
}

/**
 * Compute a simple 24h trend from the Fear & Greed history array.
 *
 * Returns the difference between the most-recent value and the value 24 hours
 * prior (positive = improving sentiment, negative = worsening). Returns null
 * when fewer than 2 data points are available.
 *
 * The history array is ordered oldest-first (oldest at index 0) by the
 * list_append write pattern in fear-greed.ts.
 */
export function computeTrend24h(history: FearGreedHistoryEntry[]): number | null {
  if (history.length < 2) return null;

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  // Most recent entry
  const latest = history[history.length - 1];

  // Find the entry closest to 24h ago (oldest entry that is still within the window,
  // or the oldest overall if all entries are within 24h).
  let baseline: FearGreedHistoryEntry | null = null;
  for (const entry of history) {
    const entryMs = new Date(entry.timestamp).getTime();
    if (entryMs <= cutoff24h) {
      baseline = entry; // keep updating — we want the most-recent entry that's >=24h old
    }
  }

  // Fall back to the oldest available entry if nothing is 24h old yet.
  if (!baseline) {
    if (history.length < 2) return null;
    baseline = history[0];
  }

  return latest.value - baseline.value;
}
