/**
 * Unit tests for cmdk-commands.ts
 *
 * Covers: parse() for all three commands, registry lookup, parseCommandInput.
 * Pure-logic only — no React, no DOM, no side effects.
 */

import { describe, it, expect, vi } from "vitest";

import {
  tfCommand,
  closeCommand,
  toggleCommand,
  lookupCommand,
  allCommands,
  parseCommandInput,
  type WorkstationContext,
  type OverlayState,
  type PositionSnapshot,
} from "./cmdk-commands";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<WorkstationContext>): WorkstationContext {
  return {
    activePair: "BTC/USDT",
    timeframe: "1H",
    setTimeframe: vi.fn(),
    overlays: { ema20: false, ema50: false, volume: true },
    setOverlays: vi.fn(),
    closePosition: vi.fn(),
    position: null,
    ...overrides,
  };
}

const MOCK_POSITION: PositionSnapshot = {
  symbol: "BTC",
  size: 0.42,
  mark: 72_092,
  pnl: 1_059_746,
};

// ── /tf parse ────────────────────────────────────────────────────────────────

describe("tfCommand.parse", () => {
  it.each([
    ["15m", "15m"],
    ["1h", "1H"],
    ["4h", "4H"],
    ["1d", "1D"],
    ["1w", "1W"],
    // case-insensitive
    ["4H", "4H"],
    ["1D", "1D"],
  ])("accepts %s → %s", (input, expected) => {
    const result = tfCommand.parse(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toBe(expected);
  });

  it("rejects empty input", () => {
    const result = tfCommand.parse("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Missing timeframe/);
  });

  it("rejects whitespace-only input", () => {
    const result = tfCommand.parse("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects unknown timeframe '5m'", () => {
    const result = tfCommand.parse("5m");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/5m/);
      expect(result.error).toMatch(/valid/i);
    }
  });

  it("rejects unknown timeframe '2h'", () => {
    const result = tfCommand.parse("2h");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/2h/);
  });
});

// ── /tf run + preview ─────────────────────────────────────────────────────────

describe("tfCommand.run", () => {
  it("calls setTimeframe with the parsed value", () => {
    const ctx = makeCtx();
    tfCommand.run("4H", ctx);
    expect(ctx.setTimeframe).toHaveBeenCalledWith("4H");
  });
});

describe("tfCommand.preview", () => {
  it("returns a human-readable message for 4H", () => {
    const ctx = makeCtx();
    expect(tfCommand.preview("4H", ctx)).toBe("Will switch timeframe to 4H");
  });
});

// ── /close parse ──────────────────────────────────────────────────────────────

describe("closeCommand.parse", () => {
  it.each(["BTC", "ETH", "SOL", "DOGE", "AVAX"])("accepts valid symbol %s", (sym) => {
    const result = closeCommand.parse(sym);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual({ symbol: sym });
  });

  it("uppercases lowercase input", () => {
    const result = closeCommand.parse("btc");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual({ symbol: "BTC" });
  });

  it("rejects empty input", () => {
    const result = closeCommand.parse("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Missing symbol/);
  });

  it("rejects symbol with digits", () => {
    const result = closeCommand.parse("BTC1");
    expect(result.ok).toBe(false);
  });

  it("rejects symbol that is too short (1 char)", () => {
    const result = closeCommand.parse("B");
    expect(result.ok).toBe(false);
  });

  it("rejects symbol that is too long (11 chars)", () => {
    const result = closeCommand.parse("ABCDEFGHIJK");
    expect(result.ok).toBe(false);
  });
});

// ── /close run + preview ──────────────────────────────────────────────────────

describe("closeCommand.run", () => {
  it("calls closePosition with the symbol", () => {
    const ctx = makeCtx();
    closeCommand.run({ symbol: "BTC" }, ctx);
    expect(ctx.closePosition).toHaveBeenCalledWith("BTC");
  });
});

describe("closeCommand.preview", () => {
  it("shows position details when position exists for the symbol", () => {
    const ctx = makeCtx({ position: MOCK_POSITION });
    const preview = closeCommand.preview({ symbol: "BTC" }, ctx);
    expect(preview).toMatch(/0\.42 BTC/);
    expect(preview).toMatch(/MARK/);
    expect(preview).toMatch(/PnL/);
    expect(preview).toMatch(/1,059,746/);
  });

  it("shows generic preview when no position exists", () => {
    const ctx = makeCtx({ position: null });
    const preview = closeCommand.preview({ symbol: "BTC" }, ctx);
    expect(preview).toMatch(/BTC/);
    expect(preview).toMatch(/position/i);
  });

  it("shows generic preview when position is for a different symbol", () => {
    const ctx = makeCtx({ position: { symbol: "ETH", size: 1, mark: 3000, pnl: 100 } });
    const preview = closeCommand.preview({ symbol: "BTC" }, ctx);
    // Not matching ETH position data — generic fallback
    expect(preview).toMatch(/BTC/);
  });

  it("shows positive pnl with '+' prefix", () => {
    const ctx = makeCtx({ position: MOCK_POSITION });
    const preview = closeCommand.preview({ symbol: "BTC" }, ctx);
    expect(preview).toContain("+");
  });

  it("shows negative pnl without '+' prefix", () => {
    const ctx = makeCtx({ position: { symbol: "BTC", size: 1, mark: 60000, pnl: -500 } });
    const preview = closeCommand.preview({ symbol: "BTC" }, ctx);
    expect(preview).not.toContain("+-");
    expect(preview).toContain("-");
  });
});

// ── /toggle parse ─────────────────────────────────────────────────────────────

describe("toggleCommand.parse", () => {
  it.each(["ema20", "ema50", "volume"])("accepts valid overlay %s", (ov) => {
    const result = toggleCommand.parse(ov);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual({ overlay: ov });
  });

  it("accepts uppercase input (case-insensitive)", () => {
    const result = toggleCommand.parse("EMA20");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual({ overlay: "ema20" });
  });

  it("rejects empty input", () => {
    const result = toggleCommand.parse("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Missing overlay/);
  });

  it("rejects unknown overlay 'macd'", () => {
    const result = toggleCommand.parse("macd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/macd/);
  });
});

// ── /toggle run + preview ─────────────────────────────────────────────────────

describe("toggleCommand.run", () => {
  it("calls setOverlays with a function that flips ema20 from false to true", () => {
    const ctx = makeCtx({ overlays: { ema20: false, ema50: false, volume: true } });
    toggleCommand.run({ overlay: "ema20" }, ctx);
    expect(ctx.setOverlays).toHaveBeenCalledTimes(1);
    // Invoke the updater to verify the toggle logic.
    const updater = vi.mocked(ctx.setOverlays).mock.calls[0][0];
    const prev: OverlayState = { ema20: false, ema50: false, volume: true };
    const next = updater(prev);
    expect(next).toEqual({ ema20: true, ema50: false, volume: true });
  });

  it("flips ema50 from true to false", () => {
    const ctx = makeCtx({ overlays: { ema20: true, ema50: true, volume: false } });
    toggleCommand.run({ overlay: "ema50" }, ctx);
    const updater = vi.mocked(ctx.setOverlays).mock.calls[0][0];
    const prev: OverlayState = { ema20: true, ema50: true, volume: false };
    expect(updater(prev)).toEqual({ ema20: true, ema50: false, volume: false });
  });
});

describe("toggleCommand.preview", () => {
  it("says 'show' when overlay is currently off", () => {
    const ctx = makeCtx({ overlays: { ema20: false, ema50: false, volume: true } });
    expect(toggleCommand.preview({ overlay: "ema20" }, ctx)).toMatch(/show/);
  });

  it("says 'hide' when overlay is currently on", () => {
    const ctx = makeCtx({ overlays: { ema20: true, ema50: false, volume: true } });
    expect(toggleCommand.preview({ overlay: "ema20" }, ctx)).toMatch(/hide/);
  });

  it("mentions the overlay name in the preview", () => {
    const ctx = makeCtx({ overlays: { ema20: false, ema50: false, volume: true } });
    expect(toggleCommand.preview({ overlay: "volume" }, ctx)).toMatch(/volume/);
  });
});

// ── Registry ──────────────────────────────────────────────────────────────────

describe("lookupCommand", () => {
  it("finds /tf", () => {
    expect(lookupCommand("/tf")).toBeDefined();
    expect(lookupCommand("/tf")?.name).toBe("/tf");
  });

  it("finds /close", () => {
    expect(lookupCommand("/close")).toBeDefined();
  });

  it("finds /toggle", () => {
    expect(lookupCommand("/toggle")).toBeDefined();
  });

  it("returns undefined for unknown command", () => {
    expect(lookupCommand("/foo")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(lookupCommand("")).toBeUndefined();
  });
});

describe("allCommands", () => {
  it("returns all three v0 commands", () => {
    const cmds = allCommands();
    const names = cmds.map((c) => c.name);
    expect(names).toContain("/tf");
    expect(names).toContain("/close");
    expect(names).toContain("/toggle");
  });

  it("returns a copy (mutation does not affect registry)", () => {
    const first = allCommands();
    first.push({ name: "/fake" } as never);
    const second = allCommands();
    expect(second.find((c) => c.name === "/fake")).toBeUndefined();
  });
});

// ── parseCommandInput ─────────────────────────────────────────────────────────

describe("parseCommandInput", () => {
  // list mode — no space yet
  it("returns list mode for '/'", () => {
    const r = parseCommandInput("/");
    expect(r.mode).toBe("list");
    if (r.mode === "list") expect(r.filter).toBe("");
  });

  it("returns list mode for '/tf' (no space)", () => {
    const r = parseCommandInput("/tf");
    expect(r.mode).toBe("list");
    if (r.mode === "list") expect(r.filter).toBe("tf");
  });

  it("returns list mode for '/clo' (partial)", () => {
    const r = parseCommandInput("/clo");
    expect(r.mode).toBe("list");
    if (r.mode === "list") expect(r.filter).toBe("clo");
  });

  // unknown command
  it("returns unknown mode for '/foo 4h'", () => {
    const r = parseCommandInput("/foo 4h");
    expect(r.mode).toBe("unknown");
    if (r.mode === "unknown") expect(r.name).toBe("/foo");
  });

  // parse mode — known command + space
  it("returns parse mode for '/tf 4h' with ok payload", () => {
    const r = parseCommandInput("/tf 4h");
    expect(r.mode).toBe("parse");
    if (r.mode === "parse") {
      expect(r.command.name).toBe("/tf");
      expect(r.result.ok).toBe(true);
    }
  });

  it("returns parse mode for '/tf 5m' with error", () => {
    const r = parseCommandInput("/tf 5m");
    expect(r.mode).toBe("parse");
    if (r.mode === "parse") {
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toMatch(/5m/);
    }
  });

  it("returns parse mode for '/close BTC' with ok payload", () => {
    const r = parseCommandInput("/close BTC");
    expect(r.mode).toBe("parse");
    if (r.mode === "parse") {
      expect(r.result.ok).toBe(true);
    }
  });

  it("returns parse mode for '/toggle ema20' with ok payload", () => {
    const r = parseCommandInput("/toggle ema20");
    expect(r.mode).toBe("parse");
    if (r.mode === "parse") {
      expect(r.result.ok).toBe(true);
    }
  });

  it("handles '/tf ' (space but no arg) → parse with error", () => {
    const r = parseCommandInput("/tf ");
    expect(r.mode).toBe("parse");
    if (r.mode === "parse") {
      expect(r.result.ok).toBe(false);
    }
  });
});
