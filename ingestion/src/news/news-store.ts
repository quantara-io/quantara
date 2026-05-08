import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

import type { NewsRecord } from "./types.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;

export async function storeNewsRecords(records: NewsRecord[]): Promise<number> {
  // Deduplicate: skip records that already exist
  const newRecords: NewsRecord[] = [];
  for (const record of records) {
    const existing = await client.send(
      new GetCommand({
        TableName: NEWS_TABLE,
        Key: { newsId: record.newsId, publishedAt: record.publishedAt },
        ProjectionExpression: "newsId",
      })
    );
    if (!existing.Item) {
      newRecords.push(record);
    }
  }

  if (newRecords.length === 0) return 0;

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
      })
    );
  }

  console.log(`[NewsStore] Wrote ${newRecords.length} news records (${records.length - newRecords.length} duplicates skipped)`);
  return newRecords.length;
}
