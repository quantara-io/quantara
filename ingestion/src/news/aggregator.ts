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

/**
 * Compute and persist a sentiment aggregate for the given pair and window.
 * Idempotent: overwrites any existing row for the same (pair, window).
 */
export async function recomputeSentimentAggregate(
  pair: string,
  window: AggregationWindow,
): Promise<SentimentAggregate> {
  const now = Date.now();
  const sinceISO = new Date(now - WINDOW_MS[window]).toISOString();

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

  await client.send(
    new PutCommand({
      TableName: SENTIMENT_AGGREGATES_TABLE,
      Item: aggregate,
    }),
  );

  console.log(
    `[Aggregator] ${pair}/${window}: articles=${articleCount}, meanScore=${meanScore?.toFixed(3) ?? "null"}`,
  );

  return aggregate;
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
