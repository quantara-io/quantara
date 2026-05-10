/**
 * Tests for ws-connect-handler.ts
 *
 * Covers:
 *   - JWT validation (missing token, invalid token, valid token)
 *   - Pair parsing (no pairs = all pairs, valid pairs, unknown pair rejection)
 *   - DDB write on successful connect
 *   - 500 on DDB write failure
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
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
  DeleteCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Delete", input })),
}));

// ---------------------------------------------------------------------------
// jose mock
// ---------------------------------------------------------------------------

const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: vi.fn().mockReturnValue({ __jwks: true }),
}));

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  ddbSend.mockReset();
  jwtVerifyMock.mockReset();
  delete process.env.APP_ID;
  delete process.env.AUTH_BASE_URL;
  delete process.env.TABLE_CONNECTION_REGISTRY;
  delete process.env.TABLE_PREFIX;
});

// ---------------------------------------------------------------------------
// parsePairs unit tests
// ---------------------------------------------------------------------------

describe("parsePairs", () => {
  it("returns all PAIRS when input is undefined", async () => {
    const { parsePairs } = await import("./ws-connect-handler.js");
    const result = parsePairs(undefined);
    expect(result).toEqual(["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"]);
  });

  it("returns all PAIRS when input is empty string", async () => {
    const { parsePairs } = await import("./ws-connect-handler.js");
    const result = parsePairs("");
    expect(result).toEqual(["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"]);
  });

  it("returns a single valid pair", async () => {
    const { parsePairs } = await import("./ws-connect-handler.js");
    const result = parsePairs("BTC/USDT");
    expect(result).toEqual(["BTC/USDT"]);
  });

  it("returns multiple valid pairs", async () => {
    const { parsePairs } = await import("./ws-connect-handler.js");
    const result = parsePairs("BTC/USDT,ETH/USDT");
    expect(result).toEqual(["BTC/USDT", "ETH/USDT"]);
  });

  it("normalizes to uppercase", async () => {
    const { parsePairs } = await import("./ws-connect-handler.js");
    const result = parsePairs("btc/usdt");
    expect(result).toEqual(["BTC/USDT"]);
  });

  it("throws on an unknown pair", async () => {
    const { parsePairs } = await import("./ws-connect-handler.js");
    expect(() => parsePairs("BTC/USDT,FAKE/USDT")).toThrow("Unknown pairs");
  });
});

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

function makeEvent(queryParams: Record<string, string> = {}) {
  return {
    requestContext: {
      connectionId: "test-conn-id-123",
      routeKey: "$connect",
      eventType: "CONNECT",
      stage: "$default",
      requestId: "req-1",
      connectedAt: Date.now(),
      requestTimeEpoch: Date.now(),
      identity: {},
      domainName: "example.execute-api.us-west-2.amazonaws.com",
    },
    queryStringParameters: queryParams,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
  } as any;
}

describe("handler", () => {
  it("returns 401 when token query param is missing", async () => {
    const { handler } = await import("./ws-connect-handler.js");
    const res = await handler(makeEvent({}), {} as any, () => {});
    expect(res).toMatchObject({ statusCode: 401 });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it("returns 401 when JWT verification fails", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("bad signature"));
    const { handler } = await import("./ws-connect-handler.js");
    const res = await handler(makeEvent({ token: "bad.jwt.token" }), {} as any, () => {});
    expect(res).toMatchObject({ statusCode: 401 });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("returns 401 when JWT payload has no sub", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: undefined } });
    const { handler } = await import("./ws-connect-handler.js");
    const res = await handler(makeEvent({ token: "valid.jwt" }), {} as any, () => {});
    expect(res).toMatchObject({ statusCode: 401 });
  });

  it("returns 4001 when pairs are invalid", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_abc" } });
    const { handler } = await import("./ws-connect-handler.js");
    const res = await handler(
      makeEvent({ token: "valid.jwt", pairs: "FAKE/USDT" }),
      {} as any,
      () => {},
    );
    expect(res).toMatchObject({ statusCode: 4001 });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("returns 200 and writes DDB on successful connect with specific pairs", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_abc" } });
    ddbSend.mockResolvedValue({});

    const { handler } = await import("./ws-connect-handler.js");
    const res = await handler(
      makeEvent({ token: "valid.jwt", pairs: "BTC/USDT,ETH/USDT" }),
      {} as any,
      () => {},
    );

    expect(res).toMatchObject({ statusCode: 200 });
    expect(ddbSend).toHaveBeenCalledOnce();

    const putCall = ddbSend.mock.calls[0][0];
    expect(putCall.input.Item).toMatchObject({
      connectionId: "test-conn-id-123",
      userId: "user_abc",
      subscribedPairs: ["BTC/USDT", "ETH/USDT"],
    });
    // TTL should be ~2 hours from now
    expect(putCall.input.Item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns 200 and writes all pairs when no pairs param", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_xyz" } });
    ddbSend.mockResolvedValue({});

    const { handler } = await import("./ws-connect-handler.js");
    const res = await handler(makeEvent({ token: "valid.jwt" }), {} as any, () => {});

    expect(res).toMatchObject({ statusCode: 200 });
    const putCall = ddbSend.mock.calls[0][0];
    expect(putCall.input.Item.subscribedPairs).toHaveLength(5); // all PAIRS
  });

  it("returns 500 when DDB write fails", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_abc" } });
    ddbSend.mockRejectedValue(new Error("DDB error"));

    const { handler } = await import("./ws-connect-handler.js");
    const res = await handler(makeEvent({ token: "valid.jwt" }), {} as any, () => {});

    expect(res).toMatchObject({ statusCode: 500 });
  });

  // ---------------------------------------------------------------------------
  // Channel parsing (#184 — Live Activity Feed)
  // ---------------------------------------------------------------------------

  it("defaults channel to 'signals' when query param absent", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_a" } });
    ddbSend.mockResolvedValue({});

    const { handler } = await import("./ws-connect-handler.js");
    await handler(makeEvent({ token: "valid.jwt" }), {} as any, () => {});

    const putCall = ddbSend.mock.calls[0][0];
    expect(putCall.input.Item.channel).toBe("signals");
  });

  it("persists channel='events' when query param is 'events'", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_b" } });
    ddbSend.mockResolvedValue({});

    const { handler } = await import("./ws-connect-handler.js");
    await handler(makeEvent({ token: "valid.jwt", channel: "events" }), {} as any, () => {});

    const putCall = ddbSend.mock.calls[0][0];
    expect(putCall.input.Item.channel).toBe("events");
  });

  it("falls back to 'signals' for unknown channel values (no leakage to events)", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_c" } });
    ddbSend.mockResolvedValue({});

    const { handler } = await import("./ws-connect-handler.js");
    await handler(makeEvent({ token: "valid.jwt", channel: "garbage" }), {} as any, () => {});

    const putCall = ddbSend.mock.calls[0][0];
    expect(putCall.input.Item.channel).toBe("signals");
  });
});
