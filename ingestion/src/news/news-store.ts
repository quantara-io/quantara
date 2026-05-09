import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import pino from "pino";

import type { NewsRecord } from "./types.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "news-store", env: process.env.ENVIRONMENT ?? "dev" },
});

const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;

const BATCHWRITE_MAX_RETRIES = 3;
const BATCHWRITE_RETRY_BASE_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a BatchWrite for the given records and retry any UnprocessedItems with
 * exponential backoff. Returns the records that were successfully persisted.
 * Records still unprocessed after BATCHWRITE_MAX_RETRIES attempts are dropped
 * from the return value so callers don't fan-out enrichment for rows that
 * never landed in DynamoDB.
 */
async function batchWriteWithRetry(records: NewsRecord[]): Promise<NewsRecord[]> {
  let pendingRecords = records;
  let attempt = 0;

  while (pendingRecords.length > 0 && attempt <= BATCHWRITE_MAX_RETRIES) {
    if (attempt > 0) {
      const backoff = BATCHWRITE_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      logger.warn(
        {
          attempt,
          unprocessed: pendingRecords.length,
          backoffMs: backoff,
        },
        "[NewsStore] Retrying UnprocessedItems",
      );
      await sleep(backoff);
    }

    const result = await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [NEWS_TABLE]: pendingRecords.map((r) => ({ PutRequest: { Item: r } })),
        },
      }),
    );

    const unprocessed = result.UnprocessedItems?.[NEWS_TABLE];
    if (!unprocessed || unprocessed.length === 0) {
      return records;
    }

    // Map UnprocessedItems back to NewsRecord by newsId+publishedAt so the
    // next attempt only retries the rows that didn't land.
    const stillPending: NewsRecord[] = [];
    const unprocessedKeys = new Set(
      unprocessed
        .map((req) => req.PutRequest?.Item)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => `${item.newsId}|${item.publishedAt}`),
    );
    for (const r of pendingRecords) {
      if (unprocessedKeys.has(`${r.newsId}|${r.publishedAt}`)) {
        stillPending.push(r);
      }
    }
    pendingRecords = stillPending;
    attempt += 1;
  }

  if (pendingRecords.length > 0) {
    logger.error(
      {
        droppedCount: pendingRecords.length,
        droppedNewsIds: pendingRecords.map((r) => r.newsId),
      },
      "[NewsStore] BatchWrite still has UnprocessedItems after max retries; dropping these records from the returned set",
    );
    const droppedKeys = new Set(pendingRecords.map((r) => `${r.newsId}|${r.publishedAt}`));
    return records.filter((r) => !droppedKeys.has(`${r.newsId}|${r.publishedAt}`));
  }

  return records;
}

/**
 * Store news records, deduplicating against existing rows.
 *
 * Returns the newly-written records (not just a count) so callers can fan-out
 * only the records that actually landed in the table. If BatchWrite returns
 * UnprocessedItems that exhaust retry attempts, those records are excluded
 * from the returned set.
 *
 * Dedup key: (newsId, publishedAt) — the DynamoDB primary key.  A GetItem
 * check is issued per record before batching writes.  Each check is logged at
 * DEBUG level (gated by LOG_LEVEL) so future regressions are diagnosable
 * without flooding production logs by default.
 */
export async function storeNewsRecords(records: NewsRecord[]): Promise<NewsRecord[]> {
  if (records.length === 0) return [];

  // Deduplicate: skip records that already exist in the table.
  const newRecords: NewsRecord[] = [];
  for (const record of records) {
    const existing = await client.send(
      new GetCommand({
        TableName: NEWS_TABLE,
        Key: { newsId: record.newsId, publishedAt: record.publishedAt },
        ProjectionExpression: "newsId",
      }),
    );
    if (existing.Item) {
      logger.debug(
        { newsId: record.newsId, publishedAt: record.publishedAt, source: record.source },
        "[NewsStore] duplicate skip",
      );
    } else {
      logger.debug(
        {
          newsId: record.newsId,
          publishedAt: record.publishedAt,
          source: record.source,
          title: record.title.slice(0, 60),
        },
        "[NewsStore] new record",
      );
      newRecords.push(record);
    }
  }

  if (newRecords.length === 0) {
    logger.info(
      { newCount: 0, duplicateCount: records.length, table: NEWS_TABLE },
      "[NewsStore] All records were duplicates",
    );
    return [];
  }

  const persisted: NewsRecord[] = [];
  for (let i = 0; i < newRecords.length; i += 25) {
    const batch = newRecords.slice(i, i + 25);
    const written = await batchWriteWithRetry(batch);
    persisted.push(...written);
  }

  logger.info(
    {
      newCount: persisted.length,
      duplicateCount: records.length - newRecords.length,
      droppedCount: newRecords.length - persisted.length,
      table: NEWS_TABLE,
    },
    "[NewsStore] Wrote news records",
  );
  return persisted;
}
