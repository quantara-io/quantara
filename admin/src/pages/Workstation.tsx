import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../lib/api";
import { AlertsRail } from "../components/workstation/AlertsRail";
import { type Candle, MarketChart } from "../components/workstation/MarketChart";
import { PositionRail } from "../components/workstation/PositionRail";
import { SignalsRail } from "../components/workstation/SignalsRail";
import {
  SymbolHeader,
  type SymbolStats,
  type Timeframe,
  TIMEFRAME_TO_API,
} from "../components/workstation/SymbolHeader";
import { WatchlistRail } from "../components/workstation/WatchlistRail";
import { DEFAULT_EXCHANGE, DEFAULT_PAIR, metaForPair } from "../components/workstation/symbols";

interface MarketData {
  prices: Array<{ pair: string; exchange: string; price: number; volume24h?: number }>;
  candles: Candle[];
  pair: string;
  exchange: string;
}

const POLL_MS = 30_000;
/** Initial candle load size. */
const INITIAL_LIMIT = 500;
/** Minimum candles to fetch per backfill request. */
const BACKFILL_LIMIT = 200;
/** Maximum candles per backfill batch — backend hard cap is 500. */
const MAX_BATCH = 500;

/**
 * Per-timeframe total history cap. Once the loaded candle count reaches this
 * threshold the chart stops backfilling — additional zoom-out won't trigger
 * more requests, preventing unbounded history drain.
 *
 * Approximate coverage per cap:
 *   15m →  1500 bars ≈ 15.6 days
 *   1H  →  2000 bars ≈ 83 days
 *   4H  →  2000 bars ≈ 333 days
 *   1D  →  2000 bars ≈ 5.5 years
 *   1W  →   500 bars ≈ 9.6 years
 */
const MAX_TOTAL_CANDLES: Record<Timeframe, number> = {
  "15m": 1500,
  "1H": 2000,
  "4H": 2000,
  "1D": 2000,
  "1W": 500,
};

export function Workstation() {
  const [activePair, setActivePair] = useState<string>(DEFAULT_PAIR);
  const [timeframe, setTimeframe] = useState<Timeframe>("1H");
  const [data, setData] = useState<MarketData | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState("");
  /** Mirrors backfillExhaustedRef for rendering the footer label. */
  const [backfillExhaustedDisplay, setBackfillExhaustedDisplay] = useState(false);

  // Backfill state — all refs so the subscriber closure always has current
  // values without causing extra re-renders.
  /** True while a backfill request is in flight — coalesces rapid pan events. */
  const backfillInFlightRef = useRef(false);
  /** Set to true when the backend returns 0 candles (history exhausted). */
  const backfillExhaustedRef = useRef(false);

  // Reset backfill state and re-load initial candles when pair or timeframe change.
  useEffect(() => {
    backfillInFlightRef.current = false;
    backfillExhaustedRef.current = false;
    setBackfillExhaustedDisplay(false);
    setCandles([]);

    let cancelled = false;
    async function load() {
      const apiTf = TIMEFRAME_TO_API[timeframe];
      const res = await apiFetch<MarketData>(
        `/api/admin/market?pair=${encodeURIComponent(activePair)}&exchange=${DEFAULT_EXCHANGE}&timeframe=${apiTf}&limit=${INITIAL_LIMIT}`,
      );
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
        setError("");
      } else {
        setError(res.error?.message ?? "Failed to load market data");
      }
    }
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activePair, timeframe]);

  // Keep latest live candles from polling in sync without discarding backfilled
  // older candles. The poll returns the most recent window, so we keep any
  // candle that is older than the earliest candle in the poll result.
  useEffect(() => {
    if (!data) return;
    const fresh = data.candles ?? [];
    if (fresh.length === 0) return;
    const freshOldest = Math.min(...fresh.map((c) => c.openTime));
    setCandles((prev) => {
      // Keep backfilled candles (older than poll window) + full fresh set.
      const backfilled = prev.filter((c) => c.openTime < freshOldest);
      const merged = [...backfilled, ...fresh];
      // Dedup by openTime and sort ascending.
      const map = new Map<number, Candle>();
      for (const c of merged) map.set(c.openTime, c);
      return Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);
    });
  }, [data]);

  const handleBackfillNeeded = useCallback(
    (oldestOpenTime: number, requestedLimit: number = BACKFILL_LIMIT) => {
      if (backfillInFlightRef.current) return;
      if (backfillExhaustedRef.current) return;

      backfillInFlightRef.current = true;
      const apiTf = TIMEFRAME_TO_API[timeframe];
      // Cap at backend max (500) regardless of what the chart requests.
      const limit = Math.min(Math.max(requestedLimit, BACKFILL_LIMIT), MAX_BATCH);

      void apiFetch<MarketData>(
        `/api/admin/market?pair=${encodeURIComponent(activePair)}&exchange=${DEFAULT_EXCHANGE}&timeframe=${apiTf}&limit=${limit}&before=${oldestOpenTime}`,
      ).then((res) => {
        backfillInFlightRef.current = false;
        if (!res.success || !res.data) return;
        const older = res.data.candles ?? [];
        if (older.length === 0) {
          backfillExhaustedRef.current = true;
          setBackfillExhaustedDisplay(true);
          return;
        }
        setCandles((prev) => {
          const map = new Map<number, Candle>();
          for (const c of [...older, ...prev]) map.set(c.openTime, c);
          const merged = Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);
          // Enforce per-timeframe total history cap.
          if (merged.length >= MAX_TOTAL_CANDLES[timeframe]) {
            backfillExhaustedRef.current = true;
            setBackfillExhaustedDisplay(true);
          }
          return merged;
        });
      });
    },
    [activePair, timeframe],
  );

  const meta = useMemo(() => metaForPair(activePair), [activePair]);
  const stats = useMemo(() => deriveStats(data, candles, activePair), [data, candles, activePair]);

  return (
    <div className="grid grid-cols-[260px_minmax(0,1fr)_320px] min-h-[calc(100vh-5rem)]">
      <aside className="border-r border-line bg-surface/50 flex flex-col">
        <WatchlistRail activePair={activePair} onSelect={setActivePair} />
        <div className="hairline" />
        <AlertsRail />
      </aside>

      <section className="bg-paper flex flex-col min-w-0">
        <SymbolHeader
          meta={meta}
          stats={stats}
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
        />
        <div className="flex-1 px-4 py-3 min-w-0">
          {error ? (
            <div className="rounded border border-down/30 bg-down-soft text-down-strong text-sm p-3">
              {error}
            </div>
          ) : candles.length === 0 ? (
            <div className="text-sm text-muted2 py-6">Loading market…</div>
          ) : (
            <MarketChart
              candles={candles}
              timeframe={TIMEFRAME_TO_API[timeframe]}
              onBackfillNeeded={handleBackfillNeeded}
              backfillExhausted={backfillExhaustedDisplay}
            />
          )}
        </div>
      </section>

      <aside className="border-l border-line bg-surface/50 flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col">
          <SignalsRail activePair={activePair} />
        </div>
        <div className="hairline" />
        <PositionRail activePair={activePair} />
      </aside>
    </div>
  );
}

function deriveStats(data: MarketData | null, candles: Candle[], pair: string): SymbolStats {
  if (!candles || candles.length === 0) {
    return {
      price: null,
      change24hPct: null,
      high24h: null,
      low24h: null,
      volume24h: null,
      fundingPct: null,
    };
  }
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const last = sorted[sorted.length - 1];
  const first = sorted[0];
  const high24h = sorted.reduce((m, c) => Math.max(m, c.high), -Infinity);
  const low24h = sorted.reduce((m, c) => Math.min(m, c.low), Infinity);
  const volume24h = sorted.reduce((s, c) => s + c.volume, 0);
  const change = first.open ? ((last.close - first.open) / first.open) * 100 : 0;
  const livePrice = data?.prices?.find((p) => p.pair === pair)?.price ?? last.close;
  return {
    price: livePrice,
    change24hPct: change,
    high24h,
    low24h,
    volume24h,
    fundingPct: null, // Not yet exposed by /api/admin/market.
  };
}
