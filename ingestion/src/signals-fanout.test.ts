/**
 * Tests for signals-fanout.ts
 *
 * Covers:
 *   - findSubscribersForPair: scans registry with correct filter, handles pagination
 *   - handler: processes INSERT events (new signals)
 *   - handler: processes MODIFY events (Phase B1 — ratification verdict updates)
 *   - handler: skips non-INSERT/MODIFY events (DELETE, REMOVE)
 *   - handler: skips records without pair
 *   - handler: calls postToConnection for each subscriber
 *   - handler: deletes stale connections on GoneException
 *   - handler: continues on non-Gone postToConnection errors
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
  ScanCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Scan", input })),
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

// ---------------------------------------------------------------------------
// util-dynamodb mock
// ---------------------------------------------------------------------------

vi.mock("@aws-sdk/util-dynamodb", () => ({
  unmarshall: vi.fn().mockImplementation((image) => {
    // Simple passthrough — test records already use plain JS objects
    return image;
  }),
}));

// ---------------------------------------------------------------------------
// Reset between tests
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
// findSubscribersForPair tests
// ---------------------------------------------------------------------------

describe("findSubscribersForPair", () => {
  it("scans with contains() filter on subscribedPairs", async () => {
    ddbSend.mockResolvedValue({
      Items: [{ connectionId: "conn-1", userId: "u1", subscribedPairs: ["BTC/USDT"] }],
      LastEvaluatedKey: undefined,
    });

    const { findSubscribersForPair } = await import("./signals-fanout.js");
    const result = await findSubscribersForPair("BTC/USDT");

    expect(result).toHaveLength(1);
    expect(result[0].connectionId).toBe("conn-1");

    const scanCall = ddbSend.mock.calls[0][0];
    expect(scanCall.input.FilterExpression).toBe("contains(subscribedPairs, :pair)");
    expect(scanCall.input.ExpressionAttributeValues[":pair"]).toBe("BTC/USDT");
  });

  it("paginates through all pages", async () => {
    ddbSend
      .mockResolvedValueOnce({
        Items: [{ connectionId: "conn-1", userId: "u1", subscribedPairs: ["BTC/USDT"] }],
        LastEvaluatedKey: { connectionId: "conn-1" },
      })
      .mockResolvedValueOnce({
        Items: [{ connectionId: "conn-2", userId: "u2", subscribedPairs: ["BTC/USDT"] }],
        LastEvaluatedKey: undefined,
      });

    const { findSubscribersForPair } = await import("./signals-fanout.js");
    const result = await findSubscribersForPair("BTC/USDT");

    expect(result).toHaveLength(2);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no subscribers found", async () => {
    ddbSend.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

    const { findSubscribersForPair } = await import("./signals-fanout.js");
    const result = await findSubscribersForPair("SOL/USDT");

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handler tests
// ---------------------------------------------------------------------------

function makeInsertRecord(pair: string, extraFields: Record<string, unknown> = {}) {
  return {
    eventName: "INSERT",
    eventID: "test-event-1",
    dynamodb: {
      NewImage: {
        pair,
        createdAt: "2026-05-08T00:00:00.000Z",
        ...extraFields,
      },
    },
  };
}

function makeModifyRecord(pair: string) {
  return {
    eventName: "MODIFY",
    eventID: "test-event-2",
    dynamodb: {
      NewImage: { pair },
    },
  };
}

describe("handler", () => {
  it("processes MODIFY events (Phase B1 ratification verdict push)", async () => {
    ddbSend.mockResolvedValue({
      Items: [{ connectionId: "conn-1", userId: "u1", subscribedPairs: ["BTC/USDT"] }],
      LastEvaluatedKey: undefined,
    });
    postToConnectionMock.mockResolvedValue({});

    const { handler } = await import("./signals-fanout.js");
    await handler({ Records: [makeModifyRecord("BTC/USDT")] } as any, {} as any, () => {});

    // MODIFY should trigger a registry scan and push — same path as INSERT
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(postToConnectionMock).toHaveBeenCalledTimes(1);
    const call = postToConnectionMock.mock.calls[0][0];
    expect(call.input.ConnectionId).toBe("conn-1");
  });

  it("skips DELETE and REMOVE events", async () => {
    const { handler } = await import("./signals-fanout.js");
    await handler(
      {
        Records: [
          { eventName: "REMOVE", eventID: "x", dynamodb: { NewImage: { pair: "BTC/USDT" } } },
        ],
      } as any,
      {} as any,
      () => {},
    );
    expect(ddbSend).not.toHaveBeenCalled();
    expect(postToConnectionMock).not.toHaveBeenCalled();
  });

  it("skips records with no NewImage", async () => {
    const { handler } = await import("./signals-fanout.js");
    await handler(
      { Records: [{ eventName: "INSERT", eventID: "x", dynamodb: {} }] } as any,
      {} as any,
      () => {},
    );
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("skips records where pair is missing from NewImage", async () => {
    const { handler } = await import("./signals-fanout.js");
    await handler(
      {
        Records: [
          {
            eventName: "INSERT",
            eventID: "x",
            dynamodb: { NewImage: { createdAt: "2026-05-08" } },
          },
        ],
      } as any,
      {} as any,
      () => {},
    );
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("sends signal to all matching subscribers", async () => {
    ddbSend.mockResolvedValue({
      Items: [
        { connectionId: "conn-1", userId: "u1", subscribedPairs: ["BTC/USDT"] },
        { connectionId: "conn-2", userId: "u2", subscribedPairs: ["BTC/USDT", "ETH/USDT"] },
      ],
      LastEvaluatedKey: undefined,
    });
    postToConnectionMock.mockResolvedValue({});

    const { handler } = await import("./signals-fanout.js");
    await handler({ Records: [makeInsertRecord("BTC/USDT")] } as any, {} as any, () => {});

    expect(postToConnectionMock).toHaveBeenCalledTimes(2);
    const call1 = postToConnectionMock.mock.calls[0][0];
    expect(call1.input.ConnectionId).toBe("conn-1");
    const call2 = postToConnectionMock.mock.calls[1][0];
    expect(call2.input.ConnectionId).toBe("conn-2");
  });

  it("skips fanout when no subscribers found", async () => {
    ddbSend.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });

    const { handler } = await import("./signals-fanout.js");
    await handler({ Records: [makeInsertRecord("SOL/USDT")] } as any, {} as any, () => {});

    expect(postToConnectionMock).not.toHaveBeenCalled();
  });

  it("deletes stale connection on GoneException and continues", async () => {
    ddbSend
      .mockResolvedValueOnce({
        // scan result
        Items: [
          { connectionId: "conn-stale", userId: "u1", subscribedPairs: ["BTC/USDT"] },
          { connectionId: "conn-alive", userId: "u2", subscribedPairs: ["BTC/USDT"] },
        ],
        LastEvaluatedKey: undefined,
      })
      .mockResolvedValueOnce({}); // DeleteCommand for stale

    postToConnectionMock
      .mockRejectedValueOnce(new GoneExceptionMock()) // conn-stale is gone
      .mockResolvedValueOnce({}); // conn-alive succeeds

    const { handler } = await import("./signals-fanout.js");
    await handler({ Records: [makeInsertRecord("BTC/USDT")] } as any, {} as any, () => {});

    expect(postToConnectionMock).toHaveBeenCalledTimes(2);

    // DeleteCommand should have been called for the stale connection
    const deleteCalls = ddbSend.mock.calls.filter((c) => c[0].__cmd === "Delete");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0].input.Key.connectionId).toBe("conn-stale");
  });

  it("continues processing on non-Gone postToConnection errors", async () => {
    ddbSend.mockResolvedValue({
      Items: [
        { connectionId: "conn-err", userId: "u1", subscribedPairs: ["ETH/USDT"] },
        { connectionId: "conn-ok", userId: "u2", subscribedPairs: ["ETH/USDT"] },
      ],
      LastEvaluatedKey: undefined,
    });
    postToConnectionMock
      .mockRejectedValueOnce(new Error("Network error")) // non-Gone
      .mockResolvedValueOnce({});

    const { handler } = await import("./signals-fanout.js");
    // Should not throw
    await handler({ Records: [makeInsertRecord("ETH/USDT")] } as any, {} as any, () => {});

    expect(postToConnectionMock).toHaveBeenCalledTimes(2);
    // No delete for non-Gone
    const deleteCalls = ddbSend.mock.calls.filter((c) => c[0].__cmd === "Delete");
    expect(deleteCalls).toHaveLength(0);
  });

  it("processes multiple records in a batch", async () => {
    ddbSend.mockResolvedValue({
      Items: [{ connectionId: "conn-1", userId: "u1", subscribedPairs: ["BTC/USDT"] }],
      LastEvaluatedKey: undefined,
    });
    postToConnectionMock.mockResolvedValue({});

    const { handler } = await import("./signals-fanout.js");
    await handler(
      {
        Records: [makeInsertRecord("BTC/USDT"), makeInsertRecord("BTC/USDT")],
      } as any,
      {} as any,
      () => {},
    );

    // One scan + one push per record = 2 scan calls, 2 push calls
    expect(postToConnectionMock).toHaveBeenCalledTimes(2);
  });
});
