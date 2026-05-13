/**
 * outcome-handler.test.ts
 *
 * Regression tests for the queryExpiredSignals function inside outcome-handler.ts.
 *
 * Key regression: the original code used QueryCommand with an invalid
 * KeyConditionExpression and an empty ExpressionAttributeValues: {} — DynamoDB
 * rejects an empty EAV map, causing a 100% failure rate on every invocation.
 * The fix replaces QueryCommand with ScanCommand (as the author's own comment
 * intended), dropping all the invalid / unused fields.
 *
 * Tests here assert:
 *   1. ScanCommand (not QueryCommand) is issued when the handler looks for expired signals.
 *   2. No ExpressionAttributeValues is included in the DynamoDB call.
 *   3. The in-process filter still correctly gates on expiresAt < now and outcomeStatus.
 *   4. The handler exits early (no further DDB writes) when there are no expired signals.
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
  // QueryCommand must NOT be imported by outcome-handler — keep it here only so
  // the mock module is complete and doesn't throw on unexpected imports.
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  UpdateCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Update", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
}));

// ---------------------------------------------------------------------------
// Deep-dependency mocks (prevent real AWS / candle / outcome-store calls)
// ---------------------------------------------------------------------------

const putOutcomeMock = vi.fn();
const fanOutMock = vi.fn();
const queryOutcomesByPairTimeframeMock = vi.fn();
const putAccuracyAggregateMock = vi.fn();
const putRuleAttributionMock = vi.fn();
const queryOutcomesByRuleMock = vi.fn();

vi.mock("./lib/outcome-store.js", () => ({
  putOutcome: putOutcomeMock,
  fanOutToRuleAttributionGSI: fanOutMock,
  queryOutcomesByPairTimeframe: queryOutcomesByPairTimeframeMock,
  putAccuracyAggregate: putAccuracyAggregateMock,
  putRuleAttribution: putRuleAttributionMock,
  queryOutcomesByRule: queryOutcomesByRuleMock,
}));

vi.mock("./lib/candle-store.js", () => ({
  getCandles: vi.fn().mockResolvedValue([]),
}));

vi.mock("./lib/canonicalize.js", () => ({
  canonicalizeCandle: vi.fn().mockReturnValue(null),
}));

vi.mock("./outcomes/resolver.js", () => ({
  resolveOutcome: vi.fn().mockReturnValue({
    signalId: "sig1",
    pair: "BTC/USDT",
    emittingTimeframe: "1h",
    outcome: "win",
    invalidatedExcluded: false,
    priceMovePct: 0.02,
    thresholdUsed: 0.01,
  }),
}));

vi.mock("./outcomes/aggregate.js", () => ({
  buildAccuracyAggregate: vi.fn().mockReturnValue({}),
}));

vi.mock("./outcomes/attribution.js", () => ({
  buildRuleAttribution: vi.fn().mockReturnValue({}),
  getAffectedAttributionKeys: vi.fn().mockReturnValue([]),
}));

vi.mock("./exchanges/config.js", () => ({
  EXCHANGES: ["binance", "kraken"],
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  putOutcomeMock.mockReset();
  fanOutMock.mockReset();
  queryOutcomesByPairTimeframeMock.mockReset();
  putAccuracyAggregateMock.mockReset();
  putRuleAttributionMock.mockReset();
  queryOutcomesByRuleMock.mockReset();

  putOutcomeMock.mockResolvedValue(undefined);
  fanOutMock.mockResolvedValue(undefined);
  queryOutcomesByPairTimeframeMock.mockResolvedValue([]);
  putAccuracyAggregateMock.mockResolvedValue(undefined);
  putRuleAttributionMock.mockResolvedValue(undefined);
  queryOutcomesByRuleMock.mockResolvedValue([]);
});

async function loadHandler() {
  const mod = await import("./outcome-handler.js");
  return mod.handler;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal signals-v2 item that looks expired and pending. */
function makeExpiredSignalItem(overrides: Record<string, unknown> = {}) {
  return {
    signalId: "sig-001",
    pair: "BTC/USDT",
    type: "LONG",
    confidence: 0.8,
    emittedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z", // in the past relative to "now" used in tests
    priceAtSignal: 50000,
    atrPctAtSignal: 0.02,
    gateReason: null,
    rulesFired: ["rsi_oversold"],
    emittingTimeframe: "1h",
    invalidatedAt: null,
    outcomeStatus: "pending",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Regression: ScanCommand is used (not QueryCommand)
// ---------------------------------------------------------------------------

describe("queryExpiredSignals: uses ScanCommand, not QueryCommand", () => {
  it("issues a ScanCommand to the signals-v2 table", async () => {
    // No expired signals — we just want to verify the DDB call shape.
    send.mockResolvedValue({ Items: [] });

    const handler = await loadHandler();
    await handler({});

    // At least one send() call should have been a Scan, not a Query.
    const calls = send.mock.calls.map((c) => (c[0] as { __cmd: string }).__cmd);
    expect(calls).toContain("Scan");
    expect(calls).not.toContain("Query");
  });

  it("does not include ExpressionAttributeValues in the ScanCommand input", async () => {
    send.mockResolvedValue({ Items: [] });

    const handler = await loadHandler();
    await handler({});

    const scanCalls = send.mock.calls.filter((c) => (c[0] as { __cmd: string }).__cmd === "Scan");
    expect(scanCalls.length).toBeGreaterThan(0);

    for (const [cmd] of scanCalls) {
      const input = (cmd as { input: Record<string, unknown> }).input;
      // The original bug: DynamoDB rejects ExpressionAttributeValues: {}
      expect(input).not.toHaveProperty("ExpressionAttributeValues");
      // Also confirm these invalid QueryCommand-only fields are absent.
      expect(input).not.toHaveProperty("KeyConditionExpression");
      expect(input).not.toHaveProperty("ExpressionAttributeNames");
    }
  });
});

// ---------------------------------------------------------------------------
// In-process filter: only expired + pending items are resolved
// ---------------------------------------------------------------------------

describe("queryExpiredSignals: in-process filter", () => {
  it("skips items where expiresAt >= now (not yet expired)", async () => {
    const futureItem = makeExpiredSignalItem({
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    send.mockResolvedValue({ Items: [futureItem] });

    const handler = await loadHandler();
    await handler({ "detail-type": "test" });

    // No outcomes should be written — the signal is not expired.
    expect(putOutcomeMock).not.toHaveBeenCalled();
  });

  it("skips items where outcomeStatus is already resolved (not pending)", async () => {
    const resolvedItem = makeExpiredSignalItem({
      expiresAt: "2026-01-01T00:00:00.000Z",
      outcomeStatus: "resolved",
    });
    send.mockResolvedValue({ Items: [resolvedItem] });

    const handler = await loadHandler();
    await handler({});

    expect(putOutcomeMock).not.toHaveBeenCalled();
  });

  it("processes an expired pending item (outcomeStatus = 'pending')", async () => {
    const expiredItem = makeExpiredSignalItem({
      expiresAt: "2026-01-01T00:00:00.000Z",
      invalidatedAt: "2026-01-01T00:30:00.000Z", // invalidated — simpler path, no price lookup
    });
    send.mockResolvedValue({ Items: [expiredItem] });

    const handler = await loadHandler();
    await handler({});

    // The invalidated path calls putOutcome.
    expect(putOutcomeMock).toHaveBeenCalledOnce();
  });

  it("processes items where outcomeStatus is absent (treated as pending)", async () => {
    const itemWithoutStatus = makeExpiredSignalItem({
      expiresAt: "2026-01-01T00:00:00.000Z",
      outcomeStatus: undefined,
      invalidatedAt: "2026-01-01T00:30:00.000Z",
    });
    // Remove outcomeStatus from the object entirely.
    delete (itemWithoutStatus as Record<string, unknown>)["outcomeStatus"];

    send.mockResolvedValue({ Items: [itemWithoutStatus] });

    const handler = await loadHandler();
    await handler({});

    expect(putOutcomeMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Early exit: no expired signals → no further DDB writes
// ---------------------------------------------------------------------------

describe("handler: early exit when no expired signals", () => {
  it("returns without writing outcomes when the scan returns nothing", async () => {
    send.mockResolvedValue({ Items: [] });

    const handler = await loadHandler();
    await handler({});

    expect(putOutcomeMock).not.toHaveBeenCalled();
    expect(fanOutMock).not.toHaveBeenCalled();
    expect(putAccuracyAggregateMock).not.toHaveBeenCalled();
    expect(putRuleAttributionMock).not.toHaveBeenCalled();
  });
});
