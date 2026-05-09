/**
 * Tests for pipeline-events-store.ts
 *
 * Covers:
 *   - emitPipelineEvent: writes a well-formed DDB item including eventId, ts, ttl, and event fields
 *   - emitPipelineEventSafe: swallows errors, never propagates
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({ send: sendMock }),
  },
  PutCommand: vi.fn().mockImplementation((input) => input),
}));

// Stable UUID for deterministic assertions
vi.mock("node:crypto", () => ({
  default: {
    randomUUID: vi.fn().mockReturnValue("test-uuid-1234"),
  },
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
});

describe("emitPipelineEvent", () => {
  it("writes a DDB item with eventId, ts, ttl, and all event fields", async () => {
    sendMock.mockResolvedValue({});
    const { emitPipelineEvent } = await import("./pipeline-events-store.js");

    const event = {
      type: "signal-emitted" as const,
      pair: "BTC/USDT",
      timeframe: "1h",
      signalType: "buy" as const,
      confidence: 0.85,
      closeTime: "2025-01-01T00:00:00.000Z",
      ts: "2025-01-01T00:00:01.000Z",
    };

    await emitPipelineEvent(event);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.Item.eventId).toBe("test-uuid-1234");
    expect(call.Item.ts).toBe(event.ts);
    expect(call.Item.type).toBe("signal-emitted");
    expect(call.Item.pair).toBe("BTC/USDT");
    expect(call.Item.signalType).toBe("buy");
    expect(call.Item.confidence).toBe(0.85);
    expect(typeof call.Item.ttl).toBe("number");
    expect(call.Item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("uses the TABLE_PIPELINE_EVENTS env var as the table name", async () => {
    sendMock.mockResolvedValue({});
    process.env.TABLE_PIPELINE_EVENTS = "quantara-prod-pipeline-events";
    const { emitPipelineEvent } = await import("./pipeline-events-store.js");

    await emitPipelineEvent({
      type: "quorum-failed",
      pair: "ETH/USDT",
      timeframe: "15m",
      closeTime: "2025-01-01T00:00:00.000Z",
      ts: "2025-01-01T00:00:01.000Z",
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.TableName).toBe("quantara-prod-pipeline-events");

    delete process.env.TABLE_PIPELINE_EVENTS;
  });

  it("falls back to TABLE_PREFIX for the table name", async () => {
    sendMock.mockResolvedValue({});
    process.env.TABLE_PREFIX = "quantara-staging-";
    const { emitPipelineEvent } = await import("./pipeline-events-store.js");

    await emitPipelineEvent({
      type: "news-enriched",
      newsId: "n1",
      mentionedPairs: ["BTC/USDT"],
      sentimentScore: 0.4,
      sentimentMagnitude: 0.6,
      ts: "2025-01-01T00:00:01.000Z",
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.TableName).toBe("quantara-staging-pipeline-events");

    delete process.env.TABLE_PREFIX;
  });

  it("propagates DDB errors to the caller", async () => {
    sendMock.mockRejectedValue(new Error("DDB throttle"));
    const { emitPipelineEvent } = await import("./pipeline-events-store.js");

    await expect(
      emitPipelineEvent({
        type: "sentiment-shock-detected",
        pair: "SOL/USDT",
        deltaScore: 0.45,
        ts: "2025-01-01T00:00:01.000Z",
      }),
    ).rejects.toThrow("DDB throttle");
  });
});

describe("emitPipelineEventSafe", () => {
  it("does not throw when DDB write succeeds", async () => {
    sendMock.mockResolvedValue({});
    const { emitPipelineEventSafe } = await import("./pipeline-events-store.js");

    // Should not throw — void return
    expect(() =>
      emitPipelineEventSafe({
        type: "indicator-state-updated",
        pair: "BTC/USDT",
        timeframe: "4h",
        barsSinceStart: 100,
        rsi14: 55.3,
        ts: "2025-01-01T00:00:01.000Z",
      }),
    ).not.toThrow();
  });

  it("swallows DDB errors and does not propagate", async () => {
    sendMock.mockRejectedValue(new Error("DDB unavailable"));
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { emitPipelineEventSafe } = await import("./pipeline-events-store.js");

    // Fire the safe emit and give the microtask queue a turn to flush the catch handler.
    emitPipelineEventSafe({
      type: "ratification-fired",
      pair: "ETH/USDT",
      timeframe: "1h",
      triggerReason: "bar_close",
      verdict: "ratified",
      latencyMs: 230,
      costUsd: 0.001,
      cacheHit: false,
      ts: "2025-01-01T00:00:01.000Z",
    });

    // Allow the rejected promise to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("ratification-fired"),
    );

    consoleSpy.mockRestore();
  });
});
