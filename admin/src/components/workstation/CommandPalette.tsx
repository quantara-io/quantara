/**
 * CommandPalette — ⌘K command palette shell for the Workstation.
 *
 * Issue #313: modal overlay, keybinding, Recent + Jump To sections.
 * Data-driven sections (Markets, Signals, Commands) land in follow-up issues.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";

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

// ── CommandPalette component ──────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Called when user selects a symbol from Recent */
  onSelectSymbol?: (symbol: string) => void;
}

export function CommandPalette({ open, onClose, onSelectSymbol }: CommandPaletteProps) {
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
            <SearchIcon />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Search markets, signals, jump to…"
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

            {/* Recent symbols — always mounted so cmdk can fuzzy-filter against the typed query */}
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

            {/* Jump To — always mounted so cmdk can fuzzy-filter against the typed query */}
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
          </Command.List>

          {/* ── Footer hint ── */}
          <div className="flex items-center gap-3 px-4 py-2 border-t border-line text-2xs text-muted2 select-none">
            <span>↑↓ navigate</span>
            <span aria-hidden="true">·</span>
            <span>↵ select</span>
            <span aria-hidden="true">·</span>
            <span>/ command mode</span>
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
