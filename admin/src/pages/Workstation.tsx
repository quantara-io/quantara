import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../lib/api";
import { AlertsRail } from "../components/workstation/AlertsRail";
import { type Candle, MarketChart } from "../components/workstation/MarketChart";
import { PositionRail } from "../components/workstation/PositionRail";
import { SignalsRail } from "../components/workstation/SignalsRail";
import {
  SymbolHeader,
  type SymbolStats,
  type Timeframe,
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

export function Workstation() {
  const [activePair, setActivePair] = useState<string>(DEFAULT_PAIR);
  const [timeframe, setTimeframe] = useState<Timeframe>("1H");
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await apiFetch<MarketData>(
        `/api/admin/market?pair=${encodeURIComponent(activePair)}&exchange=${DEFAULT_EXCHANGE}`,
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
  }, [activePair]);

  const meta = useMemo(() => metaForPair(activePair), [activePair]);
  const stats = useMemo(() => deriveStats(data, activePair), [data, activePair]);

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
          ) : !data ? (
            <div className="text-sm text-muted2 py-6">Loading market…</div>
          ) : (
            <MarketChart candles={data.candles ?? []} />
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

function deriveStats(data: MarketData | null, pair: string): SymbolStats {
  if (!data || !data.candles || data.candles.length === 0) {
    return {
      price: null,
      change24hPct: null,
      high24h: null,
      low24h: null,
      volume24h: null,
      fundingPct: null,
    };
  }
  const candles = [...data.candles].sort((a, b) => a.openTime - b.openTime);
  const last = candles[candles.length - 1];
  const first = candles[0];
  const high24h = candles.reduce((m, c) => Math.max(m, c.high), -Infinity);
  const low24h = candles.reduce((m, c) => Math.min(m, c.low), Infinity);
  const volume24h = candles.reduce((s, c) => s + c.volume, 0);
  const change = first.open ? ((last.close - first.open) / first.open) * 100 : 0;
  const livePrice = data.prices?.find((p) => p.pair === pair)?.price ?? last.close;
  return {
    price: livePrice,
    change24hPct: change,
    high24h,
    low24h,
    volume24h,
    fundingPct: null, // Not yet exposed by /api/admin/market.
  };
}
