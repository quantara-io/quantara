/**
 * backfill-published-day.ts
 *
 * One-time idempotent backfill: scans the news-events table and populates the
 * `publishedDay` attribute (YYYY-MM-DD) on every row that is missing it.
 *
 * `publishedDay` is the partition key for the upcoming `published-day-index`
 * GSI that powers the new paginated admin News feed. The deploy order is:
 *
 *   1. Merge this PR (writers populate `publishedDay` on every new row)
 *   2. Run THIS script — populate `publishedDay` on existing rows
 *   3. Apply Terraform to add the GSI (separate PR)
 *   4. Merge the backend / frontend PR that queries the GSI
 *
 * Steps 2 and 3 are intentionally ordered: if the GSI is added before the
 * backfill, it will be sparse and the admin feed will return empty pages
 * until the backfill completes.
 *
 * Idempotency: rows that already have `publishedDay` are skipped (no write).
 * Safe to re-run multiple times.
 *
 * Usage (run directly with tsx — script is not bundled by esbuild):
 *
 *   AWS_PROFILE=quantara-dev TABLE_PREFIX=quantara-dev- DRY_RUN=true \
 *     npx tsx ingestion/scripts/backfill-published-day.ts
 *
 *   AWS_PROFILE=quantara-dev TABLE_PREFIX=quantara-dev- \
 *     npx tsx ingestion/scripts/backfill-published-day.ts
 *
 * Honours `DRY_RUN=true` for a no-write preview.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;

const DRY_RUN = process.env.DRY_RUN === "true";

// Retry tunables for transient DynamoDB throttling. On-demand tables can still
// surface `ProvisionedThroughputExceededException` / `ThrottlingException`
// during burst writes against a large table, so retry with exponential
// backoff + jitter rather than aborting the whole backfill.
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 100;
const RETRYABLE_ERROR_NAMES = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "InternalServerError",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await op();
    } catch (err: unknown) {
      const name = (err as { name?: string }).name ?? "";
      if (!RETRYABLE_ERROR_NAMES.has(name) || attempt >= MAX_RETRIES) {
        throw err;
      }
      // Exponential backoff with full jitter: delay ∈ [0, BASE * 2^attempt].
      const cap = BASE_DELAY_MS * 2 ** attempt;
      const delay = Math.floor(Math.random() * cap);
      attempt++;
      console.warn(
        `[backfill] ${label} hit ${name} (attempt ${attempt}/${MAX_RETRIES}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

async function backfill(): Promise<void> {
  console.log(`[backfill] Target table: ${NEWS_TABLE}`);
  console.log(`[backfill] Dry run: ${DRY_RUN}`);

  let scanned = 0;
  let skipped = 0;
  let updated = 0;
  let errors = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await withRetry(
      () =>
        client.send(
          new ScanCommand({
            TableName: NEWS_TABLE,
            ProjectionExpression: "newsId, publishedAt, publishedDay",
            ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
          }),
        ),
      "Scan",
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
        await withRetry(
          () =>
            client.send(
              new UpdateCommand({
                TableName: NEWS_TABLE,
                Key: { newsId: item.newsId, publishedAt: item.publishedAt },
                UpdateExpression: "SET publishedDay = :day",
                ExpressionAttributeValues: { ":day": publishedDay },
                // Only write if publishedDay is still absent (idempotent guard against concurrent backfills).
                ConditionExpression: "attribute_not_exists(publishedDay)",
              }),
            ),
          `Update ${item.newsId}`,
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
