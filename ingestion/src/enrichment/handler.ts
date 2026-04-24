import type { SQSEvent, Context } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { enrichNewsItem } from "./bedrock.js";
import { publish } from "../lib/sqs-publisher.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const NEWS_TABLE = process.env.TABLE_NEWS_EVENTS!;
const ENRICHED_QUEUE = process.env.ENRICHED_NEWS_QUEUE!;

export async function handler(event: SQSEvent, _context: Context): Promise<void> {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    const { newsId, publishedAt } = message.data;

    console.log(`[Enrichment] Processing ${newsId}`);

    // Fetch the raw news record
    const result = await client.send(
      new GetCommand({
        TableName: NEWS_TABLE,
        Key: { newsId, publishedAt },
      })
    );

    const newsRecord = result.Item;
    if (!newsRecord) {
      console.error(`[Enrichment] News record not found: ${newsId}`);
      continue;
    }

    if (newsRecord.status === "enriched") {
      console.log(`[Enrichment] Already enriched: ${newsId}`);
      continue;
    }

    try {
      const enrichment = await enrichNewsItem(
        newsRecord.title as string,
        (newsRecord.currencies as string[]) ?? []
      );

      // Update the news record with enrichment
      await client.send(
        new UpdateCommand({
          TableName: NEWS_TABLE,
          Key: { newsId, publishedAt },
          UpdateExpression: "SET enrichment = :enrichment, enrichedAt = :enrichedAt, #status = :status",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":enrichment": enrichment,
            ":enrichedAt": new Date().toISOString(),
            ":status": "enriched",
          },
        })
      );

      // Publish enriched event for downstream analysis
      await publish(ENRICHED_QUEUE, "enriched_news", {
        newsId,
        publishedAt,
        currencies: newsRecord.currencies,
        enrichment,
      });

      console.log(`[Enrichment] Success: ${newsId} → ${enrichment.sentiment} (${enrichment.confidence})`);
    } catch (err) {
      console.error(`[Enrichment] Failed: ${newsId}: ${(err as Error).message}`);

      // Mark as failed
      await client.send(
        new UpdateCommand({
          TableName: NEWS_TABLE,
          Key: { newsId, publishedAt },
          UpdateExpression: "SET #status = :status",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": "failed" },
        })
      );

      throw err; // Let SQS retry
    }
  }
}
