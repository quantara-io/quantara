/**
 * cmdk-commands — Command registry for the ⌘K palette.
 *
 * Issue #316: /tf, /toggle commands.
 * Issue #331: /close command — wired to real backend handler.
 *
 * Design rules:
 *  - parse() is a pure function — no side effects, easy to unit-test.
 *  - run()   receives a WorkstationContext and may be async.
 *  - Commands are identified by their `name` string ("/tf", "/toggle", "/close");
 *    lookup is case-insensitive so "/Tf 4h" works.
 */

// ── WorkstationContext ────────────────────────────────────────────────────────

/**
 * Everything a command needs to interact with the Workstation.
 * Passed to run() at execution time; never stored in the registry.
 */
export interface WorkstationContext {
  /** Active trading pair, e.g. "BTC/USDT". */
  activePair: string;
  /** Current chart timeframe. */
  timeframe: Timeframe;
  /** Switch the active chart timeframe. */
  setTimeframe: (tf: Timeframe) => void;
  /** Chart overlay states. */
  overlays: OverlayState;
  /** Toggle a chart overlay. */
  setOverlays: (updater: (prev: OverlayState) => OverlayState) => void;
  /**
   * Close the active position for a symbol.
   * Calls POST /api/admin/positions/:id/close and clears the position from
   * the PositionRail. No-op when the position is already closed.
   */
  closePosition: (symbol: string) => Promise<void>;
}

export type Timeframe = "15m" | "1H" | "4H" | "1D" | "1W";

/** Valid overlay keys, ordered for display. */
export const OVERLAY_KEYS = ["ema20", "ema50", "volume"] as const;
export type OverlayKey = (typeof OVERLAY_KEYS)[number];

/**
 * Validate a raw string against the known overlay keys.
 * Returns the typed key on success or null on unknown input — the caller is
 * responsible for surfacing a helpful error message.
 */
export function parseOverlayKey(raw: string): OverlayKey | null {
  return (OVERLAY_KEYS as readonly string[]).includes(raw) ? (raw as OverlayKey) : null;
}

export interface OverlayState {
  ema20: boolean;
  ema50: boolean;
  volume: boolean;
}

// ── Command type ──────────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; payload: T } | { ok: false; error: string };

export interface Command<T = unknown> {
  /** Slash-prefixed identifier shown in the palette. */
  name: string;
  /** One-line human description. */
  description: string;
  /** Argument syntax hint. */
  args: string;
  /** Pure parse: validates and extracts typed payload from the raw arg string. */
  parse: (input: string) => ParseResult<T>;
  /** Execute the command using the workstation context. */
  run: (payload: T, ctx: WorkstationContext) => Promise<void> | void;
  /** Produce a human-readable preview from a successfully parsed payload. */
  preview: (payload: T, ctx: WorkstationContext) => string;
}

// ── /tf — Switch timeframe ────────────────────────────────────────────────────

const VALID_TIMEFRAMES: Timeframe[] = ["15m", "1H", "4H", "1D", "1W"];

/** Raw arg values the user types (lowercase accepted for friendliness). */
const TF_INPUT_MAP: Record<string, Timeframe> = {
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
  "1w": "1W",
};

export const tfCommand: Command<Timeframe> = {
  name: "/tf",
  description: "Switch chart timeframe",
  args: "<15m|1h|4h|1d|1w>",

  parse(input) {
    const arg = input.trim().toLowerCase();
    if (!arg) {
      return {
        ok: false,
        error: `Missing timeframe argument. Valid: ${VALID_TIMEFRAMES.join(", ")}`,
      };
    }
    const tf = TF_INPUT_MAP[arg];
    if (!tf) {
      return {
        ok: false,
        error: `Unknown timeframe "${arg}"; valid: 15m, 1h, 4h, 1d, 1w`,
      };
    }
    return { ok: true, payload: tf };
  },

  run(tf, ctx) {
    ctx.setTimeframe(tf);
  },

  preview(tf) {
    return `Will switch timeframe to ${tf}`;
  },
};

// ── /toggle — Toggle chart overlay ───────────────────────────────────────────

export interface TogglePayload {
  overlay: OverlayKey;
}

export const toggleCommand: Command<TogglePayload> = {
  name: "/toggle",
  description: "Toggle a chart overlay",
  args: "<ema20|ema50|volume>",

  parse(input) {
    const arg = input.trim().toLowerCase();
    if (!arg) {
      return {
        ok: false,
        error: `Missing overlay argument. Valid: ${OVERLAY_KEYS.join(", ")}`,
      };
    }
    const overlay = parseOverlayKey(arg);
    if (!overlay) {
      return {
        ok: false,
        error: `Unknown overlay "${arg}"; valid: ${OVERLAY_KEYS.join(", ")}`,
      };
    }
    return { ok: true, payload: { overlay } };
  },

  run({ overlay }, ctx) {
    ctx.setOverlays((prev) => ({ ...prev, [overlay]: !prev[overlay] }));
  },

  preview({ overlay }, ctx) {
    const current = ctx.overlays[overlay];
    return `Will ${current ? "hide" : "show"} ${overlay} overlay`;
  },
};

// ── /close — Close active position ───────────────────────────────────────────

/** Payload carries the normalised symbol (e.g. "BTC") extracted from user input. */
export interface ClosePayload {
  /** Upper-cased symbol extracted from user input, e.g. "BTC". */
  symbol: string;
}

/**
 * Convert a symbol ("BTC") to the positionId slug expected by the backend
 * ("/api/admin/positions/BTC-USDT/close"). All Quantara pairs are vs USDT.
 */
export function symbolToPositionId(symbol: string): string {
  return `${symbol.toUpperCase()}-USDT`;
}

export const closeCommand: Command<ClosePayload> = {
  name: "/close",
  description: "Close active position for a symbol",
  args: "<symbol>",

  parse(input) {
    const arg = input.trim().toUpperCase();
    if (!arg) {
      return { ok: false, error: "Missing symbol argument. Example: /close BTC" };
    }
    // Basic sanity: 2–10 chars, uppercase letters and/or digits. Real-world
    // tickers like 1INCH include a leading digit, so we accept any [A-Z0-9]
    // mix while still requiring at least one alphabetic character (purely
    // numeric strings like "1234" are not tickers).
    if (!/^[A-Z0-9]{2,10}$/.test(arg) || !/[A-Z]/.test(arg)) {
      return {
        ok: false,
        error: `"${arg}" is not a valid symbol. Use the base currency, e.g. BTC, ETH, SOL`,
      };
    }
    return { ok: true, payload: { symbol: arg } };
  },

  async run({ symbol }, ctx) {
    await ctx.closePosition(symbol);
  },

  preview({ symbol }) {
    return `Will close ${symbol}/USDT position via POST /api/admin/positions/${symbolToPositionId(symbol)}/close`;
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

// Store as Command<unknown> so the registry is uniform.
// Callers that need the typed payload use the individual exports above.
const REGISTRY: Command<unknown>[] = [
  tfCommand as Command<unknown>,
  toggleCommand as Command<unknown>,
  closeCommand as Command<unknown>,
];

/**
 * Look up a command by its name (e.g. "/tf").  Case-insensitive — so "/Tf"
 * and "/TF" both find /tf.
 * Returns `undefined` for unknown commands.
 */
export function lookupCommand(name: string): Command<unknown> | undefined {
  const key = name.toLowerCase();
  return REGISTRY.find((c) => c.name.toLowerCase() === key);
}

/**
 * All registered commands, ordered for display.
 */
export function allCommands(): Command<unknown>[] {
  return [...REGISTRY];
}

/**
 * Parse a raw palette input that starts with "/".
 *
 * Returns either:
 *   - `{ mode: "list", filter }` — only "/" or "/partial" (no space yet): show filtered list
 *   - `{ mode: "unknown", name }` — command name typed but not in registry
 *   - `{ mode: "parse", command, result }` — command found, parse result available
 */
export type CommandParseMode =
  | { mode: "list"; filter: string }
  | { mode: "unknown"; name: string }
  | { mode: "parse"; command: Command<unknown>; result: ParseResult<unknown> };

export function parseCommandInput(raw: string): CommandParseMode {
  // raw always starts with "/".
  const withoutSlash = raw.slice(1); // e.g. "tf 4h" or "tf" or ""

  const spaceIdx = withoutSlash.indexOf(" ");

  if (spaceIdx === -1) {
    // No space yet: user is still typing the command name.
    return { mode: "list", filter: withoutSlash.toLowerCase() };
  }

  // Normalise the typed name to lowercase so "/Tf 4h" routes to /tf.
  const name = "/" + withoutSlash.slice(0, spaceIdx).toLowerCase(); // e.g. "/tf"
  const args = withoutSlash.slice(spaceIdx + 1); // e.g. "4h"

  const command = lookupCommand(name);
  if (!command) {
    return { mode: "unknown", name };
  }

  return { mode: "parse", command, result: command.parse(args) };
}
