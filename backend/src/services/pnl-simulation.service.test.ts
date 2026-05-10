/**
 * Tests for pnl-simulation.service.ts
 *
 * Covers:
 *  - computeTradePnl: PnL math, fee handling, direction
 *  - buildEquityCurve: time-ordered accumulation
 *  - computeDrawdown: correct drawdown against known winning-then-losing scenario
 *  - getPnlSimulation: integration-level (DDB mocked at SDK boundary)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeTradePnl, buildEquityCurve, computeDrawdown } from "./pnl-simulation.service.js";

// ---------------------------------------------------------------------------
// Mock DynamoDB at the SDK boundary so getPnlSimulation doesn't need real AWS.
// vi.hoisted lifts the mock factory outside the ESM temporal dead zone so
// `sendMock` is available when the vi.mock factories run.
// ---------------------------------------------------------------------------

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation(() => ({ send: sendMock })),
  },
  QueryCommand: vi.fn().mockImplementation((input) => input),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
});

// ---------------------------------------------------------------------------
// computeTradePnl
// ---------------------------------------------------------------------------

describe("computeTradePnl", () => {
  it("returns correct long PnL for a winning buy", () => {
    // open=$100, close=$110, position=$100, fee=5 bps
    // gross = 100 × (10/100) = $10
    // fee = 100 × (5/10000) = $0.05
    // net = $9.95
    const result = computeTradePnl("buy", 100, 110, 100, 5);
    expect(result.direction).toBe("long");
    expect(result.grossPnlUsd).toBeCloseTo(10, 6);
    expect(result.feeUsd).toBeCloseTo(0.05, 6);
    expect(result.pnlUsd).toBeCloseTo(9.95, 6);
  });

  it("returns correct short PnL for a winning sell", () => {
    // open=$100, close=$90, position=$100, fee=5 bps
    // gross = 100 × (100-90)/100 = $10
    // fee = $0.05
    // net = $9.95
    const result = computeTradePnl("sell", 100, 90, 100, 5);
    expect(result.direction).toBe("short");
    expect(result.grossPnlUsd).toBeCloseTo(10, 6);
    expect(result.feeUsd).toBeCloseTo(0.05, 6);
    expect(result.pnlUsd).toBeCloseTo(9.95, 6);
  });

  it("returns negative PnL for a losing buy", () => {
    // open=$100, close=$90, position=$100, fee=5 bps
    // gross = 100 × (90-100)/100 = -$10
    // net = -$10.05
    const result = computeTradePnl("buy", 100, 90, 100, 5);
    expect(result.direction).toBe("long");
    expect(result.grossPnlUsd).toBeCloseTo(-10, 6);
    expect(result.pnlUsd).toBeCloseTo(-10.05, 6);
  });

  it("returns negative PnL for a losing sell", () => {
    // open=$100, close=$110, position=$100, fee=5 bps
    // gross = 100 × -(110-100)/100 = -$10
    // net = -$10.05
    const result = computeTradePnl("sell", 100, 110, 100, 5);
    expect(result.pnlUsd).toBeCloseTo(-10.05, 6);
  });

  it("fee handling: 5 bps = 0.05% of position size", () => {
    const result = computeTradePnl("buy", 100, 100, 1000, 5); // flat trade, only fees
    expect(result.feeUsd).toBeCloseTo(0.5, 6); // 1000 × 0.0005
    expect(result.pnlUsd).toBeCloseTo(-0.5, 6);
  });

  it("fee handling: 0 bps = no fee deducted", () => {
    const result = computeTradePnl("buy", 100, 110, 100, 0);
    expect(result.feeUsd).toBe(0);
    expect(result.pnlUsd).toBeCloseTo(10, 6);
  });

  it("uses the position size as a multiplier for gross PnL", () => {
    const result = computeTradePnl("buy", 100, 105, 200, 0); // 5% move × $200
    expect(result.grossPnlUsd).toBeCloseTo(10, 6);
  });
});

// ---------------------------------------------------------------------------
// buildEquityCurve
// ---------------------------------------------------------------------------

describe("buildEquityCurve", () => {
  it("returns an empty array for an empty trade list", () => {
    expect(buildEquityCurve([])).toEqual([]);
  });

  it("accumulates PnL correctly across trades", () => {
    const trades = [
      { ts: "2026-01-01T00:00:00.000Z", pnlUsd: 10 },
      { ts: "2026-01-02T00:00:00.000Z", pnlUsd: -5 },
      { ts: "2026-01-03T00:00:00.000Z", pnlUsd: 20 },
    ];
    const curve = buildEquityCurve(trades);
    expect(curve).toHaveLength(3);
    expect(curve[0].cumulativeUsd).toBeCloseTo(10);
    expect(curve[1].cumulativeUsd).toBeCloseTo(5);
    expect(curve[2].cumulativeUsd).toBeCloseTo(25);
  });

  it("preserves the input timestamps", () => {
    const trades = [
      { ts: "2026-01-01T00:00:00.000Z", pnlUsd: 5 },
      { ts: "2026-01-02T00:00:00.000Z", pnlUsd: -3 },
    ];
    const curve = buildEquityCurve(trades);
    expect(curve[0].ts).toBe("2026-01-01T00:00:00.000Z");
    expect(curve[1].ts).toBe("2026-01-02T00:00:00.000Z");
  });

  it("final cumulativeUsd equals sum-of-trade-PnL", () => {
    const trades = [
      { ts: "t1", pnlUsd: 7 },
      { ts: "t2", pnlUsd: -3 },
      { ts: "t3", pnlUsd: 11 },
      { ts: "t4", pnlUsd: -2 },
    ];
    const sum = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const curve = buildEquityCurve(trades);
    expect(curve[curve.length - 1].cumulativeUsd).toBeCloseTo(sum);
  });
});

// ---------------------------------------------------------------------------
// computeDrawdown
// ---------------------------------------------------------------------------

describe("computeDrawdown", () => {
  it("returns zero drawdown for an empty curve", () => {
    const dd = computeDrawdown([]);
    expect(dd.maxUsd).toBe(0);
    expect(dd.maxPct).toBe(0);
    expect(dd.durationDays).toBe(0);
  });

  it("returns zero drawdown for a monotonically rising curve", () => {
    const curve = [
      { ts: "2026-01-01T00:00:00.000Z", cumulativeUsd: 10 },
      { ts: "2026-01-02T00:00:00.000Z", cumulativeUsd: 20 },
      { ts: "2026-01-03T00:00:00.000Z", cumulativeUsd: 30 },
    ];
    const dd = computeDrawdown(curve);
    expect(dd.maxUsd).toBe(0);
    expect(dd.maxPct).toBe(0);
    expect(dd.durationDays).toBe(0);
  });

  it("correctly identifies drawdown in a winning-streak-then-losing-streak scenario", () => {
    // Winning streak: 0 → 10 → 20 → 30
    // Losing streak: 30 → 20 → 10 → 5
    // Max drawdown from peak 30 to trough 5 = $25, 83.3%
    const curve = [
      { ts: "2026-01-01T00:00:00.000Z", cumulativeUsd: 10 },
      { ts: "2026-01-02T00:00:00.000Z", cumulativeUsd: 20 },
      { ts: "2026-01-03T00:00:00.000Z", cumulativeUsd: 30 }, // peak
      { ts: "2026-01-04T00:00:00.000Z", cumulativeUsd: 20 },
      { ts: "2026-01-05T00:00:00.000Z", cumulativeUsd: 10 },
      { ts: "2026-01-06T00:00:00.000Z", cumulativeUsd: 5 }, // trough
    ];
    const dd = computeDrawdown(curve);
    expect(dd.maxUsd).toBeCloseTo(25, 4);
    expect(dd.maxPct).toBeCloseTo(25 / 30, 4);
    // Peak is 2026-01-03, trough is 2026-01-06 → 3 days
    expect(dd.durationDays).toBeCloseTo(3, 4);
  });

  it("handles a curve that starts with a loss (peak at start)", () => {
    // Curve: 0 at start, 5, then drops to -2. Peak is 5 at second point.
    const curve = [
      { ts: "2026-01-01T00:00:00.000Z", cumulativeUsd: 5 },
      { ts: "2026-01-02T00:00:00.000Z", cumulativeUsd: -2 },
    ];
    const dd = computeDrawdown(curve);
    expect(dd.maxUsd).toBeCloseTo(7, 4);
    // Peak = 5, which is > 0, so pct = 7/5 = 1.4. The formula reports what it is.
    expect(dd.maxPct).toBeCloseTo(1.4, 4);
    expect(dd.durationDays).toBeCloseTo(1, 4);
  });

  it("duration is correct when peak and trough are on the same day", () => {
    const curve = [
      { ts: "2026-01-01T00:00:00.000Z", cumulativeUsd: 10 },
      { ts: "2026-01-01T12:00:00.000Z", cumulativeUsd: 5 }, // 12h after peak
    ];
    const dd = computeDrawdown(curve);
    expect(dd.maxUsd).toBeCloseTo(5, 4);
    expect(dd.durationDays).toBeCloseTo(0.5, 4);
  });
});

// ---------------------------------------------------------------------------
// getPnlSimulation — direction filter
// ---------------------------------------------------------------------------

describe("getPnlSimulation direction filter", () => {
  // Mixed fixture: 1 winning long (buy 100→110) and 1 winning short (sell 100→90).
  // Both trade $100 position, 5 bps fee → ~$9.95 net each.
  const mixedItems = [
    {
      pair: "BTC/USDT",
      signalId: "s1",
      type: "buy",
      outcome: "correct",
      priceAtSignal: 100,
      priceAtResolution: 110,
      resolvedAt: "2026-01-01T00:00:00.000Z",
      emittingTimeframe: "1h",
    },
    {
      pair: "BTC/USDT",
      signalId: "s2",
      type: "sell",
      outcome: "correct",
      priceAtSignal: 100,
      priceAtResolution: 90,
      resolvedAt: "2026-01-02T00:00:00.000Z",
      emittingTimeframe: "1h",
    },
  ];

  // Stub Query: first call for BTC returns mixed items, all other pair queries
  // return empty (mimics single-pair test without imposing a pair filter).
  // QueryCommand is mocked to return its input directly (see vi.mock above),
  // so the cmd passed to send() is the QueryCommand input shape.
  function stubMixedThenEmpty() {
    sendMock.mockImplementation((cmd: { ExpressionAttributeValues?: { ":pair"?: string } }) => {
      const pair = cmd.ExpressionAttributeValues?.[":pair"];
      if (pair === "BTC/USDT") {
        return Promise.resolve({ Items: mixedItems, LastEvaluatedKey: undefined });
      }
      return Promise.resolve({ Items: [], LastEvaluatedKey: undefined });
    });
  }

  it("'long' keeps only buy trades — different equity curve from 'both'", async () => {
    stubMixedThenEmpty();
    const { getPnlSimulation } = await import("./pnl-simulation.service.js");

    const both = await getPnlSimulation({ direction: "both" });
    const longOnly = await getPnlSimulation({ direction: "long" });

    expect(both.trades.count).toBe(2);
    expect(longOnly.trades.count).toBe(1);
    // Long-only equity curve must differ: 1 point vs 2.
    expect(longOnly.equityCurve.length).toBeLessThan(both.equityCurve.length);
    expect(longOnly.pnl.totalUsd).toBeCloseTo(9.95, 6);
  });

  it("'short' keeps only sell trades — different equity curve from 'both'", async () => {
    stubMixedThenEmpty();
    const { getPnlSimulation } = await import("./pnl-simulation.service.js");

    const both = await getPnlSimulation({ direction: "both" });
    const shortOnly = await getPnlSimulation({ direction: "short" });

    expect(both.trades.count).toBe(2);
    expect(shortOnly.trades.count).toBe(1);
    expect(shortOnly.equityCurve.length).toBeLessThan(both.equityCurve.length);
    expect(shortOnly.pnl.totalUsd).toBeCloseTo(9.95, 6);
  });
});
