/**
 * CommandPalette — ⌘K command palette shell for the Workstation.
 *
 * Issue #313: modal overlay, keybinding, Recent + Jump To sections.
 * Issue #314: Markets section — fuzzy symbol search with recency-weighted ranking.
 * Issue #315: Signals section — fetch by symbol with 30 s cache, # prefix mode.
 * Issue #316: Commands section (/tf, /close, /toggle).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { PAIRS, type BlendedSignal } from "@quantara/shared";

import { apiFetch } from "../../lib/api";
import { formatPrice } from "../ui/MonoNum";

import { allCommands, parseCommandInput, type WorkstationContext } from "./cmdk-commands";

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

// ── Markets scoring ───────────────────────────────────────────────────────────

/**
 * Recency factor for a symbol.
 * - 1.0 if last used < 1h ago
 * - 0.5 if last used today (but ≥ 1h ago)
 * - 0.1 if last used within the past week
 * - 0.0 otherwise (or not in recent list at all)
 */
export function recencyFactor(symbol: string, recent: string[], nowMs?: number): number {
  const idx = recent.indexOf(symbol);
  if (idx === -1) return 0;

  const now = nowMs ?? Date.now();
  const raw = localStorage.getItem("q.cmdk.recent.ts");
  let timestamps: Record<string, number> = {};
  try {
    if (raw) timestamps = JSON.parse(raw) as Record<string, number>;
  } catch {
    // corrupt — treat as no timestamps
  }

  const ts = timestamps[symbol];
  if (!ts) {
    // Symbol is in recent but has no timestamp — treat as position-based fallback.
    // Earlier index = more recent; give top position maximum factor.
    return idx === 0 ? 1.0 : idx === 1 ? 0.5 : 0.1;
  }

  const age = now - ts;
  const ONE_HOUR = 3_600_000;
  const ONE_DAY = 86_400_000;
  const ONE_WEEK = 7 * ONE_DAY;

  if (age < ONE_HOUR) return 1.0;
  if (age < ONE_DAY) return 0.5;
  if (age < ONE_WEEK) return 0.1;
  return 0;
}

/**
 * Fuzzy score for a query against a symbol code.
 * Returns 1.0 for exact match, 0.8 for prefix match,
 * 0.5 for substring match, 0 for no match.
 */
export function fuzzyScore(query: string, symbol: string): number {
  if (!query) return 0.5; // empty query → all symbols match equally
  const q = query.toLowerCase();
  const s = symbol.toLowerCase();
  if (s === q) return 1.0;
  if (s.startsWith(q)) return 0.8;
  if (s.includes(q)) return 0.5;
  return 0;
}

/**
 * Composite ranking score for a pair (e.g. "BTC/USDT") against a query and recent list.
 * score = fuzzy(query, symbol) * 0.6 + recency(symbol) * 0.4
 * Returns 0 if the symbol doesn't match the query at all.
 */
export function scoreMarket(pair: string, query: string, recent: string[], nowMs?: number): number {
  const symbol = pair.split("/")[0] ?? pair;
  const fuzz = fuzzyScore(query, symbol);
  if (fuzz === 0) return 0; // no match → exclude
  const recency = recencyFactor(symbol, recent, nowMs);
  return fuzz * 0.6 + recency * 0.4;
}

/**
 * Rank all PAIRS by composite score and return only those with score > 0.
 * When query is empty, returns all pairs ordered by recency then alphabetical.
 */
export function rankMarkets(
  query: string,
  recent: string[],
  nowMs?: number,
): Array<{ pair: string; symbol: string; score: number }> {
  return (PAIRS as readonly string[])
    .map((pair) => ({
      pair,
      symbol: pair.split("/")[0] ?? pair,
      score: scoreMarket(pair, query, recent, nowMs),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Persist a timestamp for when the symbol was last selected, used by recencyFactor.
 */
export function touchRecentTimestamp(symbol: string, nowMs?: number): void {
  const now = nowMs ?? Date.now();
  const raw = localStorage.getItem("q.cmdk.recent.ts");
  let timestamps: Record<string, number> = {};
  try {
    if (raw) timestamps = JSON.parse(raw) as Record<string, number>;
  } catch {
    // corrupt — start fresh
  }
  timestamps[symbol] = now;
  try {
    localStorage.setItem("q.cmdk.recent.ts", JSON.stringify(timestamps));
  } catch {
    // storage full — silent fail
  }
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

/**
 * Module-level cache so it survives palette open/close cycles.
 * Exported for tests — see `__resetSignalCacheForTests` and
 * `__getSignalCacheSizeForTests` below.
 */
const signalCache = new Map<string, CacheEntry>();

/** Resets the module-level cache. Test-only helper. */
export function __resetSignalCacheForTests(): void {
  signalCache.clear();
}

/** Returns the current cache size. Test-only helper. */
export function __getSignalCacheSizeForTests(): number {
  return signalCache.size;
}

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

// ── fetchSignalsForPair / fetchSignalsAllSymbols — pure async (for tests) ────

/** Subset of `apiFetch` the data path actually depends on. */
export type SignalsFetcher = (
  path: string,
  opts?: { signal?: AbortSignal },
) => Promise<{
  success: boolean;
  data?: { signals: BlendedSignal[] };
  error?: { code: string; message: string };
}>;

/**
 * Pure data-path for fetching signals for a single pair with a 30 s cache.
 * Factored out of `useSignals` so the cache behaviour and error handling can
 * be tested independently of React. Returns the cached array on hit and on
 * apiFetch errors — never throws.
 *
 *   - Returns `[]` if `pair` is falsy.
 *   - Returns `[]` if the underlying fetcher rejects or returns an error
 *     envelope (other than "ABORTED").
 *   - Returns `null` for aborted requests so the caller can ignore the stale
 *     outcome.
 */
export async function fetchSignalsForPair(
  pair: string,
  fetcher: SignalsFetcher,
  abortSignal?: AbortSignal,
): Promise<BlendedSignal[] | null> {
  if (!pair) return [];
  const cached = getCachedSignals(pair);
  if (cached) return cached;
  try {
    const res = await fetcher(`/api/admin/signals?pair=${encodeURIComponent(pair)}&limit=10`, {
      signal: abortSignal,
    });
    if (abortSignal?.aborted) return null;
    if (res.success && res.data) {
      const fetched = res.data.signals ?? [];
      setCachedSignals(pair, fetched);
      return fetched;
    }
    if (res.error?.code === "ABORTED") return null;
    return [];
  } catch (err) {
    // apiFetch already returns a typed envelope for network errors, so this
    // catch only fires for genuinely unexpected throws (e.g. JSON.stringify
    // failure in a future refactor). Swallow and degrade to empty so the UI
    // shows the empty state instead of getting stuck on "loading" forever.
    console.warn("[useSignals] fetchSignalsForPair threw", err);
    return [];
  }
}

/**
 * Cross-symbol label search: `GET /api/admin/signals?q=<label>&limit=20`.
 * Cache key is `__all__:<q>` so it is independent of any per-pair entries.
 * Same error-handling contract as `fetchSignalsForPair`.
 */
export async function fetchSignalsAllSymbols(
  q: string,
  fetcher: SignalsFetcher,
  abortSignal?: AbortSignal,
): Promise<BlendedSignal[] | null> {
  if (!q) return [];
  const cacheKey = `__all__:${q}`;
  const cached = getCachedSignals(cacheKey);
  if (cached) return cached;
  try {
    const res = await fetcher(`/api/admin/signals?q=${encodeURIComponent(q)}&limit=20`, {
      signal: abortSignal,
    });
    if (abortSignal?.aborted) return null;
    if (res.success && res.data) {
      const fetched = res.data.signals ?? [];
      setCachedSignals(cacheKey, fetched);
      return fetched;
    }
    if (res.error?.code === "ABORTED") return null;
    return [];
  } catch (err) {
    console.warn("[useSignalsAllSymbols] fetchSignalsAllSymbols threw", err);
    return [];
  }
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
 *
 * Note: a 150 ms anti-flash delay was considered but is not implemented —
 * the cached returns make any flash imperceptible in practice. Loading
 * skeletons render for the duration of the fetch only on a cold cache.
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

    // Cache hit — return immediately, no loading state.
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
      const result = await fetchSignalsForPair(pair, apiFetch, ctrl.signal);
      if (ctrl.signal.aborted || result === null) return;
      setSignals(result);
      setStatus("done");
    })();

    return () => {
      ctrl.abort();
    };
  }, [pair]);

  return { signals, status };
}

// ── useSignalsAllSymbols hook ─────────────────────────────────────────────────

/**
 * Cross-symbol label search hook. Fetches `GET /api/admin/signals?q=<label>&limit=20`
 * with a 30 s module-level cache (keyed by `__all__:<q>`).
 * Pass an empty string to suppress fetching (returns idle/empty immediately).
 */
function useSignalsAllSymbols(q: string): UseSignalsResult {
  const [signals, setSignals] = useState<BlendedSignal[]>([]);
  const [status, setStatus] = useState<SignalFetchStatus>("idle");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!q) {
      setSignals([]);
      setStatus("idle");
      return;
    }

    const cacheKey = `__all__:${q}`;
    const cached = getCachedSignals(cacheKey);
    if (cached) {
      setSignals(cached);
      setStatus("done");
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus("loading");
    void (async () => {
      const result = await fetchSignalsAllSymbols(q, apiFetch, ctrl.signal);
      if (ctrl.signal.aborted || result === null) return;
      setSignals(result);
      setStatus("done");
    })();

    return () => {
      ctrl.abort();
    };
  }, [q]);

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
  /**
   * Whether the palette is in `#` (signal-only) mode. Controls heading label
   * and fetch strategy: cross-symbol backend search (`?q=`) vs per-pair fetch.
   */
  hashMode: boolean;
  /**
   * In `#` mode, the substring (after the `#`) the user typed. Forwarded to
   * the cross-symbol backend endpoint as `?q=<labelFilter>`. When empty, the
   * per-pair fetch is used instead (shows all recent signals for the active pair).
   */
  labelFilter: string;
  /** Called when user selects a signal row. */
  onSelect: (signal: BlendedSignal) => void;
}

function SignalsSection({ pair, hashMode, labelFilter, onSelect }: SignalsSectionProps) {
  // In `#` mode with a label query: use the cross-symbol backend endpoint.
  // In `#` mode with no label yet (empty labelFilter): fall back to the
  // per-pair fetch so the user sees something useful before they type.
  const crossSymbolResult = useSignalsAllSymbols(hashMode && labelFilter ? labelFilter : "");
  const perPairResult = useSignals(hashMode && labelFilter ? "" : pair);

  const { signals, status } = hashMode && labelFilter ? crossSymbolResult : perPairResult;

  const sym = pairToSymbol(pair);

  const heading = hashMode
    ? labelFilter
      ? "Signals · all symbols"
      : `Signals · ${sym || "all symbols"}`
    : pair
      ? `Signals · ${sym}`
      : "Signals";

  const showSkeleton = status === "loading";
  // In `#` mode without a label, show idle state if no pair is active.
  const showEmpty =
    (status === "done" && signals.length === 0) ||
    (hashMode && !labelFilter && status === "idle" && !pair);
  const showRows = status === "done" && signals.length > 0;

  // Empty-state copy.
  const emptyText = hashMode
    ? !labelFilter && !pair
      ? "No active pair — select one from Recent first"
      : labelFilter
        ? `No signals matching "${labelFilter}" across all symbols`
        : `No recent signals for ${sym}`
    : `No recent signals for ${sym}`;

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
      {showEmpty && <div className="px-4 py-3 text-sm text-muted2">{emptyText}</div>}
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

/** Live price + 24h delta for one pair, provided by the Workstation's poll. */
export interface MarketTick {
  price: number | null;
  change24hPct: number | null;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /**
   * Currently-active trading pair, e.g. "BTC/USDT". Drives the Signals section
   * fetch path so the palette always shows signals for the pair the user is
   * looking at (matching the right-rail SignalsRail). In `#` (label-search)
   * mode, used as the pair shown before the user types a label substring;
   * once a label is typed the cross-symbol backend endpoint is used instead.
   * Optional with a sensible default so existing tests and ad-hoc usages keep working.
   */
  activePair?: string;
  /** Called when user selects a symbol from Recent or Markets */
  onSelectSymbol?: (symbol: string) => void;
  /**
   * Called when user selects a signal row.
   * Caller is responsible for switching activePair to `pair` AND
   * seeking the chart viewport to `asOf`.
   */
  onSelectSignal?: (selection: SignalSelection) => void;
  /**
   * Live market data keyed by pair (e.g. "BTC/USDT").
   * Provided by the Workstation so the Markets section can show current price
   * and 24h delta without making its own API calls.
   */
  markets?: Map<string, MarketTick>;
  /** Workstation context passed to command run(). Required for command mode. */
  ctx?: WorkstationContext;
}

export function CommandPalette({
  open,
  onClose,
  activePair = "",
  onSelectSymbol,
  onSelectSignal,
  markets,
  ctx,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => loadRecentSymbols());
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Ranked markets — recomputed whenever query or recent list changes.
  // Skipped when in command mode (query starts with "/") since the Markets
  // section is not rendered in that branch.
  const rankedMarkets = useMemo(
    () => (query.startsWith("/") ? [] : rankMarkets(query, recent)),
    [query, recent],
  );

  // ── Command mode ───────────────────────────────────────────────────────────
  const isCommandMode = query.startsWith("/");

  // Parse the current command input whenever in command mode.
  const commandParseResult = isCommandMode ? parseCommandInput(query) : null;

  // Filtered command list shown in "list" mode (typing "/..." without a space yet).
  const visibleCommands =
    commandParseResult?.mode === "list"
      ? allCommands().filter((c) => c.name.slice(1).startsWith(commandParseResult.filter))
      : allCommands();

  // Execute the current command if parse succeeded, then close palette.
  const handleRunCommand = useCallback(() => {
    if (!commandParseResult || commandParseResult.mode !== "parse") return;
    const { command, result } = commandParseResult;
    if (!result.ok) return;
    if (ctx) {
      void command.run(result.payload, ctx);
    }
    onClose();
  }, [commandParseResult, ctx, onClose]);

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
   * The pair to fetch signals for (used by SignalsSection in normal mode and
   * in `#` mode before a label is typed). Reads from `recent` state (loaded
   * once per open in the effect above) rather than calling `loadRecentSymbols()`
   * on every keystroke.
   *
   *   - In `#` (cross-symbol label search) mode: pass `activePair` as the
   *     "empty label" fallback so the section shows active-pair signals before
   *     the user types. Once a label is entered, SignalsSection switches to the
   *     cross-symbol hook instead.
   *   - In normal mode: try to derive a pair from a recognisable symbol in
   *     the query; if nothing matches, fall back to `activePair` (or empty)
   *     so the Signals section still surfaces something meaningful.
   */
  const signalPair: string = (() => {
    if (hashMode) {
      return activePair;
    }
    const upper = symbolQuery.toUpperCase();
    const candidates = [...Object.keys(SYMBOL_LABELS), ...recent];
    const match = candidates.find((s) => s === upper || s.startsWith(upper));
    if (match) return symbolToPair(match);
    return activePair;
  })();

  const handleSelectSymbol = useCallback(
    (symbol: string) => {
      touchRecentTimestamp(symbol);
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
          return;
        }
        // In command "parse" mode (e.g. "/tf 4h"), ↵ executes the command.
        // In "list" mode (e.g. "/" or "/tf" with no space), let cmdk handle
        // ↵ so the selected Command.Item's onSelect fires for autocomplete.
        if (
          isCommandMode &&
          e.key === "Enter" &&
          commandParseResult?.mode === "parse" &&
          commandParseResult.result.ok
        ) {
          e.preventDefault();
          handleRunCommand();
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
                  ? "Search signals across all symbols by label…"
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
            {isCommandMode ? (
              // ── Command mode UI ──────────────────────────────────────────
              <CommandModeContent
                parseResult={commandParseResult}
                visibleCommands={visibleCommands}
                ctx={ctx}
                query={query}
                setQuery={setQuery}
              />
            ) : (
              <>
                <Command.Empty className="py-8 text-center text-sm text-muted2">
                  No results for &quot;{query}&quot;
                </Command.Empty>

                {/* Recent symbols — hidden in `#` mode (signal-only focus). */}
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

                {/* Markets — fuzzy-ranked symbols with live price + 24h delta.
                    Hidden in `#` mode so the palette stays focused on signals.
                    Hidden when query is empty (design spec: empty-state = no for Markets).
                    See CMDK_PALETTE_DESIGN.md section table and issue #329. */}
                {!hashMode && query !== "" && rankedMarkets.length > 0 && (
                  <Command.Group
                    heading="Markets"
                    className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted2 border-t border-line"
                  >
                    {rankedMarkets.map(({ pair, symbol }) => {
                      const tick = markets?.get(pair);
                      return (
                        <Command.Item
                          key={pair}
                          value={`market ${symbol} ${pair}`}
                          onSelect={() => handleSelectSymbol(symbol)}
                          className="flex items-center gap-3 px-4 py-2.5 cursor-pointer text-sm text-ink aria-selected:bg-sunken transition-colors"
                        >
                          <span className="w-6 h-6 rounded-full bg-sunken border border-line flex items-center justify-center shrink-0">
                            <span className="text-2xs font-semibold text-ink">{symbol[0]}</span>
                          </span>
                          <span className="flex-1 min-w-0 font-medium">{pair}</span>
                          {tick && tick.price !== null && (
                            <span className="num text-xs text-ink2 shrink-0">
                              {formatPrice(tick.price)}
                            </span>
                          )}
                          {tick && tick.change24hPct !== null && (
                            <span
                              className={`num text-xs shrink-0 ${
                                tick.change24hPct >= 0 ? "text-up" : "text-down"
                              }`}
                            >
                              {tick.change24hPct >= 0 ? "+" : ""}
                              {tick.change24hPct.toFixed(2)}%
                            </span>
                          )}
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                )}

                {/* Signals section.
                    Rendered whenever `signalPair` resolves AND, in `#` mode,
                    always — even with an empty `signalPair` — so the user sees
                    a heading + empty state instead of a blank panel when no
                    active pair is set. */}
                {(signalPair || hashMode) && (
                  <SignalsSection
                    pair={signalPair}
                    hashMode={hashMode}
                    labelFilter={hashMode ? symbolQuery.toLowerCase() : ""}
                    onSelect={handleSelectSignal}
                  />
                )}

                {/* Jump To — hidden in `#` mode (signals-only focus). */}
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
              </>
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
          touchRecentTimestamp(symbol);
          pushRecentSymbol(symbol);
          onSelectSymbol?.(symbol);
          // Close the palette if it's currently open.
          setOpen(false);
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

// ── CommandModeContent ────────────────────────────────────────────────────────

interface CommandModeContentProps {
  parseResult: ReturnType<typeof parseCommandInput> | null;
  visibleCommands: ReturnType<typeof allCommands>;
  ctx: WorkstationContext | undefined;
  query: string;
  setQuery: (q: string) => void;
}

function CommandModeContent({
  parseResult,
  visibleCommands,
  ctx,
  query,
  setQuery,
}: CommandModeContentProps) {
  // ── "list" mode: show filtered command list ──────────────────────────────
  if (!parseResult || parseResult.mode === "list") {
    if (visibleCommands.length === 0) {
      return (
        <div className="py-8 text-center text-sm text-muted2">
          Unknown command — type <span className="font-mono text-brand">/</span> for the list
        </div>
      );
    }

    return (
      <Command.Group
        heading="Commands"
        className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-widest [&_[cmdk-group-heading]]:text-muted2"
      >
        {visibleCommands.map((cmd) => (
          // value matches the user-typed slash command verbatim so cmdk's
          // fuzzy filter scores "/tf" against "/tf" cleanly.
          <Command.Item
            key={cmd.name}
            value={cmd.name}
            onSelect={() => {
              // Auto-complete the slash command into the input so the user
              // can immediately type the argument (e.g. picking /tf leaves
              // them at "/tf " ready to type "4h").
              setQuery(`${cmd.name} `);
            }}
            className="flex items-start gap-3 px-4 py-2.5 cursor-pointer text-sm text-ink aria-selected:bg-sunken transition-colors"
          >
            <span className="w-6 h-6 rounded-full bg-sunken border border-line flex items-center justify-center shrink-0 mt-0.5">
              <TerminalIcon />
            </span>
            <span className="flex-1 min-w-0">
              <span className="font-mono font-semibold text-brand">{cmd.name}</span>
              <span className="ml-1.5 text-muted2 text-xs font-mono">{cmd.args}</span>
              <span className="block text-xs text-muted2 mt-0.5">{cmd.description}</span>
            </span>
          </Command.Item>
        ))}
      </Command.Group>
    );
  }

  // ── "unknown" mode: command name not in registry ──────────────────────────
  if (parseResult.mode === "unknown") {
    return (
      <div className="py-8 text-center text-sm text-muted2">
        Unknown command <span className="font-mono text-ink">{parseResult.name}</span> — see{" "}
        <span className="font-mono text-brand">/</span> for the list
      </div>
    );
  }

  // ── "parse" mode: command found, show preview or error ────────────────────
  const { command, result } = parseResult;

  if (!result.ok) {
    return (
      <div className="px-4 py-5">
        <div className="flex items-start gap-3">
          <span className="w-6 h-6 rounded-full bg-down-soft border border-down/20 flex items-center justify-center shrink-0 mt-0.5">
            <ErrorIcon />
          </span>
          <div>
            <div className="text-sm font-mono text-down-strong">{query}</div>
            <div className="mt-1 text-xs text-muted2">{result.error}</div>
          </div>
        </div>
        <div className="mt-3 text-2xs text-muted2">
          ↵ does nothing · fix the argument to execute
        </div>
      </div>
    );
  }

  // Parse succeeded — show preview pane.
  const previewText = ctx ? command.preview(result.payload, ctx) : `Will run ${command.name}`;

  return (
    <div className="px-4 py-5">
      <div className="flex items-start gap-3">
        <span className="w-6 h-6 rounded-full bg-up-soft border border-up/20 flex items-center justify-center shrink-0 mt-0.5">
          <CheckIcon />
        </span>
        <div>
          <div className="text-sm font-mono text-ink">{query}</div>
          <div className="mt-1 text-sm text-ink2">{previewText}</div>
        </div>
      </div>
      <div className="mt-3 text-2xs text-muted2">↵ to execute</div>
    </div>
  );
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

function TerminalIcon() {
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
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function CheckIcon() {
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
      className="text-up"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ErrorIcon() {
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
      className="text-down"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
