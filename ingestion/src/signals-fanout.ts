/**
 * signals-fanout Lambda handler — design v6, §16.
 *
 * Triggered by DDB Streams on the `quantara-{env}-signals` table
 * (the user-facing RATIFIED signals table per §11.1).
 *
 * IMPORTANT — P2.1 correction (issue #116):
 *   This Lambda subscribes to the `signals` table (ratified), NOT `signals-v2`
 *   (pre-ratification compute/dedup table per §11.6). Fanout from signals-v2
 *   would push pre-ratification candidates; LLM ratification can downgrade them
 *   after the fact and the downgrade would never reach subscribers.
 *
 * Filter on INSERT only (configured via event source mapping in Terraform).
 *
 * Flow per INSERT record:
 *   1. Extract the signal payload from NewImage.
 *   2. Scan connection-registry for rows where subscribedPairs contains the pair.
 *   3. For each matching connectionId, call postToConnection.
 *   4. On GoneException (HTTP 410): delete the stale registry row.
 *   5. On other errors: log + continue.
 */

// NOTE: @aws-sdk/client-apigatewaymanagementapi must be added to ingestion's
// package.json (devDependencies for typecheck; externalized at runtime via esbuild).
// This is flagged as a dependency tripwire — human reviewer must add:
//   "@aws-sdk/client-apigatewaymanagementapi": "^3.750.0"
// to ingestion/package.json devDependencies before merging.
//
// @ts-expect-error missing dep — see note above
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBStreamHandler, DynamoDBRecord } from "aws-lambda";
import pino from "pino";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TABLE_CONNECTION_REGISTRY =
  process.env.TABLE_CONNECTION_REGISTRY ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}connection-registry`;

// The WebSocket management endpoint URL.
// Format injected by Terraform: https://<api-id>.execute-api.<region>.amazonaws.com/$default
const WEBSOCKET_API_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT ?? "";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "signals-fanout", env: process.env.ENVIRONMENT ?? "dev" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ---------------------------------------------------------------------------
// Clients — module-scope for Lambda warm reuse
// ---------------------------------------------------------------------------

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// The ApiGatewayManagementApiClient must be pointed at the WebSocket stage endpoint.
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
// Registry scan
// ---------------------------------------------------------------------------

interface RegistryRow {
  connectionId: string;
  userId: string;
  subscribedPairs: string[];
}

/**
 * Scan the connection-registry for all rows where subscribedPairs contains `pair`.
 * This is a full-table scan with a FilterExpression — acceptable for v1.
 * (Inverted subscription table for O(1) lookup is deferred to §16.7.)
 */
export async function findSubscribersForPair(pair: string): Promise<RegistryRow[]> {
  const rows: RegistryRow[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: TABLE_CONNECTION_REGISTRY,
        FilterExpression: "contains(subscribedPairs, :pair)",
        ExpressionAttributeValues: { ":pair": pair },
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      rows.push({
        connectionId: item["connectionId"] as string,
        userId: item["userId"] as string,
        subscribedPairs: (item["subscribedPairs"] as string[]) ?? [],
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
    logger.info({ connectionId }, "fanout: deleted stale connection");
  } catch (err) {
    logger.warn({ connectionId, err }, "fanout: failed to delete stale connection");
  }
}

// ---------------------------------------------------------------------------
// Process a single DDB stream record
// ---------------------------------------------------------------------------

async function processRecord(record: DynamoDBRecord): Promise<void> {
  if (record.eventName !== "INSERT") return;
  if (!record.dynamodb?.NewImage) return;

  const signal = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);

  const pair = signal["pair"] as string | undefined;
  if (!pair) {
    logger.warn({ record: record.eventID }, "fanout: signal missing pair attribute, skipping");
    return;
  }

  logger.info(
    { pair, signalId: signal["signalId"] ?? signal["createdAt"] },
    "fanout: processing INSERT",
  );

  // Find all subscribers for this pair
  let subscribers: RegistryRow[];
  try {
    subscribers = await findSubscribersForPair(pair);
  } catch (err) {
    logger.error({ pair, err }, "fanout: registry scan failed, skipping record");
    return;
  }

  if (subscribers.length === 0) {
    logger.info({ pair }, "fanout: no subscribers, skipping");
    return;
  }

  logger.info({ pair, count: subscribers.length }, "fanout: pushing to subscribers");

  const payload = Buffer.from(JSON.stringify(signal));
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
        logger.info({ connectionId, userId, pair }, "fanout: pushed signal");
      } catch (err) {
        if (err instanceof GoneException) {
          // Connection is no longer active — clean up the registry row.
          logger.info({ connectionId, userId }, "fanout: GoneException, deleting stale row");
          await deleteStaleConnection(connectionId);
        } else {
          // Non-Gone error — log and continue; don't block the rest of the fanout.
          logger.error({ connectionId, userId, pair, err }, "fanout: postToConnection error");
        }
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: DynamoDBStreamHandler = async (event) => {
  logger.info({ recordCount: event.Records.length }, "fanout: batch received");

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      // Per-record error — log and continue processing the batch.
      logger.error({ eventId: record.eventID, err }, "fanout: unhandled record error");
    }
  }
};
