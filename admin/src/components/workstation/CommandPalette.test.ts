/**
 * Unit tests for CommandPalette localStorage helpers.
 *
 * The vitest config uses environment:"node" and includes only *.test.ts,
 * so React rendering tests are covered by manual test plan. These tests cover
 * the pure-logic exports: loadRecentSymbols and pushRecentSymbol.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { loadRecentSymbols, pushRecentSymbol } from "./CommandPalette";

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
