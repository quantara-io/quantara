import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RatificationRow {
  recordId: string;
  pair: string;
  timeframe: string;
  invokedReason: string;
  invokedAt: string;
  latencyMs: number;
  costUsd: number;
  cacheHit: boolean;
  validationOk: boolean;
  fellBackToAlgo: boolean;
  algoCandidateType: string | null;
  algoCandidateConfidence: number | null;
  ratifiedType: string | null;
  ratifiedConfidence: number | null;
  ratifiedReasoning: string | null;
  llmModel: string | null;
  algoCandidate: Record<string, unknown> | null;
  ratified: Record<string, unknown> | null;
  llmRequest: Record<string, unknown> | null;
  llmRawResponse: Record<string, unknown> | null;
}

interface Page {
  items: RatificationRow[];
  cursor: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRIGGER_REASONS = ["bar_close", "sentiment_shock", "manual"] as const;
const KNOWN_PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"] as const;

type TimeRange = "1h" | "24h" | "7d" | "custom";

function sinceForRange(range: TimeRange, customSince: string): string | undefined {
  const now = Date.now();
  if (range === "1h") return new Date(now - 3600_000).toISOString();
  if (range === "24h") return new Date(now - 86400_000).toISOString();
  if (range === "7d") return new Date(now - 7 * 86400_000).toISOString();
  if (range === "custom" && customSince) return new Date(customSince).toISOString();
  return undefined;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportCsv(rows: RatificationRow[]) {
  const headers = [
    "recordId", "pair", "timeframe", "invokedReason", "invokedAt",
    "latencyMs", "costUsd", "cacheHit", "validationOk", "fellBackToAlgo",
    "algoCandidateType", "algoCandidateConfidence",
    "ratifiedType", "ratifiedConfidence", "ratifiedReasoning", "llmModel",
  ];
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      headers.map((h) => escape(r[h as keyof RatificationRow])).join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ratifications-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

function Modal({ row, onClose }: { row: RatificationRow; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-cyan-300">
            Ratification detail — {row.pair} {row.timeframe} @ {new Date(row.invokedAt).toLocaleString()}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 text-xs">
          <Section title="Summary">
            <KV k="recordId" v={row.recordId} />
            <KV k="invokedReason" v={row.invokedReason} />
            <KV k="latencyMs" v={row.latencyMs} />
            <KV k="costUsd" v={row.costUsd?.toFixed(6)} />
            <KV k="cacheHit" v={String(row.cacheHit)} />
            <KV k="validationOk" v={String(row.validationOk)} />
            <KV k="fellBackToAlgo" v={String(row.fellBackToAlgo)} />
            <KV k="model" v={row.llmModel ?? "—"} />
          </Section>

          <Section title="Algo Candidate">
            <JsonBlock value={row.algoCandidate} />
          </Section>

          <Section title="Ratified Verdict">
            <JsonBlock value={row.ratified} />
          </Section>

          <Section title="LLM Request (hashes)">
            <JsonBlock value={row.llmRequest} />
          </Section>

          <Section title="LLM Raw Response">
            <JsonBlock value={row.llmRawResponse} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{title}</p>
      <div className="bg-slate-800/50 rounded-lg p-3 space-y-1">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: unknown }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 min-w-[140px]">{k}</span>
      <span className="text-slate-200 break-all">{String(v)}</span>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-slate-500 italic">null</span>;
  }
  return (
    <pre className="text-[11px] text-emerald-300 whitespace-pre-wrap break-all">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Ratifications() {
  const [rows, setRows] = useState<RatificationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedRow, setSelectedRow] = useState<RatificationRow | null>(null);

  // Filters
  const [filterPair, setFilterPair] = useState<string>("");
  const [filterTrigger, setFilterTrigger] = useState<string>("");
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  const [customSince, setCustomSince] = useState("");

  // Sort
  const [sortCol, setSortCol] = useState<keyof RatificationRow>("invokedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const abortRef = useRef<AbortController | null>(null);

  const buildQuery = useCallback(
    (nextCursor?: string | null) => {
      const params = new URLSearchParams();
      if (filterPair) params.set("pair", filterPair);
      if (filterTrigger) params.set("triggerReason", filterTrigger);
      const since = sinceForRange(timeRange, customSince);
      if (since) params.set("since", since);
      params.set("limit", "50");
      if (nextCursor) params.set("cursor", nextCursor);
      return `/api/admin/ratifications?${params.toString()}`;
    },
    [filterPair, filterTrigger, timeRange, customSince],
  );

  const load = useCallback(
    async (reset: boolean) => {
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      setLoading(true);
      if (reset) { setRows([]); setCursor(null); }
      const url = buildQuery(reset ? null : cursor);
      const res = await apiFetch<Page>(url);
      setLoading(false);
      if (res.success && res.data) {
        setRows((prev) => (reset ? res.data!.items : [...prev, ...res.data!.items]));
        setCursor(res.data.cursor);
        setError("");
      } else {
        setError(res.error?.message ?? "Failed to load ratifications");
      }
    },
    // cursor intentionally excluded from deps — only used for "load more"
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildQuery],
  );

  // Reload on filter change
  useEffect(() => { void load(true); }, [load]);

  // Sort rows client-side
  const sorted = [...rows].sort((a, b) => {
    const av = a[sortCol] ?? "";
    const bv = b[sortCol] ?? "";
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
    return sortDir === "asc" ? cmp : -cmp;
  });

  function toggleSort(col: keyof RatificationRow) {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  function SortHeader({ col, label }: { col: keyof RatificationRow; label: string }) {
    const active = sortCol === col;
    return (
      <th
        onClick={() => toggleSort(col)}
        className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 cursor-pointer select-none hover:text-slate-300 whitespace-nowrap"
      >
        {label}
        {active && <span className="ml-1 text-cyan-400">{sortDir === "asc" ? "▲" : "▼"}</span>}
      </th>
    );
  }

  return (
    <div className="space-y-4">
      {selectedRow && <Modal row={selectedRow} onClose={() => setSelectedRow(null)} />}

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Pair pills */}
        <span className="text-[11px] text-slate-500">Pair:</span>
        {(["", ...KNOWN_PAIRS] as string[]).map((p) => (
          <button
            key={p || "all"}
            onClick={() => setFilterPair(p)}
            className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
              filterPair === p
                ? "border-cyan-500 bg-cyan-950 text-cyan-300"
                : "border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            {p || "All"}
          </button>
        ))}

        {/* Trigger pills */}
        <span className="ml-2 text-[11px] text-slate-500">Trigger:</span>
        {(["", ...TRIGGER_REASONS] as string[]).map((t) => (
          <button
            key={t || "all"}
            onClick={() => setFilterTrigger(t)}
            className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
              filterTrigger === t
                ? "border-purple-500 bg-purple-950 text-purple-300"
                : "border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            {t || "All"}
          </button>
        ))}

        {/* Time range pills */}
        <span className="ml-2 text-[11px] text-slate-500">Range:</span>
        {(["1h", "24h", "7d", "custom"] as TimeRange[]).map((r) => (
          <button
            key={r}
            onClick={() => setTimeRange(r)}
            className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
              timeRange === r
                ? "border-emerald-500 bg-emerald-950 text-emerald-300"
                : "border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            {r === "custom" ? "Custom" : `Last ${r}`}
          </button>
        ))}
        {timeRange === "custom" && (
          <input
            type="datetime-local"
            value={customSince}
            onChange={(e) => setCustomSince(e.target.value)}
            className="ml-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200"
          />
        )}

        <div className="ml-auto">
          <button
            onClick={() => exportCsv(sorted)}
            disabled={sorted.length === 0}
            className="px-3 py-1.5 text-[11px] rounded border border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-950/40 text-red-300 border border-red-900 text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-slate-900 border-b border-slate-800 z-10">
            <tr>
              <SortHeader col="invokedAt" label="Time" />
              <SortHeader col="pair" label="Pair" />
              <SortHeader col="timeframe" label="TF" />
              <SortHeader col="invokedReason" label="Trigger" />
              <SortHeader col="llmModel" label="Model" />
              <SortHeader col="cacheHit" label="Cache?" />
              <SortHeader col="latencyMs" label="Latency" />
              <SortHeader col="costUsd" label="Cost" />
              <SortHeader col="algoCandidateType" label="Algo" />
              <SortHeader col="ratifiedType" label="LLM" />
              <SortHeader col="validationOk" label="Valid?" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {sorted.map((row) => (
              <tr
                key={row.recordId}
                onClick={() => setSelectedRow(row)}
                className="cursor-pointer hover:bg-slate-800/40 transition-colors"
              >
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                  {new Date(row.invokedAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-slate-200 whitespace-nowrap">{row.pair}</td>
                <td className="px-3 py-2 text-slate-400">{row.timeframe}</td>
                <td className="px-3 py-2">
                  <TriggerBadge reason={row.invokedReason} />
                </td>
                <td className="px-3 py-2 text-slate-500 truncate max-w-[120px]" title={row.llmModel ?? ""}>
                  {row.llmModel ? row.llmModel.split(".").pop() : "—"}
                </td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${row.cacheHit ? "bg-indigo-950 text-indigo-300" : "bg-slate-800 text-slate-500"}`}>
                    {row.cacheHit ? "HIT" : "MISS"}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-400 text-right tabular-nums">{row.latencyMs}ms</td>
                <td className="px-3 py-2 text-slate-400 text-right tabular-nums">${row.costUsd.toFixed(5)}</td>
                <td className="px-3 py-2">
                  {row.algoCandidateType
                    ? <VerdictBadge type={row.algoCandidateType} conf={row.algoCandidateConfidence} />
                    : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-3 py-2">
                  {row.ratifiedType
                    ? <VerdictBadge type={row.ratifiedType} conf={row.ratifiedConfidence} />
                    : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${row.validationOk ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`}>
                    {row.validationOk ? "OK" : "FAIL"}
                  </span>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-slate-600 text-sm">
                  No ratification records found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Load more / spinner */}
      <div className="flex items-center justify-center gap-4 pt-1">
        {loading && <span className="text-sm text-slate-500">Loading...</span>}
        {!loading && cursor && (
          <button
            onClick={() => void load(false)}
            className="px-4 py-2 text-sm rounded border border-slate-700 bg-slate-800 text-slate-300 hover:text-white"
          >
            Load more
          </button>
        )}
        {!loading && !cursor && rows.length > 0 && (
          <span className="text-[11px] text-slate-600">{rows.length} records loaded</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small badge components
// ---------------------------------------------------------------------------

function TriggerBadge({ reason }: { reason: string }) {
  const colour =
    reason === "bar_close" ? "bg-blue-950 text-blue-300"
    : reason === "sentiment_shock" ? "bg-orange-950 text-orange-300"
    : reason === "manual" ? "bg-violet-950 text-violet-300"
    : reason.startsWith("skip-") ? "bg-slate-800 text-slate-500"
    : "bg-slate-800 text-slate-400";
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${colour}`}>{reason}</span>;
}

function VerdictBadge({ type, conf }: { type: string; conf: number | null }) {
  const colour =
    type === "buy" || type === "strong_buy" ? "bg-emerald-950 text-emerald-300"
    : type === "sell" || type === "strong_sell" ? "bg-red-950 text-red-300"
    : "bg-slate-800 text-slate-400";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] ${colour}`}>
      {type}
      {conf !== null && <span className="opacity-70 ml-1">{(conf * 100).toFixed(0)}%</span>}
    </span>
  );
}
