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
    sk: "2026-01-01T00:00:00.000Z#sig-001",
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

// ---------------------------------------------------------------------------
// Phase 8 (#356): resolvable-path regression test
//
// Before #356, signals-v2 rows were missing expiresAt, priceAtSignal,
// atrPctAtSignal, and outcomeStatus. The scan filter
// `typeof item["expiresAt"] === "string"` excluded every row, so
// resolveOutcome was never called and signal_outcomes stayed empty.
//
// This test exercises the now-resolvable path: a row WITH all four fields
// present, where expiresAt is in the past and outcomeStatus is "pending".
// ---------------------------------------------------------------------------

describe("Phase 8 resolvable path (#356 regression)", () => {
  it("resolves a non-invalidated signal with all four Phase 8 fields via the full path", async () => {
    // The resolved outcome returned by the (mocked) resolver.
    const mockOutcome = {
      signalId: "sig-phase8",
      pair: "BTC/USDT",
      type: "buy",
      confidence: 0.72,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
      resolvedAt: new Date().toISOString(),
      priceAtSignal: 60500,
      priceAtResolution: 61200,
      priceMovePct: 0.012,
      atrPctAtSignal: 0.0066,
      thresholdUsed: 0.0033,
      outcome: "correct" as const,
      rulesFired: ["ema-cross-bull"],
      gateReason: null,
      emittingTimeframe: "15m",
      invalidatedExcluded: false,
      ttl: Math.floor(Date.now() / 1000) + 86400 * 30,
    };

    // Item has all four Phase 8 fields; expiresAt is past, invalidatedAt is null.
    const phase8Item = makeExpiredSignalItem({
      signalId: "sig-phase8",
      sk: "2026-01-01T00:00:00.000Z#sig-phase8",
      type: "buy",
      expiresAt: "2026-01-01T01:00:00.000Z", // past
      invalidatedAt: null,
      priceAtSignal: 60500,
      atrPctAtSignal: 0.0066,
      outcomeStatus: "pending",
      emittingTimeframe: "15m",
      rulesFired: ["ema-cross-bull"],
    });

    // The resolveOutcome mock is at the module level — reset it for this test.
    const { resolveOutcome } = await import("./outcomes/resolver.js");
    (resolveOutcome as ReturnType<typeof vi.fn>).mockReturnValue(mockOutcome);
    (resolveOutcome as ReturnType<typeof vi.fn>).mockReset();
    (resolveOutcome as ReturnType<typeof vi.fn>).mockReturnValue(mockOutcome);

    // ScanCommand returns the Phase-8 row; UpdateCommand (markSignalOutcomeResolved) succeeds.
    send.mockImplementation((cmd: { __cmd: string; input?: Record<string, unknown> }) => {
      if (cmd.__cmd === "Scan") {
        return Promise.resolve({ Items: [phase8Item], LastEvaluatedKey: undefined });
      }
      if (cmd.__cmd === "Update") return Promise.resolve({});
      return Promise.resolve({});
    });

    // getCandles returns a minimal candle for the canonical price lookup.
    const { getCandles: getCandles_ } = await import("./lib/candle-store.js");
    (getCandles_ as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        exchange: "binance",
        pair: "BTC/USDT",
        timeframe: "1h",
        closeTime: new Date("2026-01-01T01:00:00.000Z").getTime(),
        openTime: new Date("2026-01-01T00:00:00.000Z").getTime(),
        open: 60900,
        high: 61500,
        low: 60800,
        close: 61200,
        volume: 150,
        isClosed: true,
        source: "live",
        symbol: "BTC/USDT",
      },
    ]);
    const { canonicalizeCandle } = await import("./lib/canonicalize.js");
    (canonicalizeCandle as ReturnType<typeof vi.fn>).mockReturnValue({
      consensus: { close: 61200 },
      dispersion: 0.001,
    });

    const handler = await loadHandler();
    await handler({});

    // The row must have been picked up and resolved.
    expect(resolveOutcome).toHaveBeenCalledTimes(1);
    // putOutcome must have been called with the resolved outcome.
    expect(putOutcomeMock).toHaveBeenCalledTimes(1);
    expect(putOutcomeMock.mock.calls[0]![0]).toMatchObject({
      signalId: "sig-phase8",
      outcome: "correct",
    });
    // Rule fanout fires for non-excluded outcomes.
    expect(fanOutMock).toHaveBeenCalledTimes(1);

    // AC: markSignalOutcomeResolved must issue an UpdateCommand on signals-v2 (not PutCommand on
    // ingestion-metadata). Assert that an Update was issued with outcomeStatus = "resolved".
    const updateCalls = send.mock.calls.filter(
      (c) => (c[0] as { __cmd: string }).__cmd === "Update",
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const updateInput = (updateCalls[0]![0] as { input: Record<string, unknown> }).input;
    expect(updateInput["Key"]).toEqual({
      pair: "BTC/USDT",
      sk: "2026-01-01T00:00:00.000Z#sig-phase8",
    });
    expect(updateInput["UpdateExpression"]).toContain("outcomeStatus");
    expect((updateInput["ExpressionAttributeValues"] as Record<string, unknown>)[":resolved"]).toBe(
      "resolved",
    );

    // AC: No PutCommand should have been issued (old metadata-marker approach is gone).
    const putCalls = send.mock.calls.filter((c) => (c[0] as { __cmd: string }).__cmd === "Put");
    expect(putCalls).toHaveLength(0);
  });

  it("skips a signal where expiresAt is missing — scan filter excludes it (pre-#356 shape)", async () => {
    const prephase8Item = makeExpiredSignalItem({
      // No expiresAt — the scan filter `typeof item["expiresAt"] === "string"` is false.
    });
    delete (prephase8Item as Record<string, unknown>)["expiresAt"];

    send.mockResolvedValue({ Items: [prephase8Item] });

    const handler = await loadHandler();
    await handler({});

    // Without expiresAt the row is invisible to the handler — zero resolutions.
    expect(putOutcomeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regression (#360): outcomeStatus flip prevents re-resolution on subsequent cycles
//
// Before the fix, markSignalOutcomeResolved wrote to ingestion-metadata — not to
// signals-v2. The scan filter keys off signals-v2.outcomeStatus, so the row was
// never excluded, and every subsequent invocation re-resolved the same signal.
//
// After the fix, UpdateCommand flips outcomeStatus to "resolved" on the signals-v2
// row itself, so the in-process scan filter (`outcomeStatus !== "pending"`) correctly
// excludes it on all subsequent invocations.
// ---------------------------------------------------------------------------

describe("Regression #360: resolved signals are excluded from subsequent scans", () => {
  it("does not process a signal whose outcomeStatus is already 'resolved'", async () => {
    // Simulate a row that was resolved on a previous invocation (outcomeStatus = "resolved").
    const alreadyResolved = makeExpiredSignalItem({
      expiresAt: "2026-01-01T01:00:00.000Z",
      outcomeStatus: "resolved",
    });

    send.mockResolvedValue({ Items: [alreadyResolved] });

    const handler = await loadHandler();
    await handler({});

    // Scan filter must exclude this row — no resolution work should happen.
    expect(putOutcomeMock).not.toHaveBeenCalled();
    expect(fanOutMock).not.toHaveBeenCalled();

    // No UpdateCommand should be issued (nothing to mark as resolved).
    const updateCalls = send.mock.calls.filter(
      (c) => (c[0] as { __cmd: string }).__cmd === "Update",
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("excludes resolved signals even when mixed with pending ones", async () => {
    const resolvedRow = makeExpiredSignalItem({
      signalId: "sig-resolved",
      sk: "2026-01-01T00:00:00.000Z#sig-resolved",
      expiresAt: "2026-01-01T01:00:00.000Z",
      outcomeStatus: "resolved",
      invalidatedAt: null,
    });
    const pendingRow = makeExpiredSignalItem({
      signalId: "sig-pending",
      sk: "2026-01-01T00:00:00.000Z#sig-pending",
      expiresAt: "2026-01-01T01:00:00.000Z",
      outcomeStatus: "pending",
      invalidatedAt: "2026-01-01T00:30:00.000Z", // invalidated → simpler path, no price lookup
    });

    send.mockImplementation((cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Scan") {
        return Promise.resolve({
          Items: [resolvedRow, pendingRow],
          LastEvaluatedKey: undefined,
        });
      }
      // Accept Update (markSignalOutcomeResolved for the pending row).
      return Promise.resolve({});
    });

    const handler = await loadHandler();
    await handler({});

    // Only the pending row should be processed — exactly one putOutcome call.
    expect(putOutcomeMock).toHaveBeenCalledTimes(1);

    // Verify the resolved row was not included in the call.
    const processedSignalId = (putOutcomeMock.mock.calls[0]![0] as { signalId: string }).signalId;
    expect(processedSignalId).not.toBe("sig-resolved");
  });
});
