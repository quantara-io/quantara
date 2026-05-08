/**
 * fear-greed.test.ts
 *
 * Tests for the extended fetchFearGreedIndex (history writer) and pruneHistory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HISTORY_LIMIT } from "./fear-greed.js";

// ---- SDK mocks ----
// vi.mock is hoisted to the top of the file, so module-scope variables are not
// yet initialised when the factory runs. Use vi.fn() inline inside the factory
// and expose via the module's own interface instead.

const ddbSendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({
      // Delegate to the module-level mock via a closure-compatible approach:
      // vitest hoists vi.mock but the factory closes over mocked module exports,
      // not over module-scope variables. We use a wrapper function here.
      send: (...args: unknown[]) => ddbSendMock(...args),
    }),
  },
  GetCommand: vi.fn().mockImplementation((input) => input),
  UpdateCommand: vi.fn().mockImplementation((input) => input),
}));

beforeEach(() => {
  vi.resetModules();
  ddbSendMock.mockReset();
});

// ---- pruneHistory tests ----

describe("pruneHistory", () => {
  it("does nothing when history is within the limit", async () => {
    // Return a history with exactly HISTORY_LIMIT entries
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        history: Array.from({ length: HISTORY_LIMIT }, (_, i) => ({
          value: i,
          classification: "Neutral",
          timestamp: new Date(Date.now() - i * 3600 * 1000).toISOString(),
        })),
      },
    });

    const { pruneHistory } = await import("./fear-greed.js");
    await pruneHistory();

    // GetCommand only — no UpdateCommand should be issued
    expect(ddbSendMock).toHaveBeenCalledTimes(1);
  });

  it("issues a REMOVE expression when history exceeds HISTORY_LIMIT", async () => {
    const excess = 3;
    ddbSendMock.mockResolvedValueOnce({
      Item: {
        history: Array.from({ length: HISTORY_LIMIT + excess }, (_, i) => ({
          value: i,
          classification: "Neutral",
          timestamp: new Date(Date.now() - i * 3600 * 1000).toISOString(),
        })),
      },
    });
    ddbSendMock.mockResolvedValueOnce({}); // UpdateCommand

    const { pruneHistory } = await import("./fear-greed.js");
    await pruneHistory();

    expect(ddbSendMock).toHaveBeenCalledTimes(2);
    const updateCall = ddbSendMock.mock.calls[1][0];
    expect(updateCall.UpdateExpression).toContain("REMOVE");
    // Should remove history[0], history[1], history[2]
    expect(updateCall.UpdateExpression).toContain("history[0]");
    expect(updateCall.UpdateExpression).toContain("history[2]");
    expect(updateCall.UpdateExpression).not.toContain("history[3]");
  });

  it("handles missing history gracefully (no update needed)", async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: null });

    const { pruneHistory } = await import("./fear-greed.js");
    await pruneHistory();

    // Only the GetCommand; no UpdateCommand
    expect(ddbSendMock).toHaveBeenCalledTimes(1);
  });
});

// ---- HISTORY_LIMIT constant ----

describe("HISTORY_LIMIT", () => {
  it("equals 48 (2 days at hourly cadence)", () => {
    expect(HISTORY_LIMIT).toBe(48);
  });
});
