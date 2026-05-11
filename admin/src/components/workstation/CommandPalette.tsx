/**
 * CommandPalette — ⌘K command palette shell for the Workstation.
 *
 * Issue #313: modal overlay, keybinding, Recent + Jump To sections.
 * Issue #315: Signals section — fetch by symbol with 30 s cache, # prefix mode.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import type { BlendedSignal } from "@quantara/shared";

import { apiFetch } from "../../lib/api";

// ── localStorage helpers ──────────────────────────────────────────────────────

const LS_KEY = "q.cmdk.recent";
const RECENT_MAX = 5;
const DEFAULT_RECENT = ["BTC", "ETH", "SOL"];

export function loadRecentSymbols(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_RECENT;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_RECENT;
    return parsed.slice(0, RECENT_MAX) as string[];
  } catch {
    return DEFAULT_RECENT;
  }
}

export function pushRecentSymbol(symbol: string): string[] {
  const current = loadRecentSymbols();
  // Remove duplicate then prepend.
  const next = [symbol, ...current.filter((s) => s !== symbol)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    // storage full — silent fail
  }
  return next;
}

// ── Jump To rows ─────────────────────────────────────────────────────────────

interface JumpRow {
  id: string;
  label: string;
  sublabel: string;
  href: string;
  action: "navigate" | "hash" | "noop";
}

const JUMP_ROWS: JumpRow[] = [
  {
    id: "alerts",
    label: "Active Alerts",
    sublabel: "Jump to alerts rail",
    href: "/#alerts",
    action: "hash",
  },
  {
    id: "watchlist",
    label: "Watchlist",
    sublabel: "Already visible",
    href: "#watchlist",
    action: "noop",
  },
  {
    id: "positions",
    label: "Positions",
    sublabel: "Already visible",
    href: "#positions",
    action: "noop",
  },
];

// ── Symbol meta lookup ────────────────────────────────────────────────────────

const SYMBOL_LABELS: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  XRP: "XRP",
  DOGE: "Dogecoin",
  AVAX: "Avalanche",
  LINK: "Chainlink",
};

function symbolLabel(sym: string): string {
  return SYMBOL_LABELS[sym] ?? sym;
}

// ── Signals section helpers ───────────────────────────────────────────────────

/** Maps symbol (e.g. "ETH") to full trading pair (e.g. "ETH/USDT"). */
function symbolToPair(symbol: string): string {
  return `${symbol.toUpperCase()}/USDT`;
}

/** Maps a trading pair back to the base symbol. */
function pairToSymbol(pair: string): string {
  return pair.split("/")[0] ?? pair;
}

/** Confidence chip label — mirrors SignalsRail's strengthFor logic. */
export function signalStrengthLabel(signal: BlendedSignal): string {
  const c = signal.confidence;
  if (signal.type === "strong-buy") return "Strong Buy";
  if (signal.type === "buy") return c >= 0.7 ? "Strong Buy" : "Buy";
  if (signal.type === "strong-sell") return "Strong Sell";
  if (signal.type === "sell") return c >= 0.7 ? "Strong Sell" : "Sell";
  if (signal.type === "hold") {
    if (signal.rulesFired.some((r) => /bull.*div|div.*bull/i.test(r))) return "Bull Div";
    if (signal.rulesFired.some((r) => /bear.*div|div.*bear/i.test(r))) return "Bear Div";
    if (signal.rulesFired.some((r) => /breakout/i.test(r))) return "Breakout";
    if (signal.rulesFired.some((r) => /rsi.*oversold|oversold/i.test(r))) return "RSI Oversold";
  }
  return signal.type;
}

/** Tone for the confidence chip badge. */
export function signalTone(
  signal: BlendedSignal,
): "up" | "down" | "warn" | "brand" | "neutral" | "outline" {
  if (signal.type === "strong-buy" || signal.type === "buy") return "up";
  if (signal.type === "strong-sell" || signal.type === "sell") return "down";
  return "warn";
}

/** Format asOf (unix ms) as "May 12, 09:00". */
export function formatSignalDate(asOf: number): string {
  return new Date(asOf).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── 30 s signal cache ─────────────────────────────────────────────────────────

const SIGNAL_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  signals: BlendedSignal[];
  fetchedAt: number;
}

/** Module-level cache so it survives palette open/close cycles. */
const signalCache = new Map<string, CacheEntry>();

function getCachedSignals(pair: string): BlendedSignal[] | null {
  const entry = signalCache.get(pair);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > SIGNAL_CACHE_TTL_MS) {
    signalCache.delete(pair);
    return null;
  }
  return entry.signals;
}

function setCachedSignals(pair: string, signals: BlendedSignal[]): void {
  signalCache.set(pair, { signals, fetchedAt: Date.now() });
}

// ── useSignals hook ───────────────────────────────────────────────────────────

type SignalFetchStatus = "idle" | "loading" | "done" | "error";

interface UseSignalsResult {
  signals: BlendedSignal[];
  status: SignalFetchStatus;
}

/**
 * Fetches signals for the given pair (e.g. "ETH/USDT") with a 30 s
 * module-level cache. Returns immediately from cache when available.
 * `pair` must be a full trading pair string or empty string (no fetch).
 */
function useSignals(pair: string): UseSignalsResult {
  const [signals, setSignals] = useState<BlendedSignal[]>([]);
  const [status, setStatus] = useState<SignalFetchStatus>("idle");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!pair) {
      setSignals([]);
      setStatus("idle");
      return;
    }

    // Cache hit — return immediately.
    const cached = getCachedSignals(pair);
    if (cached) {
      setSignals(cached);
      setStatus("done");
      return;
    }

    // Cancel any in-flight request for a previous pair.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus("loading");
    void (async () => {
      const res = await apiFetch<{ signals: BlendedSignal[] }>(
        `/api/admin/signals?pair=${encodeURIComponent(pair)}&limit=10`,
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return;
      if (res.success && res.data) {
        const fetched = res.data.signals ?? [];
        setCachedSignals(pair, fetched);
        setSignals(fetched);
        setStatus("done");
      } else if (res.error?.code === "ABORTED") {
        // stale request — ignore
      } else {
        setSignals([]);
        setStatus("error");
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [pair]);

  return { signals, status };
}

// ── Inline Badge (no import to keep file self-contained) ─────────────────────

type BadgeTone = "up" | "down" | "warn" | "brand" | "neutral" | "outline";

const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  up: "bg-up-soft text-up-strong border border-up/20",
  down: "bg-down-soft text-down-strong border border-down/20",
  warn: "bg-warn-soft text-warn border border-warn/20",
  brand: "bg-brand-soft text-brand-strong border border-brand/20",
  neutral: "bg-sunken text-ink2 border border-line",
  outline: "bg-transparent text-ink2 border border-line",
};

function ConfidenceChip({ signal }: { signal: BlendedSignal }) {
  const tone = signalTone(signal);
  const label = signalStrengthLabel(signal);
  return (
    <span
      className={`inline-flex items-center rounded font-medium uppercase tracking-wider text-2xs px-1.5 py-0.5 shrink-0 ${BADGE_TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}

// ── SignalsSection component ──────────────────────────────────────────────────

interface SignalsSectionProps {
  /** Full trading pair, e.g. "ETH/USDT". Empty string = fetch nothing. */
  pair: string;
  /** Whether the palette is in # (signal-only) mode. Controls heading label. */
  hashMode: boolean;
  /** Called when user selects a signal row. */
  onSelect: (signal: BlendedSignal) => void;
}

function SignalsSection({ pair, hashMode, onSelect }: SignalsSectionProps) {
  const { signals, status } = useSignals(pair);
  const sym = pairToSymbol(pair);

  const heading = hashMode ? `Signals (recent)` : pair ? `Signals · ${sym}` : "Signals (recent)";

  const showSkeleton = status === "loading";
  const showEmpty = status === "done" && signals.length === 0;
  const showRows = status === "done" && signals.length > 0;

  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted2 border-t border-line"
    >
      {showSkeleton && (
        <>
          <SignalSkeletonRow />
          <SignalSkeletonRow />
          <SignalSkeletonRow />
        </>
      )}
      {showEmpty && (
        <div className="px-4 py-3 text-sm text-muted2">No recent signals for {sym}</div>
      )}
      {showRows &&
        signals.map((signal) => (
          <Command.Item
            key={`${signal.pair}-${signal.asOf}`}
            value={`signal ${signal.pair} ${signalStrengthLabel(signal)} ${pairToSymbol(signal.pair)}`}
            onSelect={() => onSelect(signal)}
            className="flex items-center gap-3 px-4 py-2.5 cursor-pointer text-sm text-ink aria-selected:bg-sunken transition-colors"
          >
            <ConfidenceChip signal={signal} />
            <span className="flex-1 min-w-0 truncate text-xs text-muted2">
              {pairToSymbol(signal.pair)}
            </span>
            <span className="text-xs text-muted2 shrink-0 tabular-nums">
              {formatSignalDate(signal.asOf)}
            </span>
          </Command.Item>
        ))}
    </Command.Group>
  );
}

function SignalSkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 animate-pulse">
      <span className="h-4 w-16 rounded bg-sunken shrink-0" />
      <span className="h-3 w-10 rounded bg-sunken flex-1" />
      <span className="h-3 w-20 rounded bg-sunken shrink-0" />
    </div>
  );
}

// ── CommandPalette component ──────────────────────────────────────────────────

/** Payload passed to onSelectSignal. */
export interface SignalSelection {
  /** Full trading pair, e.g. "ETH/USDT". */
  pair: string;
  /** Unix ms timestamp of the signal's asOf — chart should anchor here. */
  asOf: number;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Called when user selects a symbol from Recent */
  onSelectSymbol?: (symbol: string) => void;
  /**
   * Called when user selects a signal row.
   * Caller is responsible for switching activePair to `pair` AND
   * seeking the chart viewport to `asOf`.
   */
  onSelectSignal?: (selection: SignalSelection) => void;
}

export function CommandPalette({
  open,
  onClose,
  onSelectSymbol,
  onSelectSignal,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => loadRecentSymbols());
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Capture trigger element on open so we can restore focus on close.
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement;
      // cmdk focuses the input automatically; ensure after paint.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    } else {
      // Restore focus to the trigger when palette is dismissed.
      triggerRef.current?.focus();
      triggerRef.current = null;
      // Reset query on close.
      setQuery("");
    }
  }, [open]);

  // Reload recent from localStorage each time palette opens.
  useEffect(() => {
    if (open) {
      setRecent(loadRecentSymbols());
    }
  }, [open]);

  // ── Parse query for signal mode ─────────────────────────────────────────────

  /**
   * `#` prefix activates signal-only mode.
   * "#bull div" → { hashMode: true, symbolQuery: "bull div" }
   * "eth"       → { hashMode: false, symbolQuery: "eth" }
   */
  const hashMode = query.startsWith("#");
  const symbolQuery = hashMode ? query.slice(1).trim() : query.trim();

  /**
   * The pair to fetch signals for:
   *   - In hash mode: use symbolQuery as a symbol prefix to find a matching pair.
   *     If no match, use the first entry in recent as a fallback (still shows all).
   *   - In normal mode: derive from the first recognisable symbol in the query.
   */
  const signalPair: string = (() => {
    if (hashMode) {
      // Try to match the rest of the query as a symbol (e.g. "#eth" → "ETH/USDT").
      const upper = symbolQuery.toUpperCase();
      const match = [...Object.keys(SYMBOL_LABELS), ...loadRecentSymbols()].find((s) =>
        s.startsWith(upper),
      );
      // If the query isn't a symbol prefix, show recent signals (use first recent pair).
      if (match) return symbolToPair(match);
      const firstRecent = loadRecentSymbols()[0];
      return firstRecent ? symbolToPair(firstRecent) : "";
    }
    // Normal mode: try to find a matching symbol in the query.
    const upper = symbolQuery.toUpperCase();
    const match = [...Object.keys(SYMBOL_LABELS), ...loadRecentSymbols()].find(
      (s) => s === upper || s.startsWith(upper),
    );
    return match ? symbolToPair(match) : "";
  })();

  const handleSelectSymbol = useCallback(
    (symbol: string) => {
      const updated = pushRecentSymbol(symbol);
      setRecent(updated);
      onSelectSymbol?.(symbol);
      onClose();
    },
    [onSelectSymbol, onClose],
  );

  const handleSelectJump = useCallback(
    (row: JumpRow) => {
      if (row.action === "navigate") {
        navigate(row.href);
      }
      // hash / noop: no-op for now (future: scroll to section)
      onClose();
    },
    [navigate, onClose],
  );

  const handleSelectSignal = useCallback(
    (signal: BlendedSignal) => {
      const sym = pairToSymbol(signal.pair);
      pushRecentSymbol(sym);
      onSelectSignal?.({ pair: signal.pair, asOf: signal.asOf });
      onClose();
    },
    [onSelectSignal, onClose],
  );

  if (!open) return null;

  return (
    // Backdrop — dim overlay, clicking closes the palette.
    // Escape on the wrapper closes the palette (cmdk's base Command primitive
    // does not handle Escape; only Command.Dialog wraps Radix dialog).
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4"
      aria-hidden="false"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {/* Dim backdrop */}
      <div
        className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
        aria-hidden="true"
        onMouseDown={onClose}
      />

      {/* Modal shell */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative z-10 w-full max-w-2xl rounded-xl border border-line bg-paper shadow-xl ring-1 ring-black/10 dark:ring-white/10 overflow-hidden"
        // Prevent backdrop click from firing through the panel.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" loop>
          {/* ── Search input ── */}
          <div className="flex items-center gap-2.5 px-4 border-b border-line">
            {hashMode ? <HashIcon /> : <SearchIcon />}
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder={
                hashMode
                  ? "Signal filter… (type a symbol or rule)"
                  : "Search markets, signals, jump to…"
              }
              className="flex-1 h-12 bg-transparent text-sm text-ink placeholder:text-muted2 outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-muted2 hover:text-ink transition-colors"
              >
                <CloseSmIcon />
              </button>
            )}
          </div>

          {/* ── List (empty state or search results) ── */}
          <Command.List className="max-h-[420px] overflow-y-auto overscroll-contain">
            <Command.Empty className="py-8 text-center text-sm text-muted2">
              No results for &quot;{query}&quot;
            </Command.Empty>

            {/* Recent symbols — hidden in # mode (signal-only). */}
            {!hashMode && (
              <Command.Group
                heading="Recent"
                className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted2"
              >
                {recent.map((sym, idx) => (
                  <Command.Item
                    key={sym}
                    value={`${sym} ${symbolLabel(sym)}`}
                    onSelect={() => handleSelectSymbol(sym)}
                    className="flex items-center gap-3 px-4 py-2.5 cursor-pointer text-sm text-ink aria-selected:bg-sunken transition-colors"
                  >
                    <span className="w-6 h-6 rounded-full bg-brand-soft flex items-center justify-center shrink-0">
                      <span className="text-2xs font-semibold text-brand">{sym[0]}</span>
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="font-medium">{sym}</span>
                      <span className="ml-2 text-muted2 text-xs">{symbolLabel(sym)}</span>
                    </span>
                    {idx < 9 && (
                      <kbd className="text-2xs text-muted2 font-mono bg-sunken border border-line rounded px-1 shrink-0">
                        ⌘{idx + 1}
                      </kbd>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Signals section */}
            {signalPair && (
              <SignalsSection pair={signalPair} hashMode={hashMode} onSelect={handleSelectSignal} />
            )}

            {/* Jump To — hidden in # mode */}
            {!hashMode && (
              <Command.Group
                heading="Jump To"
                className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted2 border-t border-line"
              >
                {JUMP_ROWS.map((row) => (
                  <Command.Item
                    key={row.id}
                    value={`${row.label} ${row.sublabel}`}
                    onSelect={() => handleSelectJump(row)}
                    className="flex items-center gap-3 px-4 py-2.5 cursor-pointer text-sm text-ink aria-selected:bg-sunken transition-colors"
                  >
                    <span className="w-6 h-6 rounded-full bg-sunken border border-line flex items-center justify-center shrink-0">
                      <ArrowRightIcon />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="font-medium">{row.label}</span>
                      <span className="ml-2 text-muted2 text-xs">{row.sublabel}</span>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>

          {/* ── Footer hint ── */}
          <div className="flex items-center gap-3 px-4 py-2 border-t border-line text-2xs text-muted2 select-none">
            <span>↑↓ navigate</span>
            <span aria-hidden="true">·</span>
            <span>↵ select</span>
            <span aria-hidden="true">·</span>
            <span># signal mode</span>
            <span aria-hidden="true">·</span>
            <span>esc close</span>
          </div>
        </Command>
      </div>
    </div>
  );
}

// ── useCommandPalette hook — keybindings + state ──────────────────────────────

/**
 * Returns `{ open, setOpen }` and installs:
 * - ⌘K / Ctrl+K global shortcut to open the palette
 * - ⌘1–9 global shortcuts to select Recent symbols even when closed
 */
export function useCommandPalette(onSelectSymbol?: (symbol: string) => void) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // ⌘K / Ctrl+K — toggle palette
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      // ⌘1–9 / Ctrl+1–9 — select nth Recent symbol (works even when closed)
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        const recent = loadRecentSymbols();
        if (idx < recent.length) {
          e.preventDefault();
          const symbol = recent[idx];
          pushRecentSymbol(symbol);
          onSelectSymbol?.(symbol);
        }
      }
    }

    // Custom event dispatched by the Layout search input button.
    function onOpenPalette() {
      setOpen(true);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("quantara:open-palette", onOpenPalette);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("quantara:open-palette", onOpenPalette);
    };
  }, [onSelectSymbol]);

  return { open, setOpen };
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-muted2 shrink-0"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-brand shrink-0"
    >
      <line x1="4" x2="20" y1="9" y2="9" />
      <line x1="4" x2="20" y1="15" y2="15" />
      <line x1="10" x2="8" y1="3" y2="21" />
      <line x1="16" x2="14" y1="3" y2="21" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-muted2"
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

function CloseSmIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
