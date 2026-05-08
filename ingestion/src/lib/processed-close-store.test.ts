/**
 * Tests for processed-close-store.ts — idempotency marker helper.
 *
 * Verifies:
 *   - First claim returns true (work should proceed).
 *   - Conditional Put failure (ConditionalCheckFailedException) returns false (skip).
 *   - Other DDB errors are re-thrown.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// AWS SDK mocks
// ---------------------------------------------------------------------------

const sendMock = vi.fn();

// We define a minimal ConditionalCheckFailedException stand-in that satisfies the
// `instanceof` check in processed-close-store.ts without needing the full AWS SDK
// exception type (which requires $metadata).
class ConditionalCheckFailedException extends Error {
  constructor(message = "The conditional request failed") {
    super(message);
    this.name = "ConditionalCheckFailedException";
  }
}

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
  ConditionalCheckFailedException,
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: sendMock }) },
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
});

describe("tryClaimProcessedClose", () => {
  it("returns true when the conditional Put succeeds (marker did not exist)", async () => {
    sendMock.mockResolvedValue({});

    const { tryClaimProcessedClose } = await import("./processed-close-store.js");
    const result = await tryClaimProcessedClose("BTC/USDT", "15m", 1700000900000);

    expect(result).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Verify the PutCommand was called with attribute_not_exists condition.
    const putArg = sendMock.mock.calls[0]![0] as { __cmd: string; input: Record<string, unknown> };
    expect(putArg.__cmd).toBe("Put");
    expect(putArg.input.ConditionExpression).toBe("attribute_not_exists(metaKey)");
  });

  it("returns false when ConditionalCheckFailedException is thrown (marker already exists)", async () => {
    sendMock.mockRejectedValue(
      new ConditionalCheckFailedException("The conditional request failed"),
    );

    const { tryClaimProcessedClose } = await import("./processed-close-store.js");
    const result = await tryClaimProcessedClose("BTC/USDT", "15m", 1700000900000);

    expect(result).toBe(false);
  });

  it("re-throws non-conditional DDB errors", async () => {
    sendMock.mockRejectedValue(new Error("ProvisionedThroughputExceededException"));

    const { tryClaimProcessedClose } = await import("./processed-close-store.js");

    await expect(tryClaimProcessedClose("BTC/USDT", "15m", 1700000900000)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });

  it("uses TABLE_METADATA env var when set", async () => {
    process.env.TABLE_METADATA = "my-custom-metadata-table";
    sendMock.mockResolvedValue({});

    const { tryClaimProcessedClose } = await import("./processed-close-store.js");
    await tryClaimProcessedClose("ETH/USDT", "1h", 1700001000000);

    const putArg = sendMock.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(putArg.input.TableName).toBe("my-custom-metadata-table");

    delete process.env.TABLE_METADATA;
  });

  it("encodes pair, timeframe, and ISO close time into the marker key", async () => {
    sendMock.mockResolvedValue({});

    const { tryClaimProcessedClose } = await import("./processed-close-store.js");
    const lastClose = 1700000900000;
    await tryClaimProcessedClose("SOL/USDT", "4h", lastClose);

    const putArg = sendMock.mock.calls[0]![0] as { input: { Item: Record<string, unknown> } };
    const expectedISO = new Date(lastClose).toISOString();
    expect(putArg.input.Item["metaKey"]).toBe(`processed-close#SOL/USDT#4h#${expectedISO}`);
  });
});
