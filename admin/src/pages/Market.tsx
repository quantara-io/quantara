import { useEffect, useState } from "react";

import { apiFetch } from "../lib/api";

interface Price {
  pair: string;
  exchange: string;
  price: number;
  bid?: number;
  ask?: number;
  volume24h?: number;
  timestamp?: string;
}
interface Candle {
  open: number; high: number; low: number; close: number; volume: number; openTime: number;
}
interface MarketData {
  prices: Price[];
  candles: Candle[];
  fearGreed: { value: number; classification: string } | null;
  pair: string;
  exchange: string;
}

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"];
const EXCHANGES = ["binanceus", "coinbase", "kraken"];

export function Market() {
  const [pair, setPair] = useState("BTC/USDT");
  const [exchange, setExchange] = useState("binanceus");
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await apiFetch<MarketData>(`/api/admin/market?pair=${encodeURIComponent(pair)}&exchange=${exchange}`);
      if (cancelled) return;
      if (res.success && res.data) { setData(res.data); setError(""); }
      else setError(res.error?.message ?? "Failed to load");
    }
    void load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [pair, exchange]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <Selector label="Pair" value={pair} options={PAIRS} onChange={setPair} />
        <Selector label="Exchange" value={exchange} options={EXCHANGES} onChange={setExchange} />
      </div>

      {error && <div className="p-3 rounded bg-red-950/40 text-red-300 border border-red-900 text-sm">{error}</div>}
      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-3">Latest Prices (all pairs)</h2>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500">
                  {["Pair", "Exchange", "Price", "Bid", "Ask", "24h Vol"].map((h) => <th key={h} className="text-left font-medium pb-2">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.prices.map((p, i) => (
                  <tr key={i} className="border-t border-slate-800">
                    <td className="py-1.5 text-slate-300">{p.pair}</td>
                    <td className="py-1.5 text-slate-300">{p.exchange}</td>
                    <td className="py-1.5 text-cyan-300 font-mono">{p.price?.toFixed?.(p.price < 1 ? 6 : 2)}</td>
                    <td className="py-1.5 text-slate-400 font-mono">{p.bid?.toFixed?.(p.bid < 1 ? 6 : 2) ?? "—"}</td>
                    <td className="py-1.5 text-slate-400 font-mono">{p.ask?.toFixed?.(p.ask < 1 ? 6 : 2) ?? "—"}</td>
                    <td className="py-1.5 text-slate-400 font-mono">{p.volume24h?.toLocaleString?.() ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-3">Candles · {data.pair} @ {data.exchange} · 1m · last {data.candles.length}</h2>
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-slate-500">
                  {["Time", "Open", "High", "Low", "Close", "Volume"].map((h) => <th key={h} className="text-left font-medium pb-2">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.candles.slice(-30).reverse().map((c, i) => (
                  <tr key={i} className="border-t border-slate-800">
                    <td className="py-1 text-slate-400">{new Date(c.openTime).toLocaleTimeString()}</td>
                    <td className="py-1 text-slate-300">{c.open?.toFixed?.(c.open < 1 ? 6 : 2)}</td>
                    <td className="py-1 text-emerald-400">{c.high?.toFixed?.(c.high < 1 ? 6 : 2)}</td>
                    <td className="py-1 text-red-400">{c.low?.toFixed?.(c.low < 1 ? 6 : 2)}</td>
                    <td className="py-1 text-slate-300">{c.close?.toFixed?.(c.close < 1 ? 6 : 2)}</td>
                    <td className="py-1 text-slate-500">{c.volume?.toFixed?.(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Selector({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="text-xs text-slate-400 flex items-center gap-2">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="rounded-md bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </label>
  );
}
