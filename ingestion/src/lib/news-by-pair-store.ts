/**
 * news-by-pair-store.ts
 *
 * Write/read helpers for the `news-events-by-pair` table (Option A — separate table).
 *
 * Schema:
 *   PK: pair (S)                        e.g. "BTC"
 *   SK: publishedAt#articleId (S)        ensures uniqueness and time-ordered scans
 *
 * Attributes stored per row: articleId, pair, title, sentiment, source,
 * publishedAt, url, duplicateOf (nullable), ttl (30-day).
 *
 * This table is written by the enrichment Lambda (one row per mentionedPairs[i])
 * and queried by the sentiment aggregator to count articles per (pair, window).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  QueryCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";

/** A single write-request entry as expected by `BatchWriteCommand` (lib-dynamodb). */
type DocumentWriteRequest = {
  PutRequest?: { Item: Record<string, NativeAttributeValue> };
  DeleteRequest?: { Key: Record<string, NativeAttributeValue> };
};

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NEWS_BY_PAIR_TABLE =
  process.env.TABLE_NEWS_EVENTS_BY_PAIR ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events-by-pair`;

/** 30-day TTL — matches the issue spec */
const TTL_SECONDS = 86400 * 30;

/**
 * Retry a single batch of ≤25 write requests, handling DynamoDB's
 * `UnprocessedItems` response (throttling / capacity backoff).
 *
 * Up to 5 attempts with exponential backoff: 100 → 200 → 400 → 800 → 1600 ms.
 * Throws if items remain unprocessed after all attempts.
 */
async function batchWriteWithRetry(items: DocumentWriteRequest[], table: string): Promise<void> {
  let unprocessed = items;
  let backoff = 100; // ms
  for (let attempt = 0; attempt < 5 && unprocessed.length > 0; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoff));
    const res = await client.send(
      new BatchWriteCommand({ RequestItems: { [table]: unprocessed } }),
    );
    unprocessed = (res.UnprocessedItems?.[table] as DocumentWriteRequest[] | undefined) ?? [];
    backoff *= 2;
  }
  if (unprocessed.length > 0) {
    throw new Error(
      `BatchWrite failed: ${unprocessed.length} items remain unprocessed after 5 attempts`,
    );
  }
}

export interface NewsByPairRecord {
  pair: string;
  articleId: string;
  publishedAt: string;
  title: string;
  /** Normalised sentiment score from Phase 5a: -1 (bearish) to +1 (bullish). */
  sentimentScore: number;
  sentimentMagnitude: number;
  source: string;
  url: string;
  /** Non-null when this article was flagged as a duplicate of another. */
  duplicateOf: string | null;
}

/**
 * Write one fan-out row per pair in a single BatchWrite call (batching at 25 if needed).
 * Idempotent — the (pair, publishedAt#articleId) primary key dedupes on re-run.
 */
export async function writePairFanout(records: NewsByPairRecord[]): Promise<void> {
  if (records.length === 0) return;

  const now = Math.floor(Date.now() / 1000);

  const batches: NewsByPairRecord[][] = [];
  for (let i = 0; i < records.length; i += 25) {
    batches.push(records.slice(i, i + 25));
  }

  for (const batch of batches) {
    const writeRequests: DocumentWriteRequest[] = batch.map((r) => ({
      PutRequest: {
        Item: {
          pair: r.pair,
          sk: `${r.publishedAt}#${r.articleId}`,
          articleId: r.articleId,
          publishedAt: r.publishedAt,
          title: r.title,
          sentimentScore: r.sentimentScore,
          sentimentMagnitude: r.sentimentMagnitude,
          source: r.source,
          url: r.url,
          duplicateOf: r.duplicateOf ?? null,
          ttl: now + TTL_SECONDS,
        },
      },
    }));
    await batchWriteWithRetry(writeRequests, NEWS_BY_PAIR_TABLE);
  }
}

export interface PairNewsQueryResult {
  articleId: string;
  publishedAt: string;
  sentimentScore: number;
  sentimentMagnitude: number;
  duplicateOf: string | null;
}

/**
 * Query all non-duplicate articles for a given pair published after `sinceISO`.
 * Used by the sentiment aggregator to compute rolling-window averages.
 *
 * DynamoDB range key condition: SK >= sinceISO (ISO strings sort lexicographically).
 */
export async function queryNewsByPair(
  pair: string,
  sinceISO: string,
): Promise<PairNewsQueryResult[]> {
  const items: PairNewsQueryResult[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: NEWS_BY_PAIR_TABLE,
        KeyConditionExpression: "#pair = :pair AND #sk >= :since",
        ExpressionAttributeNames: {
          "#pair": "pair",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":pair": pair,
          ":since": sinceISO,
        },
        ProjectionExpression:
          "articleId, publishedAt, sentimentScore, sentimentMagnitude, duplicateOf",
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      items.push({
        articleId: item.articleId as string,
        publishedAt: item.publishedAt as string,
        sentimentScore: item.sentimentScore as number,
        sentimentMagnitude: item.sentimentMagnitude as number,
        duplicateOf: (item.duplicateOf as string | null) ?? null,
      });
    }

    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey !== undefined);

  return items;
}
