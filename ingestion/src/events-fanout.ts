/**
 * events-fanout Lambda handler — issue #184 (Live Activity Feed).
 *
 * Triggered by DDB Streams on the `quantara-{env}-pipeline-events` table.
 *
 * Each INSERT record in the stream is a PipelineEvent written by one of:
 *   - indicator-handler.ts (indicator-state-updated, signal-emitted)
 *   - ratify.ts            (ratification-fired)
 *   - enrich.ts            (news-enriched)
 *   - sentiment-shock.ts   (sentiment-shock-detected)
 *
 * Flow per INSERT record:
 *   1. Extract the PipelineEvent payload from NewImage.
 *   2. Scan connection-registry for rows where channel = "events".
 *   3. For each matching connectionId, call postToConnection.
 *   4. On GoneException (HTTP 410): delete the stale registry row.
 *   5. On other errors: log + continue.
 *
 * Only processes INSERT events — MODIFY/REMOVE on pipeline-events are ignored.
 *
 * Design: issue #184.
 */

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBStreamHandler, DynamoDBRecord } from "aws-lambda";
import pino from "pino";
import type { PipelineEvent } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TABLE_CONNECTION_REGISTRY =
  process.env.TABLE_CONNECTION_REGISTRY ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}connection-registry`;

const WEBSOCKET_API_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT ?? "";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "events-fanout", env: process.env.ENVIRONMENT ?? "dev" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ---------------------------------------------------------------------------
// Clients — module-scope for Lambda warm reuse
// ---------------------------------------------------------------------------

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

let apigwClient: ApiGatewayManagementApiClient | null = null;

function getApigwClient(): ApiGatewayManagementApiClient {
  if (!apigwClient) {
    if (!WEBSOCKET_API_ENDPOINT) {
      throw new Error("WEBSOCKET_API_ENDPOINT env var is not set");
    }
    apigwClient = new ApiGatewayManagementApiClient({
      endpoint: WEBSOCKET_API_ENDPOINT,
    });
  }
  return apigwClient;
}

// ---------------------------------------------------------------------------
// Registry scan — find all "events" channel connections
// ---------------------------------------------------------------------------

interface EventsRegistryRow {
  connectionId: string;
  userId: string;
}

/**
 * Look up all `events`-channel connections via the connection-registry
 * `channel-index` GSI. Every PipelineEvent triggers this lookup, so a
 * Scan-with-FilterExpression would be 100-1000× the rate of signals-fanout
 * (events fire on every indicator update / signal emit / ratification /
 * news enrich). The GSI lets us Query a single partition (`events`) and
 * read back exactly the matching rows.
 */
export async function findEventSubscribers(): Promise<EventsRegistryRow[]> {
  const rows: EventsRegistryRow[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_CONNECTION_REGISTRY,
        IndexName: "channel-index",
        KeyConditionExpression: "#ch = :events",
        ExpressionAttributeNames: { "#ch": "channel" },
        ExpressionAttributeValues: { ":events": "events" },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      rows.push({
        connectionId: item["connectionId"] as string,
        userId: item["userId"] as string,
      });
    }

    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return rows;
}

// ---------------------------------------------------------------------------
// Delete stale connection
// ---------------------------------------------------------------------------

async function deleteStaleConnection(connectionId: string): Promise<void> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_CONNECTION_REGISTRY,
        Key: { connectionId },
      }),
    );
    logger.info({ connectionId }, "events-fanout: deleted stale connection");
  } catch (err) {
    logger.warn({ connectionId, err }, "events-fanout: failed to delete stale connection");
  }
}

// ---------------------------------------------------------------------------
// Process a single DDB stream record
// ---------------------------------------------------------------------------

async function processRecord(
  record: DynamoDBRecord,
  subscribers: EventsRegistryRow[],
): Promise<void> {
  // Caller pre-filtered to INSERTs; guard NewImage anyway in case the
  // stream payload is malformed.
  if (!record.dynamodb?.NewImage) return;

  const item = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);

  // Reconstruct the PipelineEvent — stored flat on the DDB item.
  const event = item as PipelineEvent & { eventId?: string; ttl?: number };

  logger.info(
    { eventType: event.type, eventId: item["eventId"], ts: event.ts },
    "events-fanout: processing event",
  );

  // Omit DDB-internal fields before forwarding to clients.
  const { eventId: _eventId, ttl: _ttl, ...clientPayload } = event;

  const payload = Buffer.from(JSON.stringify(clientPayload));
  const apigw = getApigwClient();

  await Promise.allSettled(
    subscribers.map(async ({ connectionId, userId }) => {
      try {
        await apigw.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: payload,
          }),
        );
        logger.info({ connectionId, userId, eventType: event.type }, "events-fanout: pushed event");
      } catch (err) {
        if (err instanceof GoneException) {
          logger.info({ connectionId, userId }, "events-fanout: GoneException, deleting stale row");
          await deleteStaleConnection(connectionId);
        } else {
          logger.error({ connectionId, userId, err }, "events-fanout: postToConnection error");
        }
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: DynamoDBStreamHandler = async (event) => {
  // Filter to INSERTs first — TTL deletes (REMOVE) and updates (MODIFY) need
  // no fanout, and skipping them upfront lets us avoid the registry Query
  // entirely on batches that contain only non-INSERT noise.
  const insertRecords = event.Records.filter((r) => r.eventName === "INSERT");

  logger.info(
    { recordCount: event.Records.length, insertCount: insertRecords.length },
    "events-fanout: batch received",
  );

  if (insertRecords.length === 0) return;

  // Hoist subscriber lookup out of the per-record loop — the subscriber set
  // is identical for every record in the batch, so a Query-per-record was
  // O(N) DDB reads when O(1) suffices.
  let subscribers: EventsRegistryRow[];
  try {
    subscribers = await findEventSubscribers();
  } catch (err) {
    logger.error({ err }, "events-fanout: registry scan failed, skipping batch");
    return;
  }

  if (subscribers.length === 0) {
    logger.info(
      { insertCount: insertRecords.length },
      "events-fanout: no events subscribers, skipping batch",
    );
    return;
  }

  for (const record of insertRecords) {
    try {
      await processRecord(record, subscribers);
    } catch (err) {
      logger.error({ eventId: record.eventID, err }, "events-fanout: unhandled record error");
    }
  }
};
