import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  SendMessageCommand: vi.fn().mockImplementation((input) => input),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
});

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue";

describe("publish", () => {
  it("sends a message to the correct QueueUrl", async () => {
    sendMock.mockResolvedValue({});
    const { publish } = await import("./sqs-publisher.js");
    await publish(QUEUE_URL, "NEWS_ITEM", { id: "abc" });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [arg] = sendMock.mock.calls[0];
    expect(arg.QueueUrl).toBe(QUEUE_URL);
  });

  it("sends a MessageBody with the correct envelope shape { type, data, timestamp }", async () => {
    sendMock.mockResolvedValue({});
    const { publish } = await import("./sqs-publisher.js");
    const payload = { id: "abc", price: 42 };
    await publish(QUEUE_URL, "PRICE_UPDATE", payload);

    const [arg] = sendMock.mock.calls[0];
    const body = JSON.parse(arg.MessageBody);
    expect(body.type).toBe("PRICE_UPDATE");
    expect(body.data).toEqual(payload);
    expect(typeof body.timestamp).toBe("string");
  });

  it("sets timestamp as an ISO-8601 string", async () => {
    sendMock.mockResolvedValue({});
    const { publish } = await import("./sqs-publisher.js");
    await publish(QUEUE_URL, "NEWS_ITEM", { foo: "bar" });

    const [arg] = sendMock.mock.calls[0];
    const body = JSON.parse(arg.MessageBody);
    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("propagates errors when the SQS client rejects", async () => {
    sendMock.mockRejectedValue(new Error("SQS unavailable"));
    const { publish } = await import("./sqs-publisher.js");
    await expect(publish(QUEUE_URL, "NEWS_ITEM", {})).rejects.toThrow("SQS unavailable");
  });
});
