import type { SQSEvent, Context } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { enrichNewsItem } from "./bedrock.js";
import { enrichArticle } from "../news/enrich.js";
import { publish } from "../lib/sqs-publisher.js";
import { writePairFanout } from "../lib/news-by-pair-store.js";

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
      // Phase 1 (existing): Bedrock entity/event enrichment
      const enrichment = await enrichNewsItem(
        newsRecord.title as string,
        (newsRecord.currencies as string[]) ?? []
      );

      // Phase 5a: pair-tagging, sentiment classifier, embedding dedup
      const phase5a = await enrichArticle({
        id: newsId,
        title: newsRecord.title as string,
        body: (newsRecord.body as string | undefined) ?? newsRecord.title as string,
        publishedAt,
      });

      // Update the news record with both enrichment sets
      await client.send(
        new UpdateCommand({
          TableName: NEWS_TABLE,
          Key: { newsId, publishedAt },
          UpdateExpression: [
            "SET enrichment = :enrichment,",
            "enrichedAt = :enrichedAt,",
            "#status = :status,",
            "mentionedPairs = :mentionedPairs,",
            "sentiment = :sentiment,",
            "duplicateOf = :duplicateOf,",
            "embeddingModel = :embeddingModel",
          ].join(" "),
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":enrichment": enrichment,
            ":enrichedAt": phase5a.enrichedAt,
            ":status": "enriched",
            ":mentionedPairs": phase5a.mentionedPairs,
            ":sentiment": phase5a.sentiment,
            ":duplicateOf": phase5a.duplicateOf ?? null,
            ":embeddingModel": phase5a.embeddingModel,
          },
        })
      );

      // Phase 5b: fan-out one row per mentioned pair to news-events-by-pair table.
      // These scalar-keyed rows are what the sentiment aggregator queries — they
      // avoid the DynamoDB GSI limitation where array attributes don't index.
      if (phase5a.mentionedPairs.length > 0) {
        await writePairFanout(
          phase5a.mentionedPairs.map((pair) => ({
            pair,
            articleId: newsId,
            publishedAt,
            title: newsRecord.title as string,
            sentimentScore: phase5a.sentiment.score,
            sentimentMagnitude: phase5a.sentiment.magnitude,
            source: (newsRecord.source as string | undefined) ?? "unknown",
            url: (newsRecord.url as string | undefined) ?? "",
            duplicateOf: phase5a.duplicateOf ?? null,
          }))
        );
        console.log(
          `[Enrichment] Fan-out: wrote ${phase5a.mentionedPairs.length} pair rows for ${newsId}`
        );
      }

      // Publish enriched event for downstream analysis
      await publish(ENRICHED_QUEUE, "enriched_news", {
        newsId,
        publishedAt,
        currencies: newsRecord.currencies,
        enrichment,
        mentionedPairs: phase5a.mentionedPairs,
        sentiment: phase5a.sentiment,
        duplicateOf: phase5a.duplicateOf,
      });

      console.log(
        `[Enrichment] Success: ${newsId} → ${enrichment.sentiment} (${enrichment.confidence}), pairs=${phase5a.mentionedPairs.join(",")}, sentiment.score=${phase5a.sentiment.score}`
      );
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
