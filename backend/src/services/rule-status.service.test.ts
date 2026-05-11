/**
 * Tests for rule-status.service.ts — Phase 8 §10.10.
 *
 * Mocking strategy:
 *   - AWS SDK send is a vi.fn() — ScanCommand, GetCommand, PutCommand.
 *
 * Behaviors under test:
 *   - listRuleStatuses returns all items from a Scan.
 *   - getRuleStatusByPk returns null when item not found.
 *   - setManualOverride preserves existing brier/n from a prior prune run.
 *   - setManualOverride with status="enabled" clears override metadata.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// AWS SDK mocks
// ---------------------------------------------------------------------------

const send = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  ScanCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Scan", input })),
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
});

async function loadService() {
  return await import("./rule-status.service.js");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listRuleStatuses", () => {
  it("returns all items from a single-page Scan", async () => {
    const items = [
      { pk: "rsi_oversold#BTC/USDT#15m", status: "enabled", updatedAt: "2026-05-01T00:00:00Z" },
      { pk: "macd_cross_bull#ETH/USDT#1h", status: "disabled", updatedAt: "2026-05-01T00:00:00Z" },
    ];
    send.mockResolvedValue({ Items: items, LastEvaluatedKey: undefined });

    const { listRuleStatuses } = await loadService();
    const result = await listRuleStatuses();
    expect(result).toHaveLength(2);
    expect(result[0].pk).toBe("rsi_oversold#BTC/USDT#15m");
    expect(result[1].status).toBe("disabled");
  });

  it("handles paginated Scan (two pages)", async () => {
    const page1 = [
      { pk: "rule-a#BTC/USDT#1h", status: "enabled", updatedAt: "2026-05-01T00:00:00Z" },
    ];
    const page2 = [
      { pk: "rule-b#ETH/USDT#4h", status: "manual-override", updatedAt: "2026-05-01T00:00:00Z" },
    ];
    send
      .mockResolvedValueOnce({ Items: page1, LastEvaluatedKey: { pk: "rule-a#BTC/USDT#1h" } })
      .mockResolvedValueOnce({ Items: page2, LastEvaluatedKey: undefined });

    const { listRuleStatuses } = await loadService();
    const result = await listRuleStatuses();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.pk)).toEqual(["rule-a#BTC/USDT#1h", "rule-b#ETH/USDT#4h"]);
  });

  it("returns empty array when table has no rows", async () => {
    send.mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
    const { listRuleStatuses } = await loadService();
    expect(await listRuleStatuses()).toEqual([]);
  });
});

describe("getRuleStatusByPk", () => {
  it("returns the item when found", async () => {
    const item = {
      pk: "rsi_oversold#BTC/USDT#15m",
      status: "disabled",
      brier: 0.35,
      n: 42,
      updatedAt: "2026-05-01T00:00:00Z",
    };
    send.mockResolvedValue({ Item: item });

    const { getRuleStatusByPk } = await loadService();
    const result = await getRuleStatusByPk("rsi_oversold#BTC/USDT#15m");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("disabled");
    expect(result!.brier).toBeCloseTo(0.35);
  });

  it("returns null when item not found", async () => {
    send.mockResolvedValue({ Item: undefined });

    const { getRuleStatusByPk } = await loadService();
    const result = await getRuleStatusByPk("nonexistent#BTC/USDT#1h");
    expect(result).toBeNull();
  });
});

describe("setManualOverride", () => {
  it("preserves existing brier and n from a prior prune run", async () => {
    const existing = {
      pk: "rsi_oversold#BTC/USDT#15m",
      status: "enabled",
      brier: 0.33,
      n: 45,
      highBrierWindows: 1,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    // GetCommand returns the existing row; PutCommand succeeds.
    send
      .mockResolvedValueOnce({ Item: existing }) // Get
      .mockResolvedValueOnce({}); // Put

    const { setManualOverride } = await loadService();
    const result = await setManualOverride({
      pk: "rsi_oversold#BTC/USDT#15m",
      status: "manual-override",
      reason: "Investigating a market regime change",
      updatedBy: "admin_user_1",
    });

    expect(result.status).toBe("manual-override");
    expect(result.brier).toBeCloseTo(0.33); // preserved from existing
    expect(result.n).toBe(45);
    expect(result.highBrierWindows).toBe(1);

    // Verify PutCommand was called with the correct item.
    const putCall = send.mock.calls[1][0];
    expect(putCall.input.Item.status).toBe("manual-override");
    expect(putCall.input.Item.reason).toBe("Investigating a market regime change");
    expect(putCall.input.Item.updatedBy).toBe("admin_user_1");
  });

  it("works when no existing row is found (new override on a fresh bucket)", async () => {
    send
      .mockResolvedValueOnce({ Item: undefined }) // Get → not found
      .mockResolvedValueOnce({}); // Put

    const { setManualOverride } = await loadService();
    const result = await setManualOverride({
      pk: "new_rule#BTC/USDT#4h",
      status: "manual-override",
      manualOverrideUntil: "2026-07-01T00:00:00Z",
      updatedBy: "admin_user_2",
    });

    expect(result.status).toBe("manual-override");
    expect(result.manualOverrideUntil).toBe("2026-07-01T00:00:00Z");
    // No brier or n since no existing row.
    expect(result.brier).toBeUndefined();
    expect(result.n).toBeUndefined();
  });
});
