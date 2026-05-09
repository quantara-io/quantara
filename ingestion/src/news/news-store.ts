import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import pino from "pino";

import type { NewsRecord } from "./types.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "news-store", env: process.env.ENVIRONMENT ?? "dev" },
  // ISO timestamps so CloudWatch renders human-readable times — matches
  // ws-connect-handler / ws-disconnect-handler / signals-fanout.
  timestamp: pino.stdTimeFunctions.isoTime,
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
 * Dedup key: newsId only.  A Query on the partition key is issued per record
 * before batching writes — this detects any existing row with the same newsId
 * regardless of its publishedAt sort key value, so an undated article polled
 * across a publishedAt bucket boundary does not produce a duplicate row.
 * Each check is logged at DEBUG level (gated by LOG_LEVEL) so future
 * regressions are diagnosable without flooding production logs by default.
 */
export async function storeNewsRecords(records: NewsRecord[]): Promise<NewsRecord[]> {
  if (records.length === 0) return [];

  // Deduplicate: skip records whose newsId already exists in the table OR
  // already appeared earlier in this same batch.
  //
  // Query on the partition key (newsId) with Limit 1 so we detect any row
  // for this article regardless of publishedAt — a GetItem on (newsId,
  // publishedAt) would miss rows whose publishedAt changed between polls.
  //
  // The `seenInBatch` Set guards against the same article appearing twice
  // in a single poll: without it, both Query calls would return Count: 0
  // (DDB doesn't see uncommitted writes from this call) and BatchWrite
  // would either persist two rows or reject the batch on duplicate keys.
  const newRecords: NewsRecord[] = [];
  const seenInBatch = new Set<string>();
  for (const record of records) {
    if (seenInBatch.has(record.newsId)) {
      logger.debug(
        { newsId: record.newsId, publishedAt: record.publishedAt, source: record.source },
        "[NewsStore] duplicate skip (within-batch)",
      );
      continue;
    }
    const existing = await client.send(
      new QueryCommand({
        TableName: NEWS_TABLE,
        KeyConditionExpression: "newsId = :id",
        ExpressionAttributeValues: { ":id": record.newsId },
        ProjectionExpression: "newsId",
        Limit: 1,
        // Strongly-consistent read: a just-written item from a rapid
        // re-poll must be visible immediately, otherwise a duplicate
        // (different `publishedAt`, same `newsId`) can slip through.
        ConsistentRead: true,
      }),
    );
    if (existing.Count && existing.Count > 0) {
      logger.debug(
        { newsId: record.newsId, publishedAt: record.publishedAt, source: record.source },
        "[NewsStore] duplicate skip",
      );
      // Track DDB-hit duplicates too: if the same newsId reappears later
      // in this same batch, the seenInBatch guard short-circuits it before
      // a second redundant Query is issued. Without this we'd burn an
      // extra RCU per repeat for any article that's already in DDB.
      seenInBatch.add(record.newsId);
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
      seenInBatch.add(record.newsId);
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
