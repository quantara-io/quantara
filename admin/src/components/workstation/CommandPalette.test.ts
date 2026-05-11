/**
 * Unit tests for CommandPalette localStorage helpers and signal utilities.
 *
 * The vitest config uses environment:"node" and includes only *.test.ts,
 * so React rendering tests are covered by manual test plan. These tests cover
 * the pure-logic exports: loadRecentSymbols, pushRecentSymbol, signalStrengthLabel,
 * signalTone, and formatSignalDate.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadRecentSymbols,
  pushRecentSymbol,
  signalStrengthLabel,
  signalTone,
  formatSignalDate,
  fetchSignalsForPair,
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
