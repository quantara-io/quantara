/**
 * Unit tests for cmdk-commands.ts
 *
 * Covers: parse() for both commands, registry lookup, parseCommandInput.
 * Pure-logic only — no React, no DOM, no side effects.
 *
 * NOTE: /close was deferred from the initial release of this palette section
 * (no real position-close handler exists). Re-introduction is tracked as a
 * follow-up issue from PR #326 review.
 */

import { describe, it, expect, vi } from "vitest";

import {
  tfCommand,
  toggleCommand,
  lookupCommand,
  allCommands,
  parseCommandInput,
  parseOverlayKey,
  type WorkstationContext,
  type OverlayState,
} from "./cmdk-commands";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<WorkstationContext>): WorkstationContext {
  return {
    activePair: "BTC/USDT",
    timeframe: "1H",
    setTimeframe: vi.fn(),
    overlays: { ema20: false, ema50: false, volume: true },
    setOverlays: vi.fn(),
    ...overrides,
  };
}

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

// ── parseOverlayKey ───────────────────────────────────────────────────────────

describe("parseOverlayKey", () => {
  it.each(["ema20", "ema50", "volume"])("accepts known overlay %s", (k) => {
    expect(parseOverlayKey(k)).toBe(k);
  });

  it("returns null for unknown overlay", () => {
    expect(parseOverlayKey("macd")).toBeNull();
    expect(parseOverlayKey("")).toBeNull();
    expect(parseOverlayKey("EMA20")).toBeNull(); // case-sensitive at the parser layer
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

  it("finds /toggle", () => {
    expect(lookupCommand("/toggle")).toBeDefined();
  });

  it("is case-insensitive", () => {
    expect(lookupCommand("/TF")?.name).toBe("/tf");
    expect(lookupCommand("/Tf")?.name).toBe("/tf");
    expect(lookupCommand("/Toggle")?.name).toBe("/toggle");
  });

  it("does not find /close (deferred)", () => {
    expect(lookupCommand("/close")).toBeUndefined();
  });

  it("returns undefined for unknown command", () => {
    expect(lookupCommand("/foo")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(lookupCommand("")).toBeUndefined();
  });
});

describe("allCommands", () => {
  it("returns the v0 commands (without deferred /close)", () => {
    const cmds = allCommands();
    const names = cmds.map((c) => c.name);
    expect(names).toContain("/tf");
    expect(names).toContain("/toggle");
    expect(names).not.toContain("/close");
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

  it("returns list mode for '/tog' (partial)", () => {
    const r = parseCommandInput("/tog");
    expect(r.mode).toBe("list");
    if (r.mode === "list") expect(r.filter).toBe("tog");
  });

  // unknown command
  it("returns unknown mode for '/foo 4h'", () => {
    const r = parseCommandInput("/foo 4h");
    expect(r.mode).toBe("unknown");
    if (r.mode === "unknown") expect(r.name).toBe("/foo");
  });

  it("returns unknown mode for '/close BTC' (deferred command)", () => {
    const r = parseCommandInput("/close BTC");
    expect(r.mode).toBe("unknown");
    if (r.mode === "unknown") expect(r.name).toBe("/close");
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

  it("is case-insensitive on the command name — '/Tf 4h' routes to /tf", () => {
    const r = parseCommandInput("/Tf 4h");
    expect(r.mode).toBe("parse");
    if (r.mode === "parse") {
      expect(r.command.name).toBe("/tf");
      expect(r.result.ok).toBe(true);
      if (r.result.ok) expect(r.result.payload).toBe("4H");
    }
  });

  it("is case-insensitive on the command name — '/TOGGLE ema20' routes to /toggle", () => {
    const r = parseCommandInput("/TOGGLE ema20");
    expect(r.mode).toBe("parse");
    if (r.mode === "parse") {
      expect(r.command.name).toBe("/toggle");
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

// ── Integration: end-to-end registry path ─────────────────────────────────────
//
// Asserts the COMMANDS registry is reachable via its public parse → run path
// using a mock CommandCtx. This is the closest we can get to "Enter actually
// triggers setTimeframe" without setting up a DOM environment for cmdk.
// (Vitest config is environment:"node", include:"src/**/*.test.ts".)

describe("COMMANDS registry — parse → run integration", () => {
  it("'/tf 4h' parses then runs ctx.setTimeframe('4H')", () => {
    const ctx = makeCtx();
    const parsed = parseCommandInput("/tf 4h");
    expect(parsed.mode).toBe("parse");
    if (parsed.mode !== "parse") return;
    expect(parsed.result.ok).toBe(true);
    if (!parsed.result.ok) return;
    void parsed.command.run(parsed.result.payload, ctx);
    expect(ctx.setTimeframe).toHaveBeenCalledTimes(1);
    expect(ctx.setTimeframe).toHaveBeenCalledWith("4H");
    expect(ctx.setOverlays).not.toHaveBeenCalled();
  });

  it("'/toggle ema20' parses then runs ctx.setOverlays() flipping ema20", () => {
    const ctx = makeCtx({ overlays: { ema20: false, ema50: false, volume: true } });
    const parsed = parseCommandInput("/toggle ema20");
    expect(parsed.mode).toBe("parse");
    if (parsed.mode !== "parse") return;
    expect(parsed.result.ok).toBe(true);
    if (!parsed.result.ok) return;
    void parsed.command.run(parsed.result.payload, ctx);
    expect(ctx.setOverlays).toHaveBeenCalledTimes(1);
    const updater = vi.mocked(ctx.setOverlays).mock.calls[0][0];
    expect(updater({ ema20: false, ema50: false, volume: true })).toEqual({
      ema20: true,
      ema50: false,
      volume: true,
    });
  });

  it("'/Tf 4h' (case-insensitive) reaches /tf and calls setTimeframe", () => {
    const ctx = makeCtx();
    const parsed = parseCommandInput("/Tf 4h");
    expect(parsed.mode).toBe("parse");
    if (parsed.mode !== "parse") return;
    if (!parsed.result.ok) throw new Error("expected ok parse");
    void parsed.command.run(parsed.result.payload, ctx);
    expect(ctx.setTimeframe).toHaveBeenCalledWith("4H");
  });
});
