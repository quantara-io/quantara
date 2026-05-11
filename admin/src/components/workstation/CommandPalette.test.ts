/**
 * Unit tests for CommandPalette localStorage helpers and signal utilities.
 *
 * The vitest config uses environment:"node" and includes only *.test.ts,
 * so React rendering tests are covered by manual test plan. These tests cover
 * the pure-logic exports: loadRecentSymbols, pushRecentSymbol, signalStrengthLabel,
 * signalTone, and formatSignalDate.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  loadRecentSymbols,
  pushRecentSymbol,
  signalStrengthLabel,
  signalTone,
  formatSignalDate,
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
