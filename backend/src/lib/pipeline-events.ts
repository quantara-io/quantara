/**
 * pipeline-events.ts — backend-side writer for the live activity feed.
 *
 * Mirrors `ingestion/src/lib/pipeline-events-store.ts`. The backend writes
 * its own subset of events (currently just the backtest lifecycle) — there's
 * no requirement that all writers share a single helper because they don't
 * share a single deployment artifact. Keeping a tiny backend copy avoids
 * pulling ingestion into the API Lambda bundle.
 *
 * Table: quantara-{env}-pipeline-events
 * Schema:
 *   PK: eventId (S) — crypto.randomUUID()
 *   SK: ts      (S) — ISO-8601 timestamp
 *   TTL: ttl    (N) — Unix seconds, 24h
 *
 * Phase 4 (issue #371) — emits backtest-queued from POST /admin/backtest.
 * The remaining backtest events (started / progress / completed / failed) are
 * emitted by the Fargate runner in backtest/src/runner/main.ts.
 */

import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { PipelineEvent } from "@quantara/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PIPELINE_EVENTS_TABLE =
  process.env.TABLE_PIPELINE_EVENTS ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}pipeline-events`;

/** TTL: 24 hours in seconds. */
const TTL_SECONDS = 86_400;

export async function emitPipelineEvent(event: PipelineEvent): Promise<void> {
  const eventId = randomUUID();
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  await ddb.send(
    new PutCommand({
      TableName: PIPELINE_EVENTS_TABLE,
      Item: { eventId, ttl, ...event },
    }),
  );
}

/**
 * Fire-and-forget wrapper: logs but never throws. Use in admin routes so a
 * DDB write failure can never block the primary flow (e.g. SQS enqueue).
 */
export function emitPipelineEventSafe(event: PipelineEvent): void {
  emitPipelineEvent(event).catch((err: unknown) => {
    console.warn(`[PipelineEvents] Failed to emit ${event.type} event: ${(err as Error).message}`);
  });
}
