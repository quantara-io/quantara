/**
 * outcome-store.test.ts — Phase 8.
 *
 * Tests for fanOutToRuleAttributionGSI and the buildRuleAttribution
 * end-to-end chain (regression for issue #361).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OutcomeRecord } from "../outcomes/resolver.js";

const send = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  BatchWriteCommand: vi.fn().mockImplementation((input) => ({ __cmd: "BatchWrite", input })),
}));

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env.TABLE_SIGNAL_OUTCOMES = "test-signal-outcomes";
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_RESOLVED_AT = "2026-01-01T12:00:00.000Z";

function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    pair: "BTC/USDT",
    signalId: "sig-abc123",
    type: "buy",
    confidence: 0.72,
    createdAt: "2026-01-01T11:00:00.000Z",
    expiresAt: "2026-01-01T12:00:00.000Z",
    resolvedAt: BASE_RESOLVED_AT,
    priceAtSignal: 100_000,
    priceAtResolution: 103_000,
    priceMovePct: 0.03,
    atrPctAtSignal: 0.04,
    thresholdUsed: 0.02,
    outcome: "correct",
    rulesFired: ["macd-cross-bull", "rsi-bullish-cross"],
    gateReason: null,
    emittingTimeframe: "1h",
    invalidatedExcluded: false,
    ttl: 9_999_999_999,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fanOutToRuleAttributionGSI — item shape regression tests (#361)
// ---------------------------------------------------------------------------

describe("fanOutToRuleAttributionGSI", () => {
  it("writes one BatchWriteCommand per 25-rule batch", async () => {
    send.mockResolvedValue({});
    const outcome = makeOutcome({ rulesFired: ["rule-a", "rule-b"] });
    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);

    // Two rules → one batch → one send call
    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("BatchWrite");
  });

  it("is a no-op when rulesFired is empty", async () => {
    send.mockResolvedValue({});
    const outcome = makeOutcome({ rulesFired: [] });
    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);
    expect(send).not.toHaveBeenCalled();
  });

  it("writes the correct signalId (rule-fan-out sentinel) and createdAtSignalId", async () => {
    send.mockResolvedValue({});
    const outcome = makeOutcome({ rulesFired: ["macd-cross-bull"] });
    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);

    const items = send.mock.calls[0][0].input.RequestItems["test-signal-outcomes"];
    expect(items).toHaveLength(1);
    const item = items[0].PutRequest.Item;
    expect(item.signalId).toBe(`rule-fan-out#macd-cross-bull#${outcome.signalId}`);
    expect(item.createdAtSignalId).toBe(`${outcome.createdAt}#${outcome.signalId}`);
    expect(item.rule).toBe("macd-cross-bull");
  });

  // Regression: issue #361 — these three fields were missing and caused
  // buildRuleAttribution to silently return zero counters for every rule.
  it("includes rulesFired (full array) on the fan-out item", async () => {
    send.mockResolvedValue({});
    const outcome = makeOutcome({ rulesFired: ["macd-cross-bull", "rsi-bullish-cross"] });
    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);

    const items = send.mock.calls[0][0].input.RequestItems["test-signal-outcomes"];
    for (const { PutRequest } of items) {
      expect(PutRequest.Item.rulesFired).toEqual(["macd-cross-bull", "rsi-bullish-cross"]);
    }
  });

  it("includes resolvedAt on the fan-out item", async () => {
    send.mockResolvedValue({});
    const outcome = makeOutcome({ resolvedAt: BASE_RESOLVED_AT });
    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);

    const items = send.mock.calls[0][0].input.RequestItems["test-signal-outcomes"];
    for (const { PutRequest } of items) {
      expect(PutRequest.Item.resolvedAt).toBe(BASE_RESOLVED_AT);
    }
  });

  it("includes invalidatedExcluded on the fan-out item", async () => {
    send.mockResolvedValue({});
    const outcome = makeOutcome({ invalidatedExcluded: false });
    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);

    const items = send.mock.calls[0][0].input.RequestItems["test-signal-outcomes"];
    for (const { PutRequest } of items) {
      expect(PutRequest.Item.invalidatedExcluded).toBe(false);
    }
  });

  it("produces one fan-out row per rule (2 rules → 2 items in the batch)", async () => {
    send.mockResolvedValue({});
    const outcome = makeOutcome({ rulesFired: ["macd-cross-bull", "rsi-bullish-cross"] });
    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);

    const items = send.mock.calls[0][0].input.RequestItems["test-signal-outcomes"];
    expect(items).toHaveLength(2);
    const rules = items.map(
      (i: { PutRequest: { Item: { rule: string } } }) => i.PutRequest.Item.rule,
    );
    expect(rules).toContain("macd-cross-bull");
    expect(rules).toContain("rsi-bullish-cross");
  });

  it("splits 26+ rules into multiple batches of ≤ 25", async () => {
    send.mockResolvedValue({});
    const rules = Array.from({ length: 26 }, (_, i) => `rule-${i}`);
    const outcome = makeOutcome({ rulesFired: rules });
    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);

    // 26 rules → ceil(26/25) = 2 BatchWrite calls
    expect(send).toHaveBeenCalledTimes(2);
    const batch1 = send.mock.calls[0][0].input.RequestItems["test-signal-outcomes"];
    const batch2 = send.mock.calls[1][0].input.RequestItems["test-signal-outcomes"];
    expect(batch1).toHaveLength(25);
    expect(batch2).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: fanOutToRuleAttributionGSI → queryOutcomesByRule →
// buildRuleAttribution — asserts fireCount > 0 (regression for issue #361)
// ---------------------------------------------------------------------------

describe("fanOut → queryOutcomesByRule → buildRuleAttribution (E2E, #361)", () => {
  it("buildRuleAttribution returns fireCount > 0 and correctCount > 0 when fan-out rows carry rulesFired/resolvedAt/invalidatedExcluded", async () => {
    // --- Step 1: fan-out the outcome and capture what was written to DDB ----
    send.mockResolvedValue({});
    const outcome = makeOutcome({
      rulesFired: ["macd-cross-bull", "rsi-bullish-cross"],
      outcome: "correct",
      resolvedAt: BASE_RESOLVED_AT,
      invalidatedExcluded: false,
    });

    const { fanOutToRuleAttributionGSI } = await import("./outcome-store.js");
    await fanOutToRuleAttributionGSI(outcome);

    // Extract the two fan-out items that were written
    const batchItems: { PutRequest: { Item: OutcomeRecord } }[] =
      send.mock.calls[0][0].input.RequestItems["test-signal-outcomes"];

    expect(batchItems).toHaveLength(2);

    // --- Step 2: simulate queryOutcomesByRule returning those same items ----
    // (queryOutcomesByRule casts DDB Items to OutcomeRecord — the fan-out item IS that shape)
    const fanOutItems = batchItems.map((i) => i.PutRequest.Item as unknown as OutcomeRecord);

    // Confirm the returned items have the three fields that buildRuleAttribution needs
    for (const item of fanOutItems) {
      expect(item.rulesFired).toBeDefined();
      expect(item.resolvedAt).toBeDefined();
      expect(item.invalidatedExcluded).toBeDefined();
    }

    // --- Step 3: run buildRuleAttribution with the fan-out items ------------
    // Use a nowIso that is AFTER BASE_RESOLVED_AT so both items fall inside the 30d window.
    const { buildRuleAttribution } = await import("../outcomes/attribution.js");
    const nowIso = "2026-01-15T00:00:00.000Z"; // 14 days after BASE_RESOLVED_AT — inside 30d window

    const attrMacd = buildRuleAttribution(
      "macd-cross-bull",
      outcome.pair,
      outcome.emittingTimeframe,
      "30d",
      fanOutItems,
      nowIso,
    );

    expect(attrMacd.fireCount).toBeGreaterThan(0);
    expect(attrMacd.correctCount).toBeGreaterThan(0);
    expect(attrMacd.contribution).not.toBeNull();

    const attrRsi = buildRuleAttribution(
      "rsi-bullish-cross",
      outcome.pair,
      outcome.emittingTimeframe,
      "30d",
      fanOutItems,
      nowIso,
    );

    expect(attrRsi.fireCount).toBeGreaterThan(0);
    expect(attrRsi.correctCount).toBeGreaterThan(0);
    expect(attrRsi.contribution).not.toBeNull();
  });
});
