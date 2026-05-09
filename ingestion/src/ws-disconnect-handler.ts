/**
 * WebSocket $disconnect Lambda handler — design v6, §16.
 *
 * Invoked by API Gateway WebSocket API when a client disconnects (clean close,
 * error, or timeout). Best-effort: we tolerate "item not found" errors because
 * TTL may have already expired the row.
 *
 * Flow:
 *   1. Extract connectionId from event.requestContext.
 *   2. Delete the connection-registry row.
 *   3. Return { statusCode: 200 } — always succeed; API GW ignores the body.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { Handler } from "aws-lambda";
import pino from "pino";

// Minimal typed WebSocket $disconnect event
interface WsDisconnectEvent {
  requestContext: {
    connectionId: string;
    routeKey: string;
    eventType: string;
    stage: string;
    requestId: string;
    domainName: string;
    disconnectStatusCode?: number;
    disconnectReason?: string;
  };
  isBase64Encoded: boolean;
}

interface WsResult {
  statusCode: number;
  body?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TABLE_CONNECTION_REGISTRY =
  process.env.TABLE_CONNECTION_REGISTRY ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}connection-registry`;

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "ws-disconnect", env: process.env.ENVIRONMENT ?? "dev" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ---------------------------------------------------------------------------
// DDB client
// ---------------------------------------------------------------------------

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler<WsDisconnectEvent, WsResult> = async (event) => {
  const connectionId = event.requestContext.connectionId;

  logger.info({ connectionId }, "ws $disconnect");

  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_CONNECTION_REGISTRY,
        Key: { connectionId },
      }),
    );
    logger.info({ connectionId }, "ws $disconnect: registry row deleted");
  } catch (err) {
    // Best-effort — log but don't fail. TTL may have already cleaned this up.
    logger.warn({ connectionId, err }, "ws $disconnect: DDB delete failed (ignored)");
  }

  return { statusCode: 200 };
};
