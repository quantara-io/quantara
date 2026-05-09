import { useEffect, useState } from "react";
import { PAIRS } from "@quantara/shared";
import { apiFetch } from "../lib/api";

// ---------------------------------------------------------------------------
// Debug result types
// ---------------------------------------------------------------------------

interface ForceRatificationResult {
  verdict: string | null;
  confidence: number | null;
  reasoning: string | null;
  latencyMs: number;
  costUsd: number;
  cacheHit: boolean;
  fellBackToAlgo: boolean;
  recordId: string;
}

interface InjectShockResult {
  decision: "fired" | "gated" | "skipped";
  reasons: string[];
  shockRecord: Record<string, unknown> | null;
}

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
}

interface RecentSignalEntry {
  type: string | null;
  ratificationStatus: string | null;
  emittedAt: string | null;
  reasoning: string | null;
}

interface SignalState {
  type: string | null;
  confidence: number | null;
  ratificationStatus: string | null;
  interpretationText: string | null;
  closeTime: string | null;
  ageSeconds: number | null;
  recentHistory: RecentSignalEntry[];
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

const TIMEFRAMES = ["15m", "1h", "4h", "1d", "consensus"] as const;
const POLL_MS = 5_000;

/** Timeframe durations in seconds — used for age colour thresholds.
 *  `consensus` is a rolled-up pseudo-tf with no fixed cadence; bound it to
 *  the slowest real tf so the cell never goes red on age alone.  */
const TF_DURATION_S: Record<string, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
  consensus: 24 * 60 * 60,
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
      <span
        className={`text-[11px] font-mono tabular-nums truncate ${valueClass ?? "text-slate-300"}`}
      >
        {value}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] uppercase tracking-widest text-slate-600 mb-0.5 mt-1.5 first:mt-0">
      {children}
    </div>
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

  // A cell is "empty" only when ALL data sources are missing — including
  // both sentiment windows. Without checking 24h, a cell with stale 4h
  // sentiment but fresh 24h sentiment renders as fully empty even though
  // there's data available.
  const isEmpty =
    cell.indicator.asOf === null &&
    cell.signal.type === null &&
    cell.sentiment4h.score === null &&
    cell.sentiment24h.score === null;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border p-2 transition-colors
        ${
          selected
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
          <Stat
            label="Conf"
            value={
              cell.signal.confidence !== null
                ? `${(cell.signal.confidence * 100).toFixed(0)}%`
                : "—"
            }
          />
          {cell.signal.ratificationStatus && (
            <div className="mt-0.5">
              <span
                className={`text-[9px] px-1.5 py-0.5 rounded border ${ratificationBadge(cell.signal.ratificationStatus)}`}
              >
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

function SidePanel({ cell, onClose }: { cell: PipelineCell; onClose: () => void }) {
  const [ratResult, setRatResult] = useState<ForceRatificationResult | null>(null);
  const [ratError, setRatError] = useState("");
  const [ratLoading, setRatLoading] = useState(false);
  const [ratConfirmed, setRatConfirmed] = useState(false);

  async function handleForceRatification() {
    if (!ratConfirmed) {
      setRatConfirmed(true);
      return;
    }
    setRatLoading(true);
    setRatError("");
    setRatResult(null);
    const res = await apiFetch<ForceRatificationResult>("/api/admin/debug/force-ratification", {
      method: "POST",
      body: { pair: cell.pair, timeframe: cell.timeframe },
    });
    setRatLoading(false);
    setRatConfirmed(false);
    if (res.success && res.data) {
      setRatResult(res.data);
    } else {
      setRatError(res.error?.message ?? "Force ratification failed");
    }
  }

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
        {/* Debug: Force ratification */}
        <section>
          <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">
            Debug Controls
          </h3>
          <div className="space-y-2">
            <button
              onClick={handleForceRatification}
              disabled={ratLoading}
              className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                ratConfirmed
                  ? "bg-red-900/60 border-red-700 text-red-200 hover:bg-red-800/80"
                  : "bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500 hover:bg-slate-700"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {ratLoading
                ? "Firing…"
                : ratConfirmed
                  ? "Confirm — this costs real Bedrock dollars"
                  : "Force ratification"}
            </button>
            {ratConfirmed && !ratLoading && (
              <button
                onClick={() => setRatConfirmed(false)}
                className="ml-2 text-xs text-slate-500 hover:text-slate-300 underline"
              >
                Cancel
              </button>
            )}
            {ratError && (
              <p className="text-xs text-red-400 bg-red-950/30 rounded p-2">{ratError}</p>
            )}
            {ratResult && (
              <div className="text-[11px] bg-slate-900 rounded p-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-slate-500">Verdict</span>
                  <span
                    className={`font-semibold ${
                      ratResult.verdict === "ratify"
                        ? "text-emerald-400"
                        : ratResult.verdict === "downgrade"
                          ? "text-yellow-400"
                          : "text-red-400"
                    }`}
                  >
                    {ratResult.verdict ?? "—"}
                  </span>
                  <span className="ml-auto text-slate-500 font-mono">
                    {ratResult.latencyMs}ms · ${ratResult.costUsd.toFixed(5)}
                  </span>
                </div>
                {ratResult.reasoning && (
                  <p className="text-slate-400">{ratResult.reasoning}</p>
                )}
                {ratResult.fellBackToAlgo && (
                  <p className="text-yellow-500">Fell back to algo signal (LLM failed)</p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Interpretation text */}
        {cell.signal.interpretationText && (
          <section>
            <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">
              Interpretation (truncated)
            </h3>
            <p className="text-xs text-slate-300 bg-slate-900 rounded p-3">
              {cell.signal.interpretationText}
            </p>
          </section>
        )}

        {/* Recent signals — sourced from signals_v2 (NOT the ratifications
            audit table). For per-call LLM ratification history, use the
            Ratifications page (issue #185 / PR #196). */}
        <section>
          <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">
            Recent Signals (last {cell.signal.recentHistory.length})
          </h3>
          {cell.signal.recentHistory.length === 0 ? (
            <p className="text-xs text-slate-600">No history</p>
          ) : (
            <div className="space-y-2">
              {cell.signal.recentHistory.map((row, i) => (
                // Stable key: emittedAt is unique per row when present.
                // Falls back to index only when emittedAt is null (rare —
                // a row with no emit timestamp is already malformed).
                <div
                  key={row.emittedAt ?? `idx-${i}`}
                  className="text-[10px] bg-slate-900 rounded p-2"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`font-semibold ${signalTypeColor(row.type)}`}>
                      {row.type ?? "—"}
                    </span>
                    {row.ratificationStatus && (
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[9px] ${ratificationBadge(row.ratificationStatus)}`}
                      >
                        {row.ratificationStatus}
                      </span>
                    )}
                    <span className="ml-auto text-slate-500 font-mono">
                      {row.emittedAt ? new Date(row.emittedAt).toLocaleTimeString() : "—"}
                    </span>
                  </div>
                  {row.reasoning && <p className="text-slate-400 line-clamp-2">{row.reasoning}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Sentiment detail */}
        <section>
          <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">
            Sentiment Detail
          </h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                {["Window", "Score", "Magnitude", "Articles", "Age"].map((h) => (
                  <th key={h} className="text-left font-medium pb-1.5">
                    {h}
                  </th>
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
                  <td className={`py-1.5 font-mono ${ageColor(data.ageSeconds, dur)}`}>
                    {fmt(data.score, 3)}
                  </td>
                  <td className="py-1.5 font-mono text-slate-300">{fmt(data.magnitude, 3)}</td>
                  <td className="py-1.5 text-slate-300">{data.articleCount ?? "—"}</td>
                  <td className={`py-1.5 font-mono ${ageColor(data.ageSeconds, dur)}`}>
                    {fmtAge(data.ageSeconds)}
                  </td>
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
// Inject Shock modal
// ---------------------------------------------------------------------------

function InjectShockModal({
  pair,
  onClose,
}: {
  pair: string;
  onClose: () => void;
}) {
  const [deltaScore, setDeltaScore] = useState("0.5");
  const [deltaMagnitude, setDeltaMagnitude] = useState("0.1");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InjectShockResult | null>(null);
  const [error, setError] = useState("");

  async function handleInject() {
    if (!confirmed) {
      setConfirmed(true);
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    const res = await apiFetch<InjectShockResult>("/api/admin/debug/inject-sentiment-shock", {
      method: "POST",
      body: {
        pair,
        deltaScore: parseFloat(deltaScore),
        deltaMagnitude: parseFloat(deltaMagnitude),
      },
    });
    setLoading(false);
    setConfirmed(false);
    if (res.success && res.data) {
      setResult(res.data);
    } else {
      setError(res.error?.message ?? "Inject shock failed");
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-30"
        onClick={onClose}
        aria-hidden
      />
      <div className="fixed inset-x-4 top-1/4 max-w-sm mx-auto bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-40 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Inject Sentiment Shock</h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="rounded bg-amber-950/50 border border-amber-800 p-2 text-[11px] text-amber-300">
          This writes a real <code>sentiment_shock</code> ratification record to DynamoDB.
          The shock is observed end-to-end but does not alter the live signal output.
        </div>

        <div className="space-y-2">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Pair</label>
            <div className="text-xs font-mono text-slate-200">{pair}</div>
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Delta Score{" "}
              <span className="text-slate-600">(added to current aggregate, range [-2, 2])</span>
            </label>
            <input
              type="number"
              step="0.1"
              min="-2"
              max="2"
              value={deltaScore}
              onChange={(e) => { setDeltaScore(e.target.value); setConfirmed(false); }}
              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-slate-500"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Delta Magnitude{" "}
              <span className="text-slate-600">(added to current aggregate, range [-1, 1])</span>
            </label>
            <input
              type="number"
              step="0.1"
              min="-1"
              max="1"
              value={deltaMagnitude}
              onChange={(e) => { setDeltaMagnitude(e.target.value); setConfirmed(false); }}
              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-slate-500"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleInject}
            disabled={loading}
            className={`flex-1 py-1.5 rounded text-xs font-medium border transition-colors ${
              confirmed
                ? "bg-red-900/60 border-red-700 text-red-200 hover:bg-red-800/80"
                : "bg-indigo-700 border-indigo-600 text-white hover:bg-indigo-600"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loading ? "Injecting…" : confirmed ? "Confirm — this is real" : "Inject shock"}
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs border border-slate-700 text-slate-400 hover:border-slate-500"
          >
            Close
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-950/30 rounded p-2">{error}</p>
        )}

        {result && (
          <div className="space-y-1">
            <div
              className={`text-xs font-semibold ${
                result.decision === "fired"
                  ? "text-emerald-400"
                  : result.decision === "gated"
                    ? "text-orange-400"
                    : "text-slate-400"
              }`}
            >
              {result.decision.toUpperCase()}
            </div>
            <ul className="text-[11px] text-slate-400 space-y-0.5">
              {result.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Pipeline() {
  const [data, setData] = useState<PipelineData | null>(null);
  const [error, setError] = useState("");
  const [selectedCell, setSelectedCell] = useState<PipelineCell | null>(null);
  const [shockPair, setShockPair] = useState<string | null>(null);

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
                <th className="text-left text-[10px] uppercase tracking-widest text-slate-500 pb-1 w-24">
                  Pair
                </th>
                {TIMEFRAMES.map((tf) => (
                  <th
                    key={tf}
                    className="text-center text-[10px] uppercase tracking-widest text-slate-500 pb-1"
                  >
                    {tf}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PAIRS.map((pair) => (
                <tr key={pair}>
                  <td className="text-xs font-mono text-slate-400 pr-2 align-top pt-1">
                    <div>{pair}</div>
                    <button
                      onClick={() => setShockPair(pair)}
                      className="mt-1 text-[9px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300 transition-colors whitespace-nowrap"
                      title="Inject synthetic sentiment shock for this pair"
                    >
                      inject shock
                    </button>
                  </td>
                  {TIMEFRAMES.map((tf) => {
                    const cell = cellMap.get(pair)?.get(tf);
                    if (!cell) {
                      return (
                        <td key={tf} className="align-top">
                          <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 opacity-40 text-[11px] text-slate-600">
                            —
                          </div>
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

      {/* Inject shock modal */}
      {shockPair && (
        <InjectShockModal pair={shockPair} onClose={() => setShockPair(null)} />
      )}
    </div>
  );
}
