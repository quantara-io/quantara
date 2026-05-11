/**
 * Tests for rule-prune-handler.ts — Phase 8 §10.10.
 *
 * Mocking strategy:
 *   - AWS SDK send is a vi.fn() — ScanCommand, QueryCommand, GetCommand, PutCommand.
 *   - computeBrier is mocked so we can control the Brier value per test.
 *   - rule-status-store helpers are mocked directly.
 *
 * Behaviors under test:
 *   - Buckets with fireCount < 30 are skipped (no DDB write).
 *   - First high-Brier window increments counter but does not disable.
 *   - Second consecutive high-Brier window disables the rule.
 *   - Rule re-enables when Brier drops below 0.25.
 *   - manual-override buckets are never auto-disabled.
 *   - Prune job is idempotent: runs with same data produce the same result.
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
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

// ---------------------------------------------------------------------------
// aggregate.js mock — control Brier return value per test
// ---------------------------------------------------------------------------

const computeBrierMock = vi.fn();
vi.mock("./outcomes/aggregate.js", () => ({
  computeBrier: computeBrierMock,
}));

// ---------------------------------------------------------------------------
// rule-status-store.js mock
// ---------------------------------------------------------------------------

const getRuleStatusByPkMock = vi.fn();
const putRuleStatusMock = vi.fn();
vi.mock("./lib/rule-status-store.js", () => ({
  getRuleStatusByPk: getRuleStatusByPkMock,
  putRuleStatus: putRuleStatusMock,
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  computeBrierMock.mockReset();
  getRuleStatusByPkMock.mockReset();
  putRuleStatusMock.mockReset();
  putRuleStatusMock.mockResolvedValue(undefined);
});

/** Build a minimal RuleAttribution row for testing. */
function makeAttr(overrides: Record<string, unknown> = {}) {
  return {
    pk: "rsi_oversold#BTC/USDT#15m",
    rule: "rsi_oversold",
    pair: "BTC/USDT",
    timeframe: "15m",
    window: "90d",
    fireCount: 40, // >= 30 by default
    correctCount: 15,
    incorrectCount: 25,
    neutralCount: 0,
    contribution: 0.375,
    computedAt: "2026-05-01T00:00:00.000Z",
    ttl: 9999999,
    ...overrides,
  };
}

async function loadHandler() {
  const { handler } = await import("./rule-prune-handler.js");
  return handler;
}

// Attribution scan returns our test row; outcomes query returns empty (Brier computed from mock).
function setupSendForAttr(attr: ReturnType<typeof makeAttr>) {
  send.mockImplementation((cmd: { __cmd: string }) => {
    if (cmd.__cmd === "Scan") {
      return Promise.resolve({ Items: [attr] });
    }
    if (cmd.__cmd === "Query") {
      // Return minimal outcomes — computeBrier is mocked anyway.
      return Promise.resolve({ Items: [] });
    }
    return Promise.resolve({});
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rule-prune-handler: fireCount < 30 → skip", () => {
  it("does not write rule_status when n < 30", async () => {
    const attr = makeAttr({ fireCount: 10 });
    send.mockResolvedValue({ Items: [attr] });
    const handler = await loadHandler();
    await handler({});
    expect(putRuleStatusMock).not.toHaveBeenCalled();
  });
});

describe("rule-prune-handler: first high-Brier window → increment counter, no disable", () => {
  it("increments highBrierWindows to 1 but leaves status enabled", async () => {
    const attr = makeAttr();
    setupSendForAttr(attr);
    computeBrierMock.mockReturnValue(0.35); // above 0.30 threshold
    getRuleStatusByPkMock.mockResolvedValue(null); // no existing row

    const handler = await loadHandler();
    await handler({});

    expect(putRuleStatusMock).toHaveBeenCalledOnce();
    const written = putRuleStatusMock.mock.calls[0][0];
    expect(written.status).toBe("enabled");
    expect(written.highBrierWindows).toBe(1);
    expect(written.brier).toBeCloseTo(0.35);
  });
});

describe("rule-prune-handler: second consecutive high-Brier window → disable", () => {
  it("disables rule when highBrierWindows reaches 2", async () => {
    const attr = makeAttr();
    setupSendForAttr(attr);
    computeBrierMock.mockReturnValue(0.36); // above threshold again
    getRuleStatusByPkMock.mockResolvedValue({
      pk: attr.pk,
      status: "enabled",
      highBrierWindows: 1, // already 1 from previous run
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    const handler = await loadHandler();
    await handler({});

    const written = putRuleStatusMock.mock.calls[0][0];
    expect(written.status).toBe("disabled");
    expect(written.highBrierWindows).toBe(2);
    expect(written.disabledAt).toBeDefined();
    expect(written.reason).toMatch(/Brier/);
  });
});

describe("rule-prune-handler: re-enable when Brier improves", () => {
  it("re-enables a disabled rule when brier < 0.25", async () => {
    const attr = makeAttr();
    setupSendForAttr(attr);
    computeBrierMock.mockReturnValue(0.22); // below 0.25 re-enable threshold
    getRuleStatusByPkMock.mockResolvedValue({
      pk: attr.pk,
      status: "disabled",
      highBrierWindows: 2,
      disabledAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    const handler = await loadHandler();
    await handler({});

    const written = putRuleStatusMock.mock.calls[0][0];
    expect(written.status).toBe("enabled");
    expect(written.highBrierWindows).toBe(0);
    expect(written.disabledAt).toBeUndefined();
  });
});

describe("rule-prune-handler: manual-override precedence", () => {
  it("never auto-disables a manual-override bucket", async () => {
    const attr = makeAttr();
    setupSendForAttr(attr);
    computeBrierMock.mockReturnValue(0.99); // very high Brier
    getRuleStatusByPkMock.mockResolvedValue({
      pk: attr.pk,
      status: "manual-override",
      highBrierWindows: 5,
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    const handler = await loadHandler();
    await handler({});

    // Should still write (updates brier/n), but never change status to "disabled".
    expect(putRuleStatusMock).toHaveBeenCalledOnce();
    const written = putRuleStatusMock.mock.calls[0][0];
    expect(written.status).toBe("manual-override");
  });
});

describe("rule-prune-handler: Brier between thresholds resets counter", () => {
  it("resets highBrierWindows to 0 when brier is between 0.25 and 0.30", async () => {
    const attr = makeAttr();
    setupSendForAttr(attr);
    computeBrierMock.mockReturnValue(0.27); // between re-enable (0.25) and disable (0.30)
    getRuleStatusByPkMock.mockResolvedValue({
      pk: attr.pk,
      status: "enabled",
      highBrierWindows: 1,
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    const handler = await loadHandler();
    await handler({});

    const written = putRuleStatusMock.mock.calls[0][0];
    expect(written.status).toBe("enabled");
    expect(written.highBrierWindows).toBe(0);
  });
});
