import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

import type { NewsRecord } from "./types.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;

/**
 * Store news records, deduplicating against existing rows.
 *
 * Returns the newly-written records (not just a count) so callers can fan-out
 * only the records that actually landed in the table.
 *
 * Dedup key: (newsId, publishedAt) — the DynamoDB primary key.  A GetItem
 * check is issued per record before batching writes.  Each check is logged at
 * DEBUG level so future regressions are diagnosable without instrumenting the
 * Fargate task.
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
      console.debug(
        `[NewsStore] duplicate skip: newsId=${record.newsId} publishedAt=${record.publishedAt} source=${record.source}`,
      );
    } else {
      console.debug(
        `[NewsStore] new record: newsId=${record.newsId} publishedAt=${record.publishedAt} source=${record.source} title="${record.title.slice(0, 60)}"`,
      );
      newRecords.push(record);
    }
  }

  if (newRecords.length === 0) {
    console.log(
      `[NewsStore] 0 new records (all ${records.length} were duplicates) table=${NEWS_TABLE}`,
    );
    return [];
  }

  const batches: NewsRecord[][] = [];
  for (let i = 0; i < newRecords.length; i += 25) {
    batches.push(newRecords.slice(i, i + 25));
  }

  for (const batch of batches) {
    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [NEWS_TABLE]: batch.map((r) => ({
            PutRequest: { Item: r },
          })),
        },
      }),
    );
  }

  console.log(
    `[NewsStore] Wrote ${newRecords.length} news records (${records.length - newRecords.length} duplicates skipped) table=${NEWS_TABLE}`,
  );
  return newRecords;
}
