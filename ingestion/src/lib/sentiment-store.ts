import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SENTIMENT_AGGREGATES_TABLE =
  process.env.TABLE_SENTIMENT_AGGREGATES ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}sentiment-aggregates`;

/** TTL duration for an aggregate row: 1 hour (refreshed on each recompute). */
const AGGREGATE_TTL_SECONDS = 3600;

export interface SentimentAggregateRecord {
  pair: string;
  window: "4h" | "24h";
  score: number;
  magnitude: number;
  articleCount: number;
  sourceCounts: Record<string, number>;
  computedAt: string;
  ttl: number;
}

/**
 * Write (or overwrite) a sentiment aggregate row.
 * TTL is refreshed to +1 hour on every write.
 */
export async function putSentimentAggregate(
  item: Omit<SentimentAggregateRecord, "ttl">
): Promise<void> {
  const record: SentimentAggregateRecord = {
    ...item,
    ttl: Math.floor(Date.now() / 1000) + AGGREGATE_TTL_SECONDS,
  };

  await client.send(
    new PutCommand({
      TableName: SENTIMENT_AGGREGATES_TABLE,
      Item: record,
    })
  );
}

/**
 * Read a single aggregate row. Returns null if the item does not exist.
 */
export async function getSentimentAggregate(
  pair: string,
  window: "4h" | "24h"
): Promise<SentimentAggregateRecord | null> {
  const result = await client.send(
    new GetCommand({
      TableName: SENTIMENT_AGGREGATES_TABLE,
      Key: { pair, window },
    })
  );

  return result.Item ? (result.Item as SentimentAggregateRecord) : null;
}
