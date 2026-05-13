/**
 * Unit tests for CommandPalette localStorage helpers and signal utilities.
 *
 * The vitest config uses environment:"node" and includes only *.test.ts,
 * so React rendering tests are covered by manual test plan. These tests cover
 * the pure-logic exports: loadRecentSymbols, pushRecentSymbol, Markets scoring
 * helpers (fuzzyScore / recencyFactor / scoreMarket / rankMarkets), Signals
 * helpers (signalStrengthLabel / signalTone / formatSignalDate), the
 * fetchSignalsForPair data path with its 30 s module-level cache, and the
 * cross-symbol fetchSignalsAllSymbols path (issue #332).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadRecentSymbols,
  pushRecentSymbol,
  fuzzyScore,
  recencyFactor,
  scoreMarket,
  rankMarkets,
  touchRecentTimestamp,
  signalStrengthLabel,
  signalTone,
  formatSignalDate,
  fetchSignalsForPair,
  fetchSignalsAllSymbols,
  __resetSignalCacheForTests,
  __getSignalCacheSizeForTests,
  type SignalsFetcher,
} from "./CommandPalette";
import type { BlendedSignal } from "@quantara/shared";

// Minimal localStorage shim for node environment.
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

const LS_KEY = "q.cmdk.recent";

beforeEach(() => {
  localStorageMock.clear();
});

// ── loadRecentSymbols ─────────────────────────────────────────────────────────

describe("loadRecentSymbols", () => {
  it("returns default symbols when localStorage is empty", () => {
    const result = loadRecentSymbols();
    expect(result).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("returns stored symbols when localStorage has valid data", () => {
    localStorageMock.setItem(LS_KEY, JSON.stringify(["XRP", "DOGE"]));
    const result = loadRecentSymbols();
    expect(result).toEqual(["XRP", "DOGE"]);
  });

  it("returns default symbols when localStorage value is malformed JSON", () => {
    localStorageMock.setItem(LS_KEY, "not-json{{");
    const result = loadRecentSymbols();
    expect(result).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("returns default symbols when localStorage value is an empty array", () => {
    localStorageMock.setItem(LS_KEY, JSON.stringify([]));
    const result = loadRecentSymbols();
    expect(result).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("caps returned list at 5 entries", () => {
    const sixSymbols = ["A", "B", "C", "D", "E", "F"];
    localStorageMock.setItem(LS_KEY, JSON.stringify(sixSymbols));
    const result = loadRecentSymbols();
    expect(result).toHaveLength(5);
    expect(result).toEqual(["A", "B", "C", "D", "E"]);
  });
});

// ── pushRecentSymbol ──────────────────────────────────────────────────────────

describe("pushRecentSymbol", () => {
  it("prepends a new symbol to the default list", () => {
    const result = pushRecentSymbol("SOL");
    // SOL moved to front; deduplicated since it was in defaults
    expect(result[0]).toBe("SOL");
    expect(result).toContain("BTC");
    expect(result).toContain("ETH");
  });

  it("de-duplicates the pushed symbol", () => {
    localStorageMock.setItem(LS_KEY, JSON.stringify(["BTC", "ETH", "SOL"]));
    const result = pushRecentSymbol("ETH");
    expect(result[0]).toBe("ETH");
    // ETH appears only once
    expect(result.filter((s) => s === "ETH")).toHaveLength(1);
  });

  it("caps list at 5 entries after push", () => {
    localStorageMock.setItem(LS_KEY, JSON.stringify(["A", "B", "C", "D", "E"]));
    const result = pushRecentSymbol("X");
    expect(result).toHaveLength(5);
    expect(result[0]).toBe("X");
    // "E" is dropped
    expect(result).not.toContain("E");
  });

  it("persists the updated list to localStorage", () => {
    pushRecentSymbol("AVAX");
    const stored = JSON.parse(localStorageMock.getItem(LS_KEY) ?? "[]") as string[];
    expect(stored[0]).toBe("AVAX");
  });

  it("returns a new list with the pushed symbol at index 0", () => {
    localStorageMock.setItem(LS_KEY, JSON.stringify(["BTC", "ETH"]));
    const result = pushRecentSymbol("LINK");
    expect(result[0]).toBe("LINK");
    expect(result[1]).toBe("BTC");
    expect(result[2]).toBe("ETH");
  });
});

// ── signalStrengthLabel ───────────────────────────────────────────────────────

function makeSignal(overrides: Partial<BlendedSignal>): BlendedSignal {
  return {
    pair: "ETH/USDT",
    type: "buy",
    confidence: 0.6,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: [],
    perTimeframe: {} as BlendedSignal["perTimeframe"],
    weightsUsed: {} as BlendedSignal["weightsUsed"],
    asOf: Date.now(),
    emittingTimeframe: "1h",
    risk: null,
    ...overrides,
  };
}

describe("signalStrengthLabel", () => {
  it('returns "Strong Buy" for strong-buy type', () => {
    expect(signalStrengthLabel(makeSignal({ type: "strong-buy" }))).toBe("Strong Buy");
  });

  it('returns "Strong Buy" for buy with confidence >= 0.7', () => {
    expect(signalStrengthLabel(makeSignal({ type: "buy", confidence: 0.75 }))).toBe("Strong Buy");
  });

  it('returns "Buy" for buy with confidence < 0.7', () => {
    expect(signalStrengthLabel(makeSignal({ type: "buy", confidence: 0.5 }))).toBe("Buy");
  });

  it('returns "Strong Sell" for strong-sell type', () => {
    expect(signalStrengthLabel(makeSignal({ type: "strong-sell" }))).toBe("Strong Sell");
  });

  it('returns "Strong Sell" for sell with confidence >= 0.7', () => {
    expect(signalStrengthLabel(makeSignal({ type: "sell", confidence: 0.8 }))).toBe("Strong Sell");
  });

  it('returns "Sell" for sell with confidence < 0.7', () => {
    expect(signalStrengthLabel(makeSignal({ type: "sell", confidence: 0.55 }))).toBe("Sell");
  });

  it('returns "Bull Div" for hold with bull divergence rule', () => {
    expect(signalStrengthLabel(makeSignal({ type: "hold", rulesFired: ["bull_div_macd"] }))).toBe(
      "Bull Div",
    );
  });

  it('returns "Bear Div" for hold with bear divergence rule', () => {
    expect(signalStrengthLabel(makeSignal({ type: "hold", rulesFired: ["bear_div_rsi"] }))).toBe(
      "Bear Div",
    );
  });

  it('returns "Breakout" for hold with breakout rule', () => {
    expect(signalStrengthLabel(makeSignal({ type: "hold", rulesFired: ["breakout_volume"] }))).toBe(
      "Breakout",
    );
  });

  it('returns "RSI Oversold" for hold with rsi oversold rule', () => {
    expect(signalStrengthLabel(makeSignal({ type: "hold", rulesFired: ["rsi_oversold"] }))).toBe(
      "RSI Oversold",
    );
  });
});

// ── signalTone ────────────────────────────────────────────────────────────────

describe("signalTone", () => {
  it('returns "up" for strong-buy', () => {
    expect(signalTone(makeSignal({ type: "strong-buy" }))).toBe("up");
  });

  it('returns "up" for buy', () => {
    expect(signalTone(makeSignal({ type: "buy" }))).toBe("up");
  });

  it('returns "down" for strong-sell', () => {
    expect(signalTone(makeSignal({ type: "strong-sell" }))).toBe("down");
  });

  it('returns "down" for sell', () => {
    expect(signalTone(makeSignal({ type: "sell" }))).toBe("down");
  });

  it('returns "warn" for hold', () => {
    expect(signalTone(makeSignal({ type: "hold" }))).toBe("warn");
  });
});

// ── formatSignalDate ──────────────────────────────────────────────────────────

describe("formatSignalDate", () => {
  it("returns a non-empty string for a valid timestamp", () => {
    const ts = new Date("2026-05-12T09:00:00Z").getTime();
    const result = formatSignalDate(ts);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes the day number in the formatted output", () => {
    // Day 12 of May — should appear somewhere in the formatted string.
    const ts = new Date("2026-05-12T09:00:00Z").getTime();
    const result = formatSignalDate(ts);
    expect(result).toMatch(/12/);
  });
});

// ── fetchSignalsForPair ──────────────────────────────────────────────────────
//
// These tests cover the pure data-path that the `useSignals` hook wraps. The
// hook itself uses React state + effects which aren't testable under the
// `environment: "node"` vitest config, but the cache logic, error handling,
// and the 30 s TTL eviction are all exercisable through the exported pure
// function.

function makeSignalRow(pair = "ETH/USDT"): BlendedSignal {
  return makeSignal({ pair, asOf: Date.now() });
}

describe("fetchSignalsForPair", () => {
  beforeEach(() => {
    __resetSignalCacheForTests();
  });

  it("returns [] for an empty pair without calling the fetcher", async () => {
    const fetcher = vi.fn();
    const result = await fetchSignalsForPair("", fetcher as unknown as SignalsFetcher);
    expect(result).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns mapped rows on a successful fetch", async () => {
    const rows = [makeSignalRow("BTC/USDT"), makeSignalRow("BTC/USDT")];
    const fetcher: SignalsFetcher = vi
      .fn()
      .mockResolvedValue({ success: true, data: { signals: rows } });
    const result = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(result).toEqual(rows);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("encodes the pair as a query param", async () => {
    const fetcher: SignalsFetcher = vi
      .fn()
      .mockResolvedValue({ success: true, data: { signals: [] } });
    await fetchSignalsForPair("ETH/USDT", fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/signals?pair=ETH%2FUSDT&limit=10",
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("returns [] when the fetcher resolves with an error envelope", async () => {
    const fetcher: SignalsFetcher = vi.fn().mockResolvedValue({
      success: false,
      error: { code: "HTTP_500", message: "internal" },
    });
    const result = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(result).toEqual([]);
  });

  it("returns [] when the fetcher throws unexpectedly", async () => {
    const fetcher: SignalsFetcher = vi.fn().mockRejectedValue(new Error("boom"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(result).toEqual([]);
    warnSpy.mockRestore();
  });

  it("returns null when the fetcher reports an aborted request", async () => {
    const fetcher: SignalsFetcher = vi.fn().mockResolvedValue({
      success: false,
      error: { code: "ABORTED", message: "aborted" },
    });
    const result = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(result).toBeNull();
  });

  it("returns null when the AbortSignal is already aborted after fetch resolves", async () => {
    const ctrl = new AbortController();
    const fetcher: SignalsFetcher = vi.fn().mockImplementation(async () => {
      ctrl.abort();
      return { success: true, data: { signals: [makeSignalRow()] } };
    });
    const result = await fetchSignalsForPair("BTC/USDT", fetcher, ctrl.signal);
    expect(result).toBeNull();
  });

  it("caches a successful fetch — a second call within 30s does not re-invoke the fetcher", async () => {
    const rows = [makeSignalRow("BTC/USDT")];
    const fetcher: SignalsFetcher = vi
      .fn()
      .mockResolvedValue({ success: true, data: { signals: rows } });
    const first = await fetchSignalsForPair("BTC/USDT", fetcher);
    const second = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(first).toEqual(rows);
    expect(second).toEqual(rows);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("evicts the cache after the 30s TTL and re-fetches", async () => {
    const rowsFirst = [makeSignalRow("BTC/USDT")];
    const rowsSecond = [makeSignalRow("BTC/USDT"), makeSignalRow("BTC/USDT")];
    const fetcher: SignalsFetcher = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: { signals: rowsFirst } })
      .mockResolvedValueOnce({ success: true, data: { signals: rowsSecond } });

    const NOW = 1_700_000_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const first = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(first).toEqual(rowsFirst);

    // Within TTL — second call returns from cache, fetcher still only called once.
    dateSpy.mockReturnValue(NOW + 29_000);
    const cached = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(cached).toEqual(rowsFirst);
    expect(fetcher).toHaveBeenCalledOnce();

    // After TTL — entry evicted, fetcher invoked again.
    dateSpy.mockReturnValue(NOW + 31_000);
    const refetched = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(refetched).toEqual(rowsSecond);
    expect(fetcher).toHaveBeenCalledTimes(2);

    dateSpy.mockRestore();
  });

  it("does not cache an error envelope — subsequent calls hit the fetcher again", async () => {
    const fetcher: SignalsFetcher = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: { code: "HTTP_500", message: "x" } })
      .mockResolvedValueOnce({ success: true, data: { signals: [makeSignalRow()] } });

    const first = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(first).toEqual([]);
    expect(__getSignalCacheSizeForTests()).toBe(0);

    const second = await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(second).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps per-pair cache entries independent", async () => {
    const btcRows = [makeSignalRow("BTC/USDT")];
    const ethRows = [makeSignalRow("ETH/USDT"), makeSignalRow("ETH/USDT")];
    const fetcher: SignalsFetcher = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes("BTC%2FUSDT")) return { success: true, data: { signals: btcRows } };
      if (path.includes("ETH%2FUSDT")) return { success: true, data: { signals: ethRows } };
      return { success: false, error: { code: "x", message: "x" } };
    });

    const btc = await fetchSignalsForPair("BTC/USDT", fetcher);
    const eth = await fetchSignalsForPair("ETH/USDT", fetcher);
    expect(btc).toEqual(btcRows);
    expect(eth).toEqual(ethRows);
    expect(__getSignalCacheSizeForTests()).toBe(2);
  });
});

// ── fuzzyScore ────────────────────────────────────────────────────────────────

describe("fuzzyScore", () => {
  it("returns 0.5 for empty query (all symbols match equally)", () => {
    expect(fuzzyScore("", "BTC")).toBe(0.5);
  });

  it("returns 1.0 for exact match (case-insensitive)", () => {
    expect(fuzzyScore("BTC", "BTC")).toBe(1.0);
    expect(fuzzyScore("btc", "BTC")).toBe(1.0);
  });

  it("returns 0.8 for prefix match", () => {
    expect(fuzzyScore("BT", "BTC")).toBe(0.8);
    expect(fuzzyScore("et", "ETH")).toBe(0.8);
  });

  it("returns 0.5 for substring match (not prefix)", () => {
    // "OL" is a substring of "SOL" but not a prefix
    expect(fuzzyScore("OL", "SOL")).toBe(0.5);
  });

  it("returns 0 for no match", () => {
    expect(fuzzyScore("xyz", "BTC")).toBe(0);
  });

  it("surfaces ETH/USDT as top fuzzy result for 'eth'", () => {
    expect(fuzzyScore("eth", "ETH")).toBeGreaterThan(0);
    expect(fuzzyScore("eth", "BTC")).toBe(0);
  });
});

// ── recencyFactor ─────────────────────────────────────────────────────────────

const TS_KEY = "q.cmdk.recent.ts";
const NOW = 1_700_000_000_000; // fixed epoch for deterministic tests

describe("recencyFactor", () => {
  it("returns 0 for a symbol not in recent list", () => {
    expect(recencyFactor("XRP", ["BTC", "ETH"], NOW)).toBe(0);
  });

  it("returns 1.0 when symbol was used less than 1 hour ago", () => {
    const ts = NOW - 30 * 60 * 1000; // 30 min ago
    localStorageMock.setItem(TS_KEY, JSON.stringify({ BTC: ts }));
    expect(recencyFactor("BTC", ["BTC"], NOW)).toBe(1.0);
  });

  it("returns 0.5 when symbol was used today (1h–24h ago)", () => {
    const ts = NOW - 4 * 3600 * 1000; // 4 hours ago
    localStorageMock.setItem(TS_KEY, JSON.stringify({ ETH: ts }));
    expect(recencyFactor("ETH", ["ETH"], NOW)).toBe(0.5);
  });

  it("returns 0.1 when symbol was used within the past week", () => {
    const ts = NOW - 3 * 86_400_000; // 3 days ago
    localStorageMock.setItem(TS_KEY, JSON.stringify({ SOL: ts }));
    expect(recencyFactor("SOL", ["SOL"], NOW)).toBe(0.1);
  });

  it("returns 0 when symbol was used more than a week ago", () => {
    const ts = NOW - 10 * 86_400_000; // 10 days ago
    localStorageMock.setItem(TS_KEY, JSON.stringify({ DOGE: ts }));
    expect(recencyFactor("DOGE", ["DOGE"], NOW)).toBe(0);
  });

  it("uses position-based fallback when no timestamp is stored", () => {
    // No TS_KEY set; BTC at index 0 gets 1.0, ETH at index 1 gets 0.5
    const factor0 = recencyFactor("BTC", ["BTC", "ETH", "SOL"], NOW);
    const factor1 = recencyFactor("ETH", ["BTC", "ETH", "SOL"], NOW);
    expect(factor0).toBe(1.0);
    expect(factor1).toBe(0.5);
  });
});

// ── scoreMarket ───────────────────────────────────────────────────────────────

describe("scoreMarket", () => {
  it("returns 0 for a pair that does not fuzzy-match the query", () => {
    expect(scoreMarket("ETH/USDT", "btc", [], NOW)).toBe(0);
  });

  it("ranks BTC above other 'b' matches when BTC is recent", () => {
    // BTC is recent (<1h) → recency=1.0; suppose DOGE starts with 'd', not 'b'
    // Use "b" query: BTC prefix-matches (0.8), recency 1.0 → 0.8*0.6 + 1.0*0.4 = 0.88
    const ts = NOW - 10 * 60 * 1000; // 10 min ago
    localStorageMock.setItem(TS_KEY, JSON.stringify({ BTC: ts }));
    const btcScore = scoreMarket("BTC/USDT", "b", ["BTC"], NOW);
    expect(btcScore).toBeCloseTo(0.88);
  });

  it("gives correct composite score for exact match + no recency", () => {
    // fuzzy=1.0, recency=0 → 0.6*1.0 + 0.4*0 = 0.6
    expect(scoreMarket("ETH/USDT", "eth", [], NOW)).toBeCloseTo(0.6);
  });
});

// ── rankMarkets ───────────────────────────────────────────────────────────────

describe("rankMarkets", () => {
  it("surfaces ETH/USDT as the top result for query 'eth'", () => {
    const results = rankMarkets("eth", [], NOW);
    expect(results[0].pair).toBe("ETH/USDT");
  });

  it("returns an empty array when query matches no pair", () => {
    const results = rankMarkets("zzz", [], NOW);
    expect(results).toHaveLength(0);
  });

  it("ranks BTC above non-matching 'b' symbols when BTC is recent (recency weighting)", () => {
    // With query "b", BTC prefix-matches (0.8); with BTC recent (<1h) score is 0.88.
    // DOGE starts with 'd' → no match; only BTC matches "b" in our PAIRS.
    const ts = NOW - 10 * 60 * 1000;
    localStorageMock.setItem(TS_KEY, JSON.stringify({ BTC: ts }));
    const results = rankMarkets("b", ["BTC"], NOW);
    expect(results[0].symbol).toBe("BTC");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("all pairs appear when query is empty (empty query → fuzz=0.5 > 0)", () => {
    const results = rankMarkets("", [], NOW);
    // All PAIRS should appear since fuzzyScore("", sym) = 0.5 > 0
    expect(results.length).toBeGreaterThan(0);
  });

  it("rankMarkets returns all pairs for empty query but UI hides Markets section (issue #329)", () => {
    // rankMarkets itself returns rows for empty query — the UI-level guard
    // `query !== ""` is what prevents the Markets section from appearing in
    // the empty state, deduplicated against Recent (BTC/ETH/SOL default).
    // This test documents that rankMarkets is NOT the gating logic.
    const emptyQueryResults = rankMarkets("", ["BTC", "ETH", "SOL"], NOW);
    const nonEmptyQueryResults = rankMarkets("btc", ["BTC", "ETH", "SOL"], NOW);
    // Both return results — the UI applies `query !== ""` to hide Markets on empty state.
    expect(emptyQueryResults.length).toBeGreaterThan(0);
    expect(nonEmptyQueryResults.length).toBeGreaterThan(0);
    // BTC is the top result when query is "btc"
    expect(nonEmptyQueryResults[0].symbol).toBe("BTC");
  });
});

// ── touchRecentTimestamp ──────────────────────────────────────────────────────

describe("touchRecentTimestamp", () => {
  it("writes a timestamp for the given symbol", () => {
    touchRecentTimestamp("SOL", NOW);
    const raw = localStorageMock.getItem(TS_KEY);
    expect(raw).not.toBeNull();
    const ts = JSON.parse(raw ?? "{}") as Record<string, number>;
    expect(ts["SOL"]).toBe(NOW);
  });

  it("updates an existing timestamp without clearing others", () => {
    localStorageMock.setItem(TS_KEY, JSON.stringify({ BTC: 1234 }));
    touchRecentTimestamp("ETH", NOW);
    const raw = localStorageMock.getItem(TS_KEY);
    const ts = JSON.parse(raw ?? "{}") as Record<string, number>;
    expect(ts["BTC"]).toBe(1234);
    expect(ts["ETH"]).toBe(NOW);
  });
});

// ── pushRecentSymbol bumps Recent (select-row effect) ─────────────────────────

describe("select-row effect: pushRecentSymbol bumps Recent", () => {
  it("after selecting ETH, ETH is in the #1 slot of Recent", () => {
    localStorageMock.setItem(LS_KEY, JSON.stringify(["BTC", "SOL", "XRP"]));
    const updated = pushRecentSymbol("ETH");
    expect(updated[0]).toBe("ETH");
    expect(updated).toContain("BTC");
    expect(updated).toContain("SOL");
  });

  it("selecting the same symbol twice keeps it at #1 (dedup)", () => {
    localStorageMock.setItem(LS_KEY, JSON.stringify(["BTC", "ETH", "SOL"]));
    pushRecentSymbol("ETH");
    const result = pushRecentSymbol("ETH");
    expect(result[0]).toBe("ETH");
    expect(result.filter((s) => s === "ETH")).toHaveLength(1);
  });
});

// ── fetchSignalsAllSymbols (issue #332 — cross-symbol label search) ───────────

describe("fetchSignalsAllSymbols", () => {
  beforeEach(() => __resetSignalCacheForTests());

  const row = (pair = "BTC/USDT"): BlendedSignal => ({
    pair,
    type: "buy",
    confidence: 0.6,
    volatilityFlag: false,
    gateReason: null,
    rulesFired: [],
    perTimeframe: {} as BlendedSignal["perTimeframe"],
    weightsUsed: {} as BlendedSignal["weightsUsed"],
    asOf: Date.now(),
    emittingTimeframe: "15m" as BlendedSignal["emittingTimeframe"],
    risk: null,
  });
  const ok = (signals: BlendedSignal[]) => ({ success: true as const, data: { signals } });
  const err = (code: string) => ({ success: false as const, error: { code, message: code } });

  // Table-driven return-value cases: empty-query (no fetch), error envelope,
  // ABORTED code, fetcher-throws. AbortSignal case is separate (needs ctrl).
  it.each([
    ["empty q → [] without calling fetcher", "", () => vi.fn(), [], 0, undefined],
    [
      "error envelope → [] and no cache entry",
      "buy",
      () => vi.fn().mockResolvedValue(err("HTTP_500")),
      [],
      1,
      0,
    ],
    [
      "ABORTED envelope → null",
      "buy",
      () => vi.fn().mockResolvedValue(err("ABORTED")),
      null,
      1,
      undefined,
    ],
    [
      "fetcher throws → [] (warn)",
      "buy",
      () => vi.fn().mockRejectedValue(new Error("net")),
      [],
      1,
      undefined,
    ],
  ] as const)("%s", async (_n, q, mkFetcher, expected, calls, cacheSize) => {
    const fetcher = mkFetcher() as unknown as SignalsFetcher;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await fetchSignalsAllSymbols(q, fetcher)).toEqual(expected);
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(calls);
    if (cacheSize !== undefined) expect(__getSignalCacheSizeForTests()).toBe(cacheSize);
    warnSpy.mockRestore();
  });

  it("AbortSignal firing after fetch resolves → null", async () => {
    const ctrl = new AbortController();
    const fetcher: SignalsFetcher = vi.fn().mockImplementation(async () => {
      ctrl.abort();
      return ok([row()]);
    });
    expect(await fetchSignalsAllSymbols("buy", fetcher, ctrl.signal)).toBeNull();
  });

  it("hits /api/admin/signals?q=<label>&limit=20, caches per-q, and stays independent from per-pair entries", async () => {
    const sameQ = [row("BTC/USDT"), row("ETH/USDT")];
    const otherQ = [row("ETH/USDT")];
    const pair = [row("BTC/USDT")];
    const fetcher: SignalsFetcher = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes("pair=")) return ok(pair);
      if (path.includes("q=sell")) return ok(otherQ);
      return ok(sameQ);
    });
    const calls = () => (fetcher as ReturnType<typeof vi.fn>).mock.calls;

    // First call: URL encoded correctly + returns signals.
    expect(await fetchSignalsAllSymbols("bull div", fetcher)).toEqual(sameQ);
    const url = calls()[0]?.[0] as string;
    expect(url).toContain("q=bull%20div");
    expect(url).toContain("limit=20");

    // Same q again → cached (still 1 fetch).
    expect(await fetchSignalsAllSymbols("bull div", fetcher)).toEqual(sameQ);
    expect(calls()).toHaveLength(1);

    // Different q → another fetch (independent cache keys).
    expect(await fetchSignalsAllSymbols("sell", fetcher)).toEqual(otherQ);
    expect(calls()).toHaveLength(2);

    // Per-pair entry coexists with cross-symbol entries → 3 distinct cache keys.
    await fetchSignalsForPair("BTC/USDT", fetcher);
    expect(__getSignalCacheSizeForTests()).toBe(3);
    expect(calls()).toHaveLength(3);
  });
});
