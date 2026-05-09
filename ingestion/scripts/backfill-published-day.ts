/**
 * backfill-published-day.ts
 *
 * One-time idempotent backfill: scans the news-events table and populates the
 * `publishedDay` attribute (YYYY-MM-DD) on every row that is missing it.
 *
 * `publishedDay` is the partition key for the `published-day-index` GSI that
 * powers the new paginated admin News feed. Rows without this attribute are
 * invisible to the GSI query.
 *
 * Idempotency: rows that already have `publishedDay` are skipped (no write).
 * Safe to re-run multiple times.
 *
 * Usage:
 *   AWS_PROFILE=quantara-dev TABLE_PREFIX=quantara-dev- \
 *     npx tsx ingestion/scripts/backfill-published-day.ts
 *
 * Or in CI / Lambda after the GSI is deployed:
 *   AWS_REGION=us-west-2 TABLE_NEWS_EVENTS=quantara-prod-news-events \
 *     node dist/backfill-published-day.js
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;

const DRY_RUN = process.env.DRY_RUN === "true";

async function backfill(): Promise<void> {
  console.log(`[backfill] Target table: ${NEWS_TABLE}`);
  console.log(`[backfill] Dry run: ${DRY_RUN}`);

  let scanned = 0;
  let skipped = 0;
  let updated = 0;
  let errors = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: NEWS_TABLE,
        ProjectionExpression: "newsId, publishedAt, publishedDay",
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    const items = (result.Items ?? []) as Array<{
      newsId: string;
      publishedAt: string;
      publishedDay?: string;
    }>;

    scanned += items.length;

    for (const item of items) {
      // Already has publishedDay — skip (idempotent).
      if (item.publishedDay) {
        skipped++;
        continue;
      }

      // Derive publishedDay from publishedAt (ISO-8601 → YYYY-MM-DD).
      const publishedAt = item.publishedAt;
      if (!publishedAt || typeof publishedAt !== "string" || publishedAt.length < 10) {
        console.warn(
          `[backfill] Row newsId=${item.newsId} has invalid publishedAt="${publishedAt}" — skipping`,
        );
        skipped++;
        continue;
      }

      const publishedDay = publishedAt.slice(0, 10);

      if (DRY_RUN) {
        console.log(
          `[backfill] DRY RUN: would set publishedDay=${publishedDay} on newsId=${item.newsId}`,
        );
        updated++;
        continue;
      }

      try {
        await client.send(
          new UpdateCommand({
            TableName: NEWS_TABLE,
            Key: { newsId: item.newsId, publishedAt: item.publishedAt },
            UpdateExpression: "SET publishedDay = :day",
            ExpressionAttributeValues: { ":day": publishedDay },
            // Only write if publishedDay is still absent (idempotent guard against concurrent backfills).
            ConditionExpression: "attribute_not_exists(publishedDay)",
          }),
        );
        updated++;
        if (updated % 100 === 0) {
          console.log(
            `[backfill] Progress: scanned=${scanned} updated=${updated} skipped=${skipped} errors=${errors}`,
          );
        }
      } catch (err: unknown) {
        // ConditionalCheckFailedException means a concurrent run already wrote it — not an error.
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
          skipped++;
        } else {
          errors++;
          console.error(`[backfill] Failed to update newsId=${item.newsId}:`, err);
        }
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  console.log(
    `[backfill] Done. scanned=${scanned} updated=${updated} skipped=${skipped} errors=${errors}`,
  );

  if (errors > 0) {
    process.exit(1);
  }
}

backfill().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
