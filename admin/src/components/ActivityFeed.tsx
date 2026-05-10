/**
 * ActivityFeed — real-time pipeline event stream component.
 *
 * Connects to the WebSocket with `?channel=events&token=<jwt>`.
 * Maintains the last 500 events in memory, supports:
 *   - Filter chips: by event type, by pair
 *   - Auto-scroll toggle
 *   - Pause / resume (events queue while paused, drain on resume)
 *
 * Design: issue #184.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type { PipelineEvent } from "@quantara/shared";

import { getAccessToken } from "../lib/auth";
import { apiFetch } from "../lib/api";

import { eventKey, BoundedKeySet } from "./activityFeedDedupe";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Configured at build time via VITE_WS_BASE; falls back to a sensible dev URL
// (matches the Genie page pattern). Without this, builds that forget to set
// VITE_WS_BASE produce a malformed URL like "?channel=events&token=..." which
// never reaches API Gateway.
const WS_BASE = (import.meta.env.VITE_WS_BASE as string | undefined) ?? "wss://ws.dev.quantara.io";
const MAX_EVENTS = 500;

// API Gateway WebSocket connections drop on idle/timeout, so reconnect with
// exponential backoff (mirrors Genie.tsx) and surface "disconnected" once
// retries are exhausted so the user knows to refresh.
const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_RECONNECT_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Event type metadata
// ---------------------------------------------------------------------------

const EVENT_TYPE_COLORS: Record<PipelineEvent["type"], string> = {
  "indicator-state-updated": "bg-line text-ink2",
  "signal-emitted": "bg-brand-soft text-brand",
  "ratification-fired": "bg-brand-soft text-brand",
  "news-enriched": "bg-up-soft text-up-strong",
  "sentiment-shock-detected": "bg-warn-soft text-warn",
  "quorum-failed": "bg-down-soft text-down-strong",
};

const ALL_EVENT_TYPES: PipelineEvent["type"][] = [
  "indicator-state-updated",
  "signal-emitted",
  "ratification-fired",
  "news-enriched",
  "sentiment-shock-detected",
  "quorum-failed",
];

const ALL_PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the relevant trading pair(s) from any event type.
 *
 * `news-enriched` events carry `mentionedPairs` from `tagPairs()`, which
 * returns BARE SYMBOLS ("BTC", "ETH"). The filter UI uses full trading
 * pairs ("BTC/USDT"). Normalize the news side to trading pairs by
 * suffixing each symbol against the configured ALL_PAIRS list — that
 * way news events match the active-pair filter the same way per-pair
 * events do.
 */
function eventPairs(event: PipelineEvent): string[] {
  if ("pair" in event) return [event.pair];
  if ("mentionedPairs" in event) {
    const tradingPairs = ALL_PAIRS as readonly string[];
    return event.mentionedPairs.flatMap((symbol) => {
      // If already a trading pair, pass through; else find the matching pair
      // (e.g. "BTC" → "BTC/USDT").
      if (symbol.includes("/")) return [symbol];
      const match = tradingPairs.find((p) => p.startsWith(`${symbol}/`));
      return match ? [match] : [];
    });
  }
  return [];
}

/** Build a short human-readable summary of an event's payload. */
function eventSummary(event: PipelineEvent): string {
  switch (event.type) {
    case "indicator-state-updated":
      return `${event.pair} ${event.timeframe} bars=${event.barsSinceStart}${event.rsi14 !== undefined ? ` rsi=${event.rsi14.toFixed(1)}` : ""}`;
    case "signal-emitted":
      return `${event.pair} ${event.timeframe} → ${event.signalType.toUpperCase()} conf=${event.confidence.toFixed(2)}`;
    case "ratification-fired":
      return `${event.pair} ${event.timeframe} verdict=${event.verdict} latency=${event.latencyMs}ms cacheHit=${event.cacheHit}`;
    case "news-enriched":
      return `newsId=${event.newsId} pairs=${event.mentionedPairs.join(",")} score=${event.sentimentScore.toFixed(2)}`;
    case "sentiment-shock-detected":
      return `${event.pair} delta=${event.deltaScore.toFixed(3)}`;
    case "quorum-failed":
      return `${event.pair} ${event.timeframe}`;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeedEntry {
  id: number;
  receivedAt: string;
  event: PipelineEvent;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

let nextId = 0;

export function ActivityFeed() {
  const [allEntries, setAllEntries] = useState<FeedEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeTypes, setActiveTypes] = useState<Set<PipelineEvent["type"]>>(
    new Set(ALL_EVENT_TYPES),
  );
  const [activePairs, setActivePairs] = useState<Set<string>>(new Set([...ALL_PAIRS, ""]));
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  // Tracks whether the initial REST backfill has resolved (success or failure).
  // While false, show a loading indicator instead of "no events".
  const [backfillDone, setBackfillDone] = useState(false);

  const queueRef = useRef<FeedEntry[]>([]);
  const pausedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  // Keep pausedRef in sync so the WS message handler can read it without
  // closing over stale state.
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && queueRef.current.length > 0) {
      // Drain the queue on resume
      const queued = queueRef.current;
      queueRef.current = [];
      setAllEntries((prev) => {
        const combined = [...prev, ...queued];
        return combined.length > MAX_EVENTS ? combined.slice(-MAX_EVENTS) : combined;
      });
    }
  }, [paused]);

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [allEntries, autoScroll]);

  // WebSocket connection — auto-reconnects with exponential backoff up to
  // MAX_RECONNECT_ATTEMPTS, then surfaces "disconnected" permanently.
  //
  // On mount, we first backfill from GET /api/admin/activity before opening
  // the WebSocket. The backfill resolves before `connect()` is called, so
  // allEntries is seeded with historical events and no race exists between
  // setAllEntries (backfill) and ws.onmessage (live). Duplicate events that
  // arrive via the WS within the narrow fetch window are deduped by a stable
  // per-event-type identity in the onmessage handler below.
  useEffect(() => {
    intentionalCloseRef.current = false;

    // Track seen event identities to dedupe WS events that overlap with the
    // backfill window AND repeat live events (defensive). The dedupe identity
    // is a stable per-type key (see `activityFeedDedupe.ts`) — NOT `ts`,
    // because the WS producer stamps `ts = new Date()` at fanout time while
    // the backfill route reads `ts` from persisted fields, so the same logical
    // event would otherwise collide on every dimension except `ts`.
    //
    // The set is bounded so memory stays flat on long-running sessions. It
    // is intentionally NOT cleared on `ws.onopen`; clearing it there would
    // re-open the dedupe window every reconnect and was the original bug.
    const seenKeys = new BoundedKeySet(MAX_EVENTS);

    function connect() {
      const token = getAccessToken();
      if (!token) {
        setStatus("disconnected");
        return;
      }

      setStatus("connecting");
      const url = `${WS_BASE}?channel=events&token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        setStatus("connected");
      };

      ws.onmessage = (msg: MessageEvent<string>) => {
        let event: PipelineEvent;
        try {
          event = JSON.parse(msg.data) as PipelineEvent;
        } catch {
          return; // ignore malformed messages
        }

        // Skip events already accepted (from backfill or an earlier WS msg).
        const key = eventKey(event);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        const entry: FeedEntry = {
          id: nextId++,
          receivedAt: new Date().toISOString(),
          event,
        };

        if (pausedRef.current) {
          queueRef.current = [...queueRef.current, entry].slice(-MAX_EVENTS);
        } else {
          setAllEntries((prev) => {
            const next = [...prev, entry];
            return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
          });
        }
      };

      ws.onclose = () => {
        if (intentionalCloseRef.current) return;
        const attempt = reconnectAttemptRef.current++;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          setStatus("disconnected");
          return;
        }
        setStatus("connecting");
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s.
        const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onerror is followed by onclose — let onclose drive the reconnect.
      };
    }

    // Backfill historical events, then open the WS. The async IIFE ensures
    // `connect()` is only called after the backfill completes (or fails),
    // eliminating the race between setAllEntries and ws.onmessage.
    void (async () => {
      const res = await apiFetch<{ events: PipelineEvent[] }>("/api/admin/activity?limit=100");
      if (res.success && res.data) {
        const backfillEntries: FeedEntry[] = [];
        for (const event of res.data.events) {
          const key = eventKey(event);
          // Defensive dedupe within the backfill payload itself.
          if (!seenKeys.add(key)) continue;
          backfillEntries.push({
            id: nextId++,
            receivedAt: event.ts,
            event,
          });
        }
        setAllEntries((prev) => {
          // If the component unmounted during the fetch, don't update state.
          if (intentionalCloseRef.current) return prev;
          const combined = [...backfillEntries, ...prev];
          return combined.length > MAX_EVENTS ? combined.slice(-MAX_EVENTS) : combined;
        });
      }
      if (!intentionalCloseRef.current) setBackfillDone(true);
      // Connect regardless of backfill success — the feed is still usable
      // with live-only events if the REST call fails.
      if (!intentionalCloseRef.current) connect();
    })();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const toggleType = useCallback((t: PipelineEvent["type"]) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  const togglePair = useCallback((p: string) => {
    setActivePairs((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  // Filter displayed entries
  const displayedEntries = allEntries.filter((entry) => {
    if (!activeTypes.has(entry.event.type)) return false;
    const pairs = eventPairs(entry.event);
    if (pairs.length === 0) return activePairs.has(""); // events with no pair
    return pairs.some((p) => activePairs.has(p));
  });

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <StatusBadge status={status} />

        <button
          onClick={() => setPaused((p) => !p)}
          className={`px-3 py-1 rounded text-xs font-medium border ${
            paused
              ? "border-amber-500 text-amber-400 bg-amber-950/30"
              : "border-line text-muted hover:text-ink"
          }`}
        >
          {paused ? `Resume (${queueRef.current.length} queued)` : "Pause"}
        </button>

        <button
          onClick={() => setAutoScroll((a) => !a)}
          className={`px-3 py-1 rounded text-xs font-medium border ${
            autoScroll
              ? "border-brand text-brand bg-brand-soft"
              : "border-line text-muted hover:text-ink"
          }`}
        >
          {autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}
        </button>

        <button
          onClick={() => setAllEntries([])}
          className="px-3 py-1 rounded text-xs font-medium border border-line text-muted2 hover:text-ink2"
        >
          Clear
        </button>

        <span className="text-xs text-muted2">{allEntries.length} events</span>
      </div>

      {/* Event type filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {ALL_EVENT_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => toggleType(t)}
            className={`px-2 py-0.5 rounded text-[11px] font-mono transition-opacity ${
              EVENT_TYPE_COLORS[t]
            } ${activeTypes.has(t) ? "opacity-100" : "opacity-30"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Pair filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {[...ALL_PAIRS].map((p) => (
          <button
            key={p}
            onClick={() => togglePair(p)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-opacity ${
              activePairs.has(p)
                ? "border-line-strong text-ink2 bg-sunken"
                : "border-line text-muted2 opacity-40"
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Event log */}
      <div className="rounded-lg border border-line bg-paper h-[28rem] overflow-y-auto font-mono text-[11px]">
        {displayedEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted2">
            {!backfillDone
              ? "Loading history…"
              : status === "connecting"
                ? "Connecting…"
                : "No events match the current filters."}
          </div>
        ) : (
          <table className="w-full">
            <tbody>
              {displayedEntries.map((entry) => (
                <tr key={entry.id} className="border-b border-line/60 hover:bg-surface/40">
                  <td className="pl-3 pr-2 py-1 text-muted2 whitespace-nowrap w-28">
                    {new Date(entry.receivedAt).toLocaleTimeString()}
                  </td>
                  <td className="pr-2 py-1 w-44">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] ${EVENT_TYPE_COLORS[entry.event.type]}`}
                    >
                      {entry.event.type}
                    </span>
                  </td>
                  <td className="pr-3 py-1 text-ink2">{eventSummary(entry.event)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: "connecting" | "connected" | "disconnected" }) {
  const [color, label] =
    status === "connected"
      ? ["bg-up", "Live"]
      : status === "connecting"
        ? ["bg-amber-400 animate-pulse", "Connecting"]
        : ["bg-down", "Disconnected"];

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}
