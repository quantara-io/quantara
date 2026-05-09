/**
 * Tests for close-quorum-monitor.ts — v6 P2 §11.5.
 *
 * Verifies:
 *   - REMOVE events trigger a signals-v2 lookup.
 *   - Non-REMOVE events are skipped.
 *   - If signal exists → no metric emitted.
 *   - If signal absent → EMF metric written to stdout and warning logged.
 *   - Malformed id fields are handled gracefully.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DynamoDBStreamEvent } from "aws-lambda";

// ---------------------------------------------------------------------------
// AWS SDK mocks
// ---------------------------------------------------------------------------

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
}));

// @aws-sdk/util-dynamodb — return OldImage as-is (already plain object in tests)
vi.mock("@aws-sdk/util-dynamodb", () => ({
  unmarshall: vi.fn().mockImplementation((img) => img),
}));

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const TEST_PAIR = "BTC/USDT";
const TEST_TF = "15m";
const TEST_CLOSE_TIME = 1715187600000;
const TEST_ID = `${TEST_PAIR}#${TEST_TF}#${TEST_CLOSE_TIME}`;

function makeRemoveEvent(overrides: Record<string, unknown> = {}): DynamoDBStreamEvent {
  return {
    Records: [
      {
        eventName: "REMOVE",
        eventSource: "aws:dynamodb",
        eventVersion: "1.1",
        eventID: "abc123",
        awsRegion: "us-east-1",
        dynamodb: {
          OldImage: {
            id: TEST_ID,
            exchanges: new Set(["binanceus", "coinbase"]),
            ttl: Math.floor(TEST_CLOSE_TIME / 1000) + 86_400,
            ...overrides,
          },
          SequenceNumber: "1",
          SizeBytes: 100,
          StreamViewType: "NEW_AND_OLD_IMAGES",
        },
        eventSourceARN: "arn:aws:dynamodb:us-east-1:123:table/test-close-quorum/stream/x",
      },
    ],
  } as unknown as DynamoDBStreamEvent;
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_SIGNALS_V2 = "test-signals-v2";
  process.env.CW_NAMESPACE = "Quantara/Test";
});

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------

describe("event filtering", () => {
  it("skips INSERT events", async () => {
    const event = makeRemoveEvent();
    event.Records[0]!.eventName = "INSERT";

    const { handler } = await import("./close-quorum-monitor.js");
    await handler(event, {} as any, () => {});

    expect(send).not.toHaveBeenCalled();
  });

  it("skips MODIFY events", async () => {
    const event = makeRemoveEvent();
    event.Records[0]!.eventName = "MODIFY";

    const { handler } = await import("./close-quorum-monitor.js");
    await handler(event, {} as any, () => {});

    expect(send).not.toHaveBeenCalled();
  });

  it("processes REMOVE events", async () => {
    send.mockResolvedValue({ Item: { pair: TEST_PAIR, sk: `${TEST_TF}#${TEST_CLOSE_TIME}` } });

    const { handler } = await import("./close-quorum-monitor.js");
    await handler(makeRemoveEvent(), {} as any, () => {});

    expect(send).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// signals-v2 lookup
// ---------------------------------------------------------------------------

describe("signals-v2 lookup", () => {
  it("checks signals-v2 with PK=pair SK=tf#closeTime", async () => {
    send.mockResolvedValue({ Item: { pair: TEST_PAIR, sk: `${TEST_TF}#${TEST_CLOSE_TIME}` } });

    const { handler } = await import("./close-quorum-monitor.js");
    await handler(makeRemoveEvent(), {} as any, () => {});

    const getCall = send.mock.calls.find((c) => c[0]?.__cmd === "Get");
    expect(getCall).toBeDefined();

    const input = getCall![0].input;
    expect(input.TableName).toBe("test-signals-v2");
    expect(input.Key.pair).toBe(TEST_PAIR);
    expect(input.Key.sk).toBe(`${TEST_TF}#${TEST_CLOSE_TIME}`);
  });

  it("does not emit metric when signal exists in signals-v2", async () => {
    send.mockResolvedValue({ Item: { pair: TEST_PAIR, sk: `${TEST_TF}#${TEST_CLOSE_TIME}` } });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { handler } = await import("./close-quorum-monitor.js");
    await handler(makeRemoveEvent(), {} as any, () => {});

    // No EMF metric should have been written to stdout
    const emfCalls = stdoutSpy.mock.calls.filter((c) => {
      const str = c[0] as string;
      return typeof str === "string" && str.includes("CloseMissed");
    });
    expect(emfCalls.length).toBe(0);

    stdoutSpy.mockRestore();
  });

  it("emits CloseMissed EMF metric when signal is absent from signals-v2", async () => {
    send.mockResolvedValue({ Item: undefined });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { handler } = await import("./close-quorum-monitor.js");
    await handler(makeRemoveEvent(), {} as any, () => {});

    // EMF metric should have been written to stdout
    const emfCalls = stdoutSpy.mock.calls.filter((c) => {
      const str = c[0] as string;
      return typeof str === "string" && str.includes("CloseMissed");
    });
    expect(emfCalls.length).toBe(1);

    const emfObj = JSON.parse(emfCalls[0]![0] as string);
    expect(emfObj.pair).toBe(TEST_PAIR);
    expect(emfObj.timeframe).toBe(TEST_TF);
    expect(emfObj.CloseMissed).toBe(1);
    expect(emfObj._aws.CloudWatchMetrics[0].Namespace).toBe("Quantara/Test");

    stdoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Malformed id handling
// ---------------------------------------------------------------------------

describe("malformed id handling", () => {
  it("skips records without id in OldImage", async () => {
    const event = makeRemoveEvent({ id: undefined });

    const { handler } = await import("./close-quorum-monitor.js");
    await handler(event, {} as any, () => {});

    expect(send).not.toHaveBeenCalled();
  });

  it("skips records with too-short id (fewer than 3 parts)", async () => {
    const event = makeRemoveEvent({ id: "BTC/USDT#15m" }); // missing closeTime

    const { handler } = await import("./close-quorum-monitor.js");
    await handler(event, {} as any, () => {});

    expect(send).not.toHaveBeenCalled();
  });

  it("handles DDB errors gracefully without rethrowing", async () => {
    send.mockRejectedValue(new Error("DDB unavailable"));

    const { handler } = await import("./close-quorum-monitor.js");
    // Must not throw — monitor is observability-only
    await expect(handler(makeRemoveEvent(), {} as any, () => {})).resolves.toBeUndefined();
  });
});
