import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock signal-store before any imports touch it
// ---------------------------------------------------------------------------

const findActiveSignalsForPairMock = vi.fn();
const markSignalInvalidatedMock = vi.fn();

vi.mock("../lib/signal-store.js", () => ({
  findActiveSignalsForPair: findActiveSignalsForPairMock,
  markSignalInvalidated: markSignalInvalidatedMock,
}));

beforeEach(() => {
  vi.resetModules();
  findActiveSignalsForPairMock.mockReset();
  markSignalInvalidatedMock.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { EnrichedNewsEvent } from "./invalidation.js";

function makeEvent(overrides: Partial<EnrichedNewsEvent> = {}): EnrichedNewsEvent {
  return {
    newsId: "article-001",
    title: "Coinbase delists ETH staking",
    publishedAt: new Date().toISOString(), // fresh by default
    mentionedPairs: ["ETH"],
    sentiment: { score: -0.8, magnitude: 0.9, model: "anthropic.claude-haiku-4-5" },
    duplicateOf: null,
    ...overrides,
  };
}

function makeActiveSignal(pair: string, suffix = "a") {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    pair,
    emittedAtSignalId: `2024-01-01T00:00:00.000Z#sig-${suffix}`,
    signalId: `sig-${suffix}`,
    emittedAt: "2024-01-01T00:00:00.000Z",
    ttl: nowSec + 86400, // 1 day from now → active
  };
}

// ---------------------------------------------------------------------------
// shouldTriggerInvalidation
// ---------------------------------------------------------------------------

describe("shouldTriggerInvalidation", () => {
  it("returns true when all four conditions are met", async () => {
    const { shouldTriggerInvalidation } = await import("./invalidation.js");
    expect(shouldTriggerInvalidation(makeEvent())).toBe(true);
  });

  it("returns false when magnitude is exactly at threshold (not strictly above)", async () => {
    const { shouldTriggerInvalidation, MAGNITUDE_THRESHOLD } = await import("./invalidation.js");
    expect(
      shouldTriggerInvalidation(makeEvent({ sentiment: { score: 0, magnitude: MAGNITUDE_THRESHOLD, model: "m" } })),
    ).toBe(false);
  });

  it("returns false when magnitude is below threshold", async () => {
    const { shouldTriggerInvalidation } = await import("./invalidation.js");
    expect(
      shouldTriggerInvalidation(makeEvent({ sentiment: { score: 0, magnitude: 0.5, model: "m" } })),
    ).toBe(false);
  });

  it("returns false when mentionedPairs is empty", async () => {
    const { shouldTriggerInvalidation } = await import("./invalidation.js");
    expect(shouldTriggerInvalidation(makeEvent({ mentionedPairs: [] }))).toBe(false);
  });

  it("returns false when event is a duplicate", async () => {
    const { shouldTriggerInvalidation } = await import("./invalidation.js");
    expect(shouldTriggerInvalidation(makeEvent({ duplicateOf: "article-000" }))).toBe(false);
  });

  it("returns false when article is older than 30 minutes", async () => {
    const { shouldTriggerInvalidation } = await import("./invalidation.js");
    const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    expect(shouldTriggerInvalidation(makeEvent({ publishedAt: thirtyOneMinutesAgo }))).toBe(false);
  });

  it("returns true when article is exactly at the freshness boundary (within window)", async () => {
    const { shouldTriggerInvalidation } = await import("./invalidation.js");
    const nowMs = Date.now();
    // 29 minutes ago — still within the 30-minute window
    const publishedAt = new Date(nowMs - 29 * 60 * 1000).toISOString();
    expect(shouldTriggerInvalidation(makeEvent({ publishedAt }), nowMs)).toBe(true);
  });

  it("returns false when publishedAt is unparseable", async () => {
    const { shouldTriggerInvalidation } = await import("./invalidation.js");
    expect(shouldTriggerInvalidation(makeEvent({ publishedAt: "not-a-date" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processNewsEventForInvalidation — no-trigger paths
// ---------------------------------------------------------------------------

describe("processNewsEventForInvalidation — no trigger", () => {
  it("returns triggered=false and no DDB calls when magnitude is too low", async () => {
    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    const result = await processNewsEventForInvalidation(
      makeEvent({ sentiment: { score: 0, magnitude: 0.3, model: "m" } }),
    );
    expect(result.triggered).toBe(false);
    expect(result.pairsInvalidated).toEqual([]);
    expect(result.signalsInvalidated).toBe(0);
    expect(findActiveSignalsForPairMock).not.toHaveBeenCalled();
    expect(markSignalInvalidatedMock).not.toHaveBeenCalled();
  });

  it("returns triggered=false when event is a duplicate", async () => {
    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    const result = await processNewsEventForInvalidation(
      makeEvent({ duplicateOf: "article-000" }),
    );
    expect(result.triggered).toBe(false);
    expect(findActiveSignalsForPairMock).not.toHaveBeenCalled();
  });

  it("returns triggered=false when no mentionedPairs", async () => {
    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    const result = await processNewsEventForInvalidation(
      makeEvent({ mentionedPairs: [] }),
    );
    expect(result.triggered).toBe(false);
    expect(findActiveSignalsForPairMock).not.toHaveBeenCalled();
  });

  it("returns triggered=false for stale news", async () => {
    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    const staleDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const result = await processNewsEventForInvalidation(
      makeEvent({ publishedAt: staleDate }),
    );
    expect(result.triggered).toBe(false);
    expect(findActiveSignalsForPairMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processNewsEventForInvalidation — trigger path
// ---------------------------------------------------------------------------

describe("processNewsEventForInvalidation — triggered", () => {
  it("invalidates all active signals for mentioned pairs", async () => {
    findActiveSignalsForPairMock.mockResolvedValue([makeActiveSignal("ETH")]);
    markSignalInvalidatedMock.mockResolvedValue(undefined);

    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    const result = await processNewsEventForInvalidation(makeEvent());

    expect(result.triggered).toBe(true);
    expect(result.pairsInvalidated).toEqual(["ETH"]);
    expect(result.signalsInvalidated).toBe(1);
    expect(findActiveSignalsForPairMock).toHaveBeenCalledWith("ETH");
    expect(markSignalInvalidatedMock).toHaveBeenCalledWith(
      "ETH",
      "2024-01-01T00:00:00.000Z#sig-a",
      expect.stringContaining("Coinbase delists ETH staking"),
      expect.any(String), // nowIso
    );
  });

  it("invalidates multiple signals for the same pair", async () => {
    findActiveSignalsForPairMock.mockResolvedValue([
      makeActiveSignal("BTC", "a"),
      makeActiveSignal("BTC", "b"),
    ]);
    markSignalInvalidatedMock.mockResolvedValue(undefined);

    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    const result = await processNewsEventForInvalidation(
      makeEvent({ mentionedPairs: ["BTC"] }),
    );

    expect(result.triggered).toBe(true);
    expect(result.signalsInvalidated).toBe(2);
    expect(markSignalInvalidatedMock).toHaveBeenCalledTimes(2);
  });

  it("processes multiple pairs in the same news event", async () => {
    findActiveSignalsForPairMock.mockImplementation((pair: string) => {
      if (pair === "BTC") return Promise.resolve([makeActiveSignal("BTC")]);
      if (pair === "ETH") return Promise.resolve([makeActiveSignal("ETH")]);
      return Promise.resolve([]);
    });
    markSignalInvalidatedMock.mockResolvedValue(undefined);

    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    const result = await processNewsEventForInvalidation(
      makeEvent({ mentionedPairs: ["BTC", "ETH"] }),
    );

    expect(result.triggered).toBe(true);
    expect(result.pairsInvalidated).toContain("BTC");
    expect(result.pairsInvalidated).toContain("ETH");
    expect(result.signalsInvalidated).toBe(2);
  });

  it("skips pairs that have no active signals", async () => {
    findActiveSignalsForPairMock.mockResolvedValue([]); // no active signals

    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    const result = await processNewsEventForInvalidation(makeEvent());

    expect(result.triggered).toBe(true);
    expect(result.pairsInvalidated).toEqual([]);
    expect(result.signalsInvalidated).toBe(0);
    expect(markSignalInvalidatedMock).not.toHaveBeenCalled();
  });

  it("passes invalidation reason prefixed with 'Breaking news:'", async () => {
    findActiveSignalsForPairMock.mockResolvedValue([makeActiveSignal("ETH")]);
    markSignalInvalidatedMock.mockResolvedValue(undefined);

    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    await processNewsEventForInvalidation(makeEvent({ title: "ETH staking news" }));

    const reasonArg = markSignalInvalidatedMock.mock.calls[0][2] as string;
    expect(reasonArg).toMatch(/^Breaking news:/);
    expect(reasonArg).toContain("ETH staking news");
  });

  it("reason string is capped at 120 characters for mobile readability", async () => {
    const longTitle = "A".repeat(200);
    findActiveSignalsForPairMock.mockResolvedValue([makeActiveSignal("BTC")]);
    markSignalInvalidatedMock.mockResolvedValue(undefined);

    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    await processNewsEventForInvalidation(
      makeEvent({ mentionedPairs: ["BTC"], title: longTitle }),
    );

    const reasonArg = markSignalInvalidatedMock.mock.calls[0][2] as string;
    expect(reasonArg.length).toBeLessThanOrEqual(120);
  });

  it("passes the correct nowIso timestamp to markSignalInvalidated", async () => {
    findActiveSignalsForPairMock.mockResolvedValue([makeActiveSignal("ETH")]);
    markSignalInvalidatedMock.mockResolvedValue(undefined);

    const fixedNowMs = 1700000000000;
    const expectedIso = new Date(fixedNowMs).toISOString();

    const { processNewsEventForInvalidation } = await import("./invalidation.js");
    await processNewsEventForInvalidation(makeEvent(), fixedNowMs);

    expect(markSignalInvalidatedMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expectedIso,
    );
  });
});

