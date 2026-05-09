import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

// ---------------------------------------------------------------------------
// Types (mirrors pipeline-state.service.ts)
// ---------------------------------------------------------------------------

interface IndicatorState {
  barsSinceStart: number | null;
  rsi14: number | null;
  ema50: number | null;
  ema200: number | null;
  macdLine: number | null;
  atr14: number | null;
  asOf: string | null;
  ageSeconds: number | null;
  raw: Record<string, unknown> | null;
}

interface SignalState {
  type: string | null;
  confidence: number | null;
  ratificationStatus: string | null;
  interpretationText: string | null;
  closeTime: string | null;
  ageSeconds: number | null;
  raw: Record<string, unknown> | null;
  recentHistory: Record<string, unknown>[];
}

interface SentimentWindow {
  score: number | null;
  magnitude: number | null;
  articleCount: number | null;
  updatedAt: string | null;
  ageSeconds: number | null;
}

interface PipelineCell {
  pair: string;
  timeframe: string;
  indicator: IndicatorState;
  signal: SignalState;
  sentiment4h: SentimentWindow;
  sentiment24h: SentimentWindow;
}

interface PipelineData {
  cells: PipelineCell[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"];
const POLL_MS = 5_000;

/** Timeframe durations in seconds — used for age colour thresholds. */
const TF_DURATION_S: Record<string, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

// ---------------------------------------------------------------------------
// Utility: age colour
// ---------------------------------------------------------------------------

function ageColor(ageSeconds: number | null, tfDurationSeconds: number): string {
  if (ageSeconds === null) return "text-slate-500";
  if (ageSeconds < tfDurationSeconds) return "text-emerald-400";
  if (ageSeconds < tfDurationSeconds * 2) return "text-yellow-400";
  return "text-red-400";
}

function fmt(v: number | null, decimals = 2): string {
  if (v === null) return "—";
  return v.toFixed(decimals);
}

function fmtAge(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function signalTypeColor(type: string | null): string {
  if (type === "buy") return "text-emerald-400";
  if (type === "sell") return "text-red-400";
  if (type === "hold") return "text-yellow-400";
  return "text-slate-500";
}

function ratificationBadge(status: string | null): string {
  if (status === "ratified") return "bg-emerald-900/40 text-emerald-300 border-emerald-700";
  if (status === "downgraded") return "bg-orange-900/40 text-orange-300 border-orange-700";
  if (status === "pending") return "bg-yellow-900/40 text-yellow-300 border-yellow-700";
  return "bg-slate-800 text-slate-500 border-slate-700";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <span className="text-[10px] text-slate-500 shrink-0">{label}</span>
      <span className={`text-[11px] font-mono tabular-nums truncate ${valueClass ?? "text-slate-300"}`}>{value}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5 mt-1.5 first:mt-0">{children}</div>
  );
}

// ---------------------------------------------------------------------------
// Cell component
// ---------------------------------------------------------------------------

function CellCard({
  cell,
  onClick,
  selected,
}: {
  cell: PipelineCell;
  onClick: () => void;
  selected: boolean;
}) {
  const tfDurS = TF_DURATION_S[cell.timeframe] ?? 3600;
  const indAgeClass = ageColor(cell.indicator.ageSeconds, tfDurS);
  const sigAgeClass = ageColor(cell.signal.ageSeconds, tfDurS);
  // Sentiment uses the 4h window duration for colour threshold regardless of tf
  const sentAgeClass = ageColor(cell.sentiment4h.ageSeconds, TF_DURATION_S["4h"]);

  const isEmpty =
    cell.indicator.asOf === null && cell.signal.type === null && cell.sentiment4h.score === null;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border p-2 transition-colors
        ${selected
          ? "border-cyan-600 bg-cyan-950/30"
          : isEmpty
            ? "border-slate-800 bg-slate-950 opacity-50"
            : "border-slate-800 bg-slate-900 hover:border-slate-700 hover:bg-slate-800/60"
        }`}
    >
      {isEmpty ? (
        <span className="text-[11px] text-slate-600">—</span>
      ) : (
        <>
          <SectionLabel>Indicator</SectionLabel>
          <Stat label="RSI14" value={fmt(cell.indicator.rsi14)} />
          <Stat label="EMA50" value={fmt(cell.indicator.ema50, 0)} />
          <Stat label="MACD" value={fmt(cell.indicator.macdLine)} />
          <Stat label="Age" value={fmtAge(cell.indicator.ageSeconds)} valueClass={indAgeClass} />

          <SectionLabel>Signal</SectionLabel>
          <Stat
            label="Type"
            value={cell.signal.type ?? "—"}
            valueClass={signalTypeColor(cell.signal.type)}
          />
          <Stat label="Conf" value={cell.signal.confidence !== null ? `${(cell.signal.confidence * 100).toFixed(0)}%` : "—"} />
          {cell.signal.ratificationStatus && (
            <div className="mt-0.5">
              <span className={`text-[9px] px-1.5 py-0.5 rounded border ${ratificationBadge(cell.signal.ratificationStatus)}`}>
                {cell.signal.ratificationStatus}
              </span>
            </div>
          )}
          <Stat label="Age" value={fmtAge(cell.signal.ageSeconds)} valueClass={sigAgeClass} />

          <SectionLabel>Sentiment 4h</SectionLabel>
          <Stat label="Score" value={fmt(cell.sentiment4h.score, 3)} />
          <Stat label="Articles" value={cell.sentiment4h.articleCount?.toString() ?? "—"} />
          <Stat label="Age" value={fmtAge(cell.sentiment4h.ageSeconds)} valueClass={sentAgeClass} />
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

function SidePanel({
  cell,
  onClose,
}: {
  cell: PipelineCell;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-slate-950 border-l border-slate-800 overflow-y-auto z-20 shadow-2xl">
      <div className="sticky top-0 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div>
          <span className="text-sm font-semibold text-slate-100">{cell.pair}</span>
          <span className="ml-2 text-xs text-slate-400">{cell.timeframe}</span>
        </div>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 text-lg leading-none"
          aria-label="Close panel"
        >
          &times;
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Indicator full JSON */}
        <section>
          <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">Full Indicator State</h3>
          {cell.indicator.raw ? (
            <pre className="text-[10px] text-slate-300 bg-slate-900 rounded p-3 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(cell.indicator.raw, null, 2)}
            </pre>
          ) : (
            <p className="text-xs text-slate-600">No data</p>
          )}
        </section>

        {/* Signal full row */}
        <section>
          <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">Latest Signal</h3>
          {cell.signal.raw ? (
            <pre className="text-[10px] text-slate-300 bg-slate-900 rounded p-3 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(cell.signal.raw, null, 2)}
            </pre>
          ) : (
            <p className="text-xs text-slate-600">No data</p>
          )}
        </section>

        {/* Interpretation text */}
        {cell.signal.interpretationText && (
          <section>
            <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">Interpretation (truncated)</h3>
            <p className="text-xs text-slate-300 bg-slate-900 rounded p-3">{cell.signal.interpretationText}</p>
          </section>
        )}

        {/* Ratification history */}
        <section>
          <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">
            Ratification History (last {cell.signal.recentHistory.length})
          </h3>
          {cell.signal.recentHistory.length === 0 ? (
            <p className="text-xs text-slate-600">No history</p>
          ) : (
            <div className="space-y-2">
              {cell.signal.recentHistory.map((row, i) => (
                <div key={i} className="text-[10px] bg-slate-900 rounded p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`font-semibold ${signalTypeColor(row.type as string | null)}`}>
                      {(row.type as string | null) ?? "—"}
                    </span>
                    {(row.ratificationStatus as string | null) && (
                      <span className={`px-1.5 py-0.5 rounded border text-[9px] ${ratificationBadge(row.ratificationStatus as string | null)}`}>
                        {row.ratificationStatus as string}
                      </span>
                    )}
                    <span className="ml-auto text-slate-500 font-mono">
                      {(row.emittedAt as string | null)
                        ? new Date(row.emittedAt as string).toLocaleTimeString()
                        : "—"}
                    </span>
                  </div>
                  {typeof (row.ratificationVerdict as Record<string, unknown> | null | undefined)?.reasoning === "string" && (
                    <p className="text-slate-400 line-clamp-2">
                      {String((row.ratificationVerdict as Record<string, unknown>).reasoning)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Sentiment detail */}
        <section>
          <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">Sentiment Detail</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                {["Window", "Score", "Magnitude", "Articles", "Age"].map((h) => (
                  <th key={h} className="text-left font-medium pb-1.5">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                { label: "4h", data: cell.sentiment4h, dur: TF_DURATION_S["4h"] },
                { label: "24h", data: cell.sentiment24h, dur: TF_DURATION_S["4h"] },
              ].map(({ label, data, dur }) => (
                <tr key={label} className="border-t border-slate-800">
                  <td className="py-1.5 text-slate-400">{label}</td>
                  <td className={`py-1.5 font-mono ${ageColor(data.ageSeconds, dur)}`}>{fmt(data.score, 3)}</td>
                  <td className="py-1.5 font-mono text-slate-300">{fmt(data.magnitude, 3)}</td>
                  <td className="py-1.5 text-slate-300">{data.articleCount ?? "—"}</td>
                  <td className={`py-1.5 font-mono ${ageColor(data.ageSeconds, dur)}`}>{fmtAge(data.ageSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Pipeline() {
  const [data, setData] = useState<PipelineData | null>(null);
  const [error, setError] = useState("");
  const [selectedCell, setSelectedCell] = useState<PipelineCell | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await apiFetch<PipelineData>("/api/admin/pipeline-state");
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
        setError("");
        // If the panel is open, update the selected cell with fresh data
        setSelectedCell((prev) => {
          if (!prev) return null;
          const fresh = res.data!.cells.find(
            (c) => c.pair === prev.pair && c.timeframe === prev.timeframe,
          );
          return fresh ?? prev;
        });
      } else {
        setError(res.error?.message ?? "Failed to load pipeline state");
      }
    }
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function handleCellClick(cell: PipelineCell) {
    setSelectedCell((prev) =>
      prev?.pair === cell.pair && prev?.timeframe === cell.timeframe ? null : cell,
    );
  }

  // Build a lookup map: pair → timeframe → cell
  const cellMap = new Map<string, Map<string, PipelineCell>>();
  for (const cell of data?.cells ?? []) {
    if (!cellMap.has(cell.pair)) cellMap.set(cell.pair, new Map());
    cellMap.get(cell.pair)!.set(cell.timeframe, cell);
  }

  return (
    <div className="relative">
      {/* Header bar */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-sm font-semibold text-slate-100">Pipeline State</h1>
        {data && (
          <p className="text-xs text-slate-600">
            Updated {new Date(data.generatedAt).toLocaleTimeString()} · refreshes every 5s
          </p>
        )}
      </div>

      {error && (
        <div className="p-3 rounded bg-red-950/40 text-red-300 border border-red-900 text-sm mb-4">
          {error}
        </div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-1.5" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th className="text-left text-[10px] uppercase tracking-widest text-slate-500 pb-1 w-24">Pair</th>
                {TIMEFRAMES.map((tf) => (
                  <th key={tf} className="text-center text-[10px] uppercase tracking-widest text-slate-500 pb-1">
                    {tf}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PAIRS.map((pair) => (
                <tr key={pair}>
                  <td className="text-xs font-mono text-slate-400 pr-2 align-top pt-1">{pair}</td>
                  {TIMEFRAMES.map((tf) => {
                    const cell = cellMap.get(pair)?.get(tf);
                    if (!cell) {
                      return (
                        <td key={tf} className="align-top">
                          <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 opacity-40 text-[11px] text-slate-600">—</div>
                        </td>
                      );
                    }
                    return (
                      <td key={tf} className="align-top">
                        <CellCard
                          cell={cell}
                          onClick={() => handleCellClick(cell)}
                          selected={
                            selectedCell?.pair === cell.pair &&
                            selectedCell?.timeframe === cell.timeframe
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Side panel overlay */}
      {selectedCell && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 z-10"
            onClick={() => setSelectedCell(null)}
            aria-hidden
          />
          <SidePanel cell={selectedCell} onClose={() => setSelectedCell(null)} />
        </>
      )}
    </div>
  );
}
