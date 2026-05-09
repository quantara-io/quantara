/**
 * WebSocket $connect Lambda handler — design v6, §16.
 *
 * Invoked by API Gateway WebSocket API when a client upgrades the connection.
 *
 * Flow:
 *   1. Extract JWT from the `token` query-string parameter.
 *      (API Gateway WebSocket doesn't relay custom headers during the upgrade;
 *       the token must come via query string.)
 *   2. Verify the JWT against Aldero's JWKS (same issuer/audience as HTTP API).
 *   3. Parse and validate the `pairs` query parameter.
 *      Unknown pairs → return 401 to close the connection.
 *   4. Write a connection-registry row:
 *        { connectionId, userId, subscribedPairs (StringSet), connectedAt, ttl }
 *   5. Return { statusCode: 200 } to accept the handshake.
 *      Any non-200 return or thrown error closes the connection.
 */

// jose is available via npm hoisting from backend/package.json.
// Human reviewer should add "jose": "^6.0.0" to ingestion/package.json
// dependencies to make this explicit (not relying on hoisting).
import { createRemoteJWKSet, jwtVerify } from "jose";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Handler } from "aws-lambda";
import { PAIRS, type TradingPair } from "@quantara/shared";
import pino from "pino";

// API Gateway WebSocket $connect events carry queryStringParameters but the
// `APIGatewayProxyWebsocketEventV2` type doesn't declare them. We define a
// minimal typed event that matches what API GW actually sends.
interface WsConnectEvent {
  requestContext: {
    connectionId: string;
    routeKey: string;
    eventType: string;
    stage: string;
    requestId: string;
    connectedAt: number;
    requestTimeEpoch: number;
    domainName: string;
    identity: Record<string, string | undefined>;
  };
  queryStringParameters?: Record<string, string>;
  headers?: Record<string, string>;
  isBase64Encoded: boolean;
}

interface WsConnectResult {
  statusCode: number;
  body?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUTH_BASE_URL = process.env.AUTH_BASE_URL ?? "https://quantara-sandbox.aldero.io";
const APP_ID = process.env.APP_ID ?? "";
const TABLE_CONNECTION_REGISTRY =
  process.env.TABLE_CONNECTION_REGISTRY ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}connection-registry`;

const SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 hours — matches API Gateway max

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "ws-connect", env: process.env.ENVIRONMENT ?? "dev" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ---------------------------------------------------------------------------
// JWKS — cached at module scope (reused across warm invocations)
// ---------------------------------------------------------------------------

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${AUTH_BASE_URL}/.well-known/jwks.json`));
  }
  return jwks;
}

// ---------------------------------------------------------------------------
// DDB client
// ---------------------------------------------------------------------------

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ---------------------------------------------------------------------------
// Pair validation helpers
// ---------------------------------------------------------------------------

const VALID_PAIRS = new Set<string>(PAIRS);

/**
 * Parse a raw pairs string from the query parameter.
 * Input examples: "BTC/USDT,ETH/USDT" or "BTC%2FUSDT" (URL-decoded by API GW).
 * Returns the validated pairs or throws if any pair is unknown.
 */
export function parsePairs(raw: string | undefined): TradingPair[] {
  if (!raw || raw.trim() === "") {
    return [...PAIRS]; // subscribe to all pairs if none specified
  }

  const parts = raw
    .split(",")
    .map((p) => p.trim().toUpperCase())
    // Tolerate BTCUSDT → BTC/USDT shorthand (not documented but defensive)
    .map((p) => (p.includes("/") ? p : p));

  const invalid = parts.filter((p) => !VALID_PAIRS.has(p));
  if (invalid.length > 0) {
    throw new Error(`Unknown pairs: ${invalid.join(", ")}`);
  }

  return parts as TradingPair[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: Handler<WsConnectEvent, WsConnectResult> = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const queryParams = event.queryStringParameters ?? {};

  logger.info({ connectionId, queryParams: Object.keys(queryParams) }, "ws $connect");

  // 1. Extract token
  const token = queryParams["token"];
  if (!token) {
    logger.warn({ connectionId }, "ws $connect: missing token query param");
    return { statusCode: 401, body: "Unauthorized" };
  }

  // 2. Verify JWT
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: "auth",
      audience: APP_ID,
    });
    if (!payload.sub) {
      throw new Error("Token missing sub claim");
    }
    userId = payload.sub;
  } catch (err) {
    logger.warn({ connectionId, err }, "ws $connect: JWT verification failed");
    return { statusCode: 401, body: "Unauthorized" };
  }

  // 3. Parse channel (optional). "events" channel receives pipeline activity feed
  //    events; "signals" (default) receives trading signals.
  const channel = queryParams["channel"] === "events" ? "events" : "signals";

  // 4. Parse and validate pairs (only relevant for signals channel, but store
  //    them regardless — the events fanout ignores subscribedPairs entirely).
  let pairs: TradingPair[];
  try {
    pairs = parsePairs(queryParams["pairs"]);
  } catch (err) {
    logger.warn({ connectionId, err }, "ws $connect: invalid pairs");
    return { statusCode: 4001, body: "Invalid pairs" };
  }

  // 5. Write connection-registry row
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + SESSION_TTL_SECONDS;

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_CONNECTION_REGISTRY,
        Item: {
          connectionId,
          userId,
          subscribedPairs: pairs, // stored as List; fanout uses contains()
          channel, // "signals" | "events" — used by fanout Lambdas to route
          connectedAt: now,
          ttl,
        },
      }),
    );
  } catch (err) {
    logger.error({ connectionId, userId, err }, "ws $connect: DDB write failed");
    return { statusCode: 500, body: "Internal Server Error" };
  }

  logger.info({ connectionId, userId, pairs, channel, ttl }, "ws $connect: connection registered");

  return { statusCode: 200 };
};
