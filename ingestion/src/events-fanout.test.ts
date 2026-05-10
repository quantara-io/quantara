/**
 * Tests for events-fanout.ts (#184 — Live Activity Feed)
 *
 * Covers:
 *   - findEventSubscribers: queries channel-index GSI with channel="events"
 *   - handler: INSERT records → postToConnection per subscriber
 *   - handler: skips non-INSERT (MODIFY/REMOVE)
 *   - handler: GoneException → DeleteItem on registry
 *   - handler: non-Gone errors don't abort the batch
 *   - handler: empty subscribers → no-op (no postToConnection calls)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// AWS SDK mocks
// ---------------------------------------------------------------------------

const ddbSend = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: ddbSend }) },
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  DeleteCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Delete", input })),
}));

const postToConnectionMock = vi.fn();
class GoneExceptionMock extends Error {
  readonly name = "GoneException";
  readonly $fault = "client";
  readonly $metadata = {};
  constructor() {
    super("GoneException");
  }
}
vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: vi.fn().mockImplementation(() => ({
    send: postToConnectionMock,
  })),
  PostToConnectionCommand: vi.fn().mockImplementation((input) => ({
    __cmd: "PostToConnection",
    input,
  })),
  GoneException: GoneExceptionMock,
}));

vi.mock("@aws-sdk/util-dynamodb", () => ({
  unmarshall: vi.fn().mockImplementation((image) => image),
}));

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  ddbSend.mockReset();
  postToConnectionMock.mockReset();
  process.env.WEBSOCKET_API_ENDPOINT =
    "https://example.execute-api.us-west-2.amazonaws.com/$default";
  process.env.TABLE_CONNECTION_REGISTRY = "quantara-test-connection-registry";
});

// ---------------------------------------------------------------------------
// findEventSubscribers — uses channel-index GSI Query, not Scan
// ---------------------------------------------------------------------------

describe("findEventSubscribers", () => {
  it("queries the channel-index GSI with channel=events", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        { connectionId: "c1", userId: "u1" },
        { connectionId: "c2", userId: "u2" },
      ],
      LastEvaluatedKey: undefined,
    });

    const { findEventSubscribers } = await import("./events-fanout.js");
    const rows = await findEventSubscribers();

    expect(rows).toEqual([
      { connectionId: "c1", userId: "u1" },
      { connectionId: "c2", userId: "u2" },
    ]);
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const call = ddbSend.mock.calls[0][0] as { __cmd: string; input: Record<string, unknown> };
    expect(call.__cmd).toBe("Query");
    expect(call.input.IndexName).toBe("channel-index");
    expect(call.input.KeyConditionExpression).toBe("#ch = :events");
    expect(call.input.ExpressionAttributeValues).toEqual({ ":events": "events" });
  });

  it("paginates via LastEvaluatedKey", async () => {
    ddbSend
      .mockResolvedValueOnce({
        Items: [{ connectionId: "c1", userId: "u1" }],
        LastEvaluatedKey: { connectionId: "c1" },
      })
      .mockResolvedValueOnce({
        Items: [{ connectionId: "c2", userId: "u2" }],
        LastEvaluatedKey: undefined,
      });

    const { findEventSubscribers } = await import("./events-fanout.js");
    const rows = await findEventSubscribers();
    expect(rows).toHaveLength(2);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// handler — INSERT routing
// ---------------------------------------------------------------------------

describe("events-fanout handler", () => {
  function makeInsertRecord(payload: Record<string, unknown>) {
    return {
      eventName: "INSERT" as const,
      eventID: `evt-${Math.random()}`,
      dynamodb: { NewImage: payload },
    };
  }

  it("pushes INSERT events to all event-channel subscribers", async () => {
    ddbSend.mockResolvedValue({
      Items: [
        { connectionId: "c1", userId: "u1" },
        { connectionId: "c2", userId: "u2" },
      ],
      LastEvaluatedKey: undefined,
    });
    postToConnectionMock.mockResolvedValue({});

    const { handler } = await import("./events-fanout.js");
    await handler(
      {
        Records: [
          makeInsertRecord({
            eventId: "evt-1",
            ttl: 1234567890,
            type: "signal-emitted",
            pair: "BTC/USDT",
            timeframe: "15m",
            signalType: "buy",
            confidence: 0.8,
            closeTime: "2026-05-09T12:00:00Z",
            ts: "2026-05-09T12:00:01Z",
          }),
        ],
      } as Parameters<typeof handler>[0],
      {} as Parameters<typeof handler>[1],
      () => undefined,
    );

    expect(postToConnectionMock).toHaveBeenCalledTimes(2);
    const sentPayloads = postToConnectionMock.mock.calls.map((c) => {
      const arg = c[0] as { input: { Data: Buffer } };
      return JSON.parse(arg.input.Data.toString());
    });
    // eventId / ttl stripped before forwarding to clients
    for (const p of sentPayloads) {
      expect(p).not.toHaveProperty("eventId");
      expect(p).not.toHaveProperty("ttl");
      expect(p.type).toBe("signal-emitted");
      expect(p.pair).toBe("BTC/USDT");
    }
  });

  it("skips non-INSERT records", async () => {
    const { handler } = await import("./events-fanout.js");
    await handler(
      {
        Records: [
          { eventName: "MODIFY", eventID: "m", dynamodb: { NewImage: {} } },
          { eventName: "REMOVE", eventID: "r", dynamodb: { OldImage: {} } },
        ],
      } as Parameters<typeof handler>[0],
      {} as Parameters<typeof handler>[1],
      () => undefined,
    );
    expect(ddbSend).not.toHaveBeenCalled();
    expect(postToConnectionMock).not.toHaveBeenCalled();
  });

  it("deletes stale connection on GoneException", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ connectionId: "c-gone", userId: "u-gone" }],
      LastEvaluatedKey: undefined,
    });
    // After the Query, ddbSend will be called again for DeleteCommand.
    ddbSend.mockResolvedValueOnce({});
    postToConnectionMock.mockRejectedValueOnce(new GoneExceptionMock());

    const { handler } = await import("./events-fanout.js");
    await handler(
      {
        Records: [
          makeInsertRecord({
            eventId: "evt-2",
            ttl: 0,
            type: "quorum-failed",
            pair: "ETH/USDT",
            timeframe: "1h",
            closeTime: "2026-05-09T12:00:00Z",
            ts: "2026-05-09T12:00:01Z",
          }),
        ],
      } as Parameters<typeof handler>[0],
      {} as Parameters<typeof handler>[1],
      () => undefined,
    );

    // Query + Delete = 2 ddbSend calls
    expect(ddbSend).toHaveBeenCalledTimes(2);
    const lastCall = ddbSend.mock.calls[1][0] as {
      __cmd: string;
      input: { Key: { connectionId: string } };
    };
    expect(lastCall.__cmd).toBe("Delete");
    expect(lastCall.input.Key.connectionId).toBe("c-gone");
  });

  it("no-ops cleanly when there are zero subscribers", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

    const { handler } = await import("./events-fanout.js");
    await handler(
      {
        Records: [
          makeInsertRecord({
            eventId: "evt-3",
            ttl: 0,
            type: "news-enriched",
            newsId: "n-1",
            mentionedPairs: ["BTC"],
            sentimentScore: 0.5,
            sentimentMagnitude: 0.7,
            ts: "2026-05-09T12:00:01Z",
          }),
        ],
      } as Parameters<typeof handler>[0],
      {} as Parameters<typeof handler>[1],
      () => undefined,
    );

    expect(ddbSend).toHaveBeenCalledTimes(1); // Query only — no Delete (no Gone)
    expect(postToConnectionMock).not.toHaveBeenCalled();
  });
});
