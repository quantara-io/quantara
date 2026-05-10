/**
 * pipeline-events-store.ts — write PipelineEvent records to DDB for live activity feed.
 *
 * Table: quantara-{env}-pipeline-events
 * Schema:
 *   PK: eventId   (S) — unique per event (crypto.randomUUID())
 *   SK: ts        (S) — ISO-8601 timestamp (enables chronological sort)
 *   TTL: ttl      (N) — Unix seconds, 24h from write time
 *
 * DDB Streams on this table trigger the events-fanout Lambda which pushes
 * events to WebSocket clients subscribed to `?channel=events`.
 *
 * Design: issue #184.
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { PipelineEvent } from "@quantara/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PIPELINE_EVENTS_TABLE =
  process.env.TABLE_PIPELINE_EVENTS ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}pipeline-events`;

/** TTL: 24 hours in seconds. */
const TTL_SECONDS = 86_400;

/**
 * Write a PipelineEvent to the `pipeline-events` DDB table.
 *
 * Note: this function PROPAGATES errors. The caller is responsible for
 * deciding whether to swallow them. Use `emitPipelineEventSafe` (below)
 * in signal-critical paths to get fire-and-forget semantics — that
 * wrapper logs and discards errors so a DDB write failure can never
 * block the primary flow.
 */
export async function emitPipelineEvent(event: PipelineEvent): Promise<void> {
  const eventId = crypto.randomUUID();
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  await ddb.send(
    new PutCommand({
      TableName: PIPELINE_EVENTS_TABLE,
      Item: {
        eventId,
        ttl,
        ...event,
      },
    }),
  );
}

/**
 * Safe wrapper: logs errors but never propagates them.
 * Use this in signal-critical paths (indicator-handler, ratify, enrich)
 * so a DDB write failure never kills the primary flow.
 */
export function emitPipelineEventSafe(event: PipelineEvent): void {
  emitPipelineEvent(event).catch((err: unknown) => {
    console.warn(`[PipelineEvents] Failed to emit ${event.type} event: ${(err as Error).message}`);
  });
}
