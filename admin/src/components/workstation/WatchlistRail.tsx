import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { ChangePct, formatPrice } from "../ui/MonoNum";
import { SectionHeader } from "../ui/Section";
import { Spark } from "../ui/Spark";

import { AssetGlyph } from "./AssetGlyph";
import { DEFAULT_EXCHANGE, type SymbolMeta, WATCHLIST } from "./symbols";

interface PriceTick {
  price: number;
  change24h: number;
  closes: number[];
}

interface MarketResp {
  prices: Array<{ pair: string; exchange: string; price: number }>;
  candles: Array<{ open: number; high: number; low: number; close: number; openTime: number }>;
  pair: string;
  exchange: string;
}

const POLL_MS = 30_000;

async function loadTick(pair: string): Promise<PriceTick | null> {
  const res = await apiFetch<MarketResp>(
    `/api/admin/market?pair=${encodeURIComponent(pair)}&exchange=${DEFAULT_EXCHANGE}`,
  );
  if (!res.success || !res.data) return null;
  const candles = res.data.candles ?? [];
  if (candles.length < 2) {
    const px = res.data.prices?.find((p) => p.pair === pair)?.price ?? 0;
    return { price: px, change24h: 0, closes: [] };
  }
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const first = closes[0];
  const change24h = first ? ((last - first) / first) * 100 : 0;
  return { price: last, change24h, closes: closes.slice(-32) };
}

export function WatchlistRail({
  activePair,
  onSelect,
}: {
  activePair: string;
  onSelect: (pair: string) => void;
}) {
  const [ticks, setTicks] = useState<Map<string, PriceTick>>(new Map());

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      const results = await Promise.all(
        WATCHLIST.map(async (s) => [s.pair, await loadTick(s.pair)] as const),
      );
      if (cancelled) return;
      const next = new Map<string, PriceTick>();
      for (const [pair, tick] of results) if (tick) next.set(pair, tick);
      setTicks(next);
    }
    void loadAll();
    const id = setInterval(loadAll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex flex-col">
      <SectionHeader
        title="Watchlist"
        right={
          <button
            type="button"
            disabled
            className="text-2xs text-muted2 hover:text-ink2 disabled:cursor-not-allowed disabled:opacity-50"
            title="Custom watchlist coming soon"
          >
            + Add
          </button>
        }
      />
      <ul className="divide-y divide-line">
        {WATCHLIST.map((meta) => {
          const tick = ticks.get(meta.pair);
          const active = meta.pair === activePair;
          return (
            <li key={meta.pair}>
              <button
                type="button"
                onClick={() => onSelect(meta.pair)}
                className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors focus-ring ${
                  active ? "bg-sunken" : "hover:bg-sunken/60"
                }`}
              >
                <AssetGlyph meta={meta} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-ink truncate">{meta.symbol}</span>
                    <span className="text-2xs text-muted2 truncate">{meta.name}</span>
                  </div>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="num text-xs text-ink2">{formatPrice(tick?.price)}</span>
                    {tick && <ChangePct value={tick.change24h} digits={2} className="text-2xs" />}
                  </div>
                </div>
                <Spark
                  values={tick?.closes ?? []}
                  width={56}
                  height={20}
                  className="shrink-0 text-muted2"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type { SymbolMeta };
