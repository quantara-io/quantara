import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RunStatus = "queued" | "running" | "done" | "failed";

interface BacktestRunSummary {
  runId: string;
  status: RunStatus;
  strategy: string;
  pair: string;
  timeframe: string;
  from: string;
  to: string;
  submittedAt: string;
  completedAt?: string;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  metricsSummary?: Record<string, unknown>;
}

interface BacktestRunDetail extends BacktestRunSummary {
  ratificationMode: string;
  model?: string;
  baseline?: string;
  metricsSummary?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}

interface ListResponse {
  items: BacktestRunSummary[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "short" });
}

function statusDot(status: RunStatus): string {
  if (status === "done") return "text-up-strong";
  if (status === "running") return "text-brand";
  if (status === "queued") return "text-warn";
  return "text-down";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BacktestCompare() {
  const [allRuns, setAllRuns] = useState<BacktestRunSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");

  const [leftRun, setLeftRun] = useState<BacktestRunDetail | null>(null);
  const [rightRun, setRightRun] = useState<BacktestRunDetail | null>(null);
  const [loadingLeft, setLoadingLeft] = useState(false);
  const [loadingRight, setLoadingRight] = useState(false);

  // Load the run list (for dropdowns)
  useEffect(() => {
    apiFetch<ListResponse>("/api/admin/backtest?limit=100")
      .then((res) => {
        if (res.success && res.data) setAllRuns(res.data.items);
      })
      .catch(() => {
        /* ignore */
      })
      .finally(() => setLoadingList(false));
  }, []);

  const fetchDetail = useCallback(async (runId: string): Promise<BacktestRunDetail | null> => {
    const res = await apiFetch<BacktestRunDetail>(`/api/admin/backtest/${runId}`);
    if (!res.success || !res.data) return null;
    return res.data;
  }, []);

  useEffect(() => {
    if (!leftId) {
      setLeftRun(null);
      return;
    }
    setLoadingLeft(true);
    fetchDetail(leftId)
      .then((d) => setLeftRun(d))
      .catch(() => setLeftRun(null))
      .finally(() => setLoadingLeft(false));
  }, [leftId, fetchDetail]);

  useEffect(() => {
    if (!rightId) {
      setRightRun(null);
      return;
    }
    setLoadingRight(true);
    fetchDetail(rightId)
      .then((d) => setRightRun(d))
      .catch(() => setRightRun(null))
      .finally(() => setLoadingRight(false));
  }, [rightId, fetchDetail]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-base font-semibold text-ink">Compare Backtests</h1>
        <p className="text-xs text-muted2 mt-0.5">
          Pick two completed runs to compare side-by-side
        </p>
      </div>

      {/* Run selectors */}
      <div className="grid grid-cols-2 gap-4">
        <RunPicker
          label="Left run"
          id="left"
          value={leftId}
          onChange={setLeftId}
          runs={allRuns}
          loading={loadingList}
        />
        <RunPicker
          label="Right run"
          id="right"
          value={rightId}
          onChange={setRightId}
          runs={allRuns}
          loading={loadingList}
        />
      </div>

      {/* Comparison grid */}
      {(leftRun || rightRun) && (
        <div className="grid grid-cols-2 gap-4">
          <RunColumn run={leftRun} loading={loadingLeft} side="Left" />
          <RunColumn run={rightRun} loading={loadingRight} side="Right" />
        </div>
      )}

      {!leftId && !rightId && (
        <div className="rounded-lg border border-line bg-sunken/40 px-6 py-10 text-center text-xs text-muted2">
          Select two runs above to compare them side-by-side.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunPicker
// ---------------------------------------------------------------------------

function RunPicker({
  label,
  id,
  value,
  onChange,
  runs,
  loading,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
  runs: BacktestRunSummary[];
  loading: boolean;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-[11px] font-medium text-muted2 uppercase tracking-wide"
      >
        {label}
      </label>
      {loading ? (
        <p className="text-xs text-muted2 animate-pulse">Loading…</p>
      ) : (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input-base w-full"
        >
          <option value="">Select a run…</option>
          {runs.map((r) => (
            <option key={r.runId} value={r.runId} disabled={r.status !== "done"}>
              {r.strategy} · {r.pair} · {fmtDate(r.submittedAt)}{" "}
              {r.status !== "done" ? `(${r.status})` : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunColumn — single run column in the comparison
// ---------------------------------------------------------------------------

function RunColumn({
  run,
  loading,
  side,
}: {
  run: BacktestRunDetail | null;
  loading: boolean;
  side: string;
}) {
  if (loading) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4 animate-pulse text-xs text-muted2">
        Loading {side} run…
      </div>
    );
  }

  if (!run) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4 text-xs text-muted2 text-center">
        No run selected
      </div>
    );
  }

  const metrics = run.metrics ?? run.metricsSummary ?? {};
  const numericMetrics = Object.entries(metrics).filter(([, v]) => typeof v === "number");

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-line bg-sunken/40">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-ink">{run.strategy}</span>
          <span className={`text-[10px] font-medium ${statusDot(run.status)}`}>● {run.status}</span>
        </div>
        <p className="text-[11px] text-muted2 mt-0.5">
          {run.pair} · {run.timeframe} · {run.from.slice(0, 10)} → {run.to.slice(0, 10)}
        </p>
      </div>

      {/* Metrics */}
      <div className="px-4 py-3 space-y-2">
        {numericMetrics.length === 0 ? (
          <p className="text-xs text-muted2">No metrics available</p>
        ) : (
          numericMetrics.slice(0, 12).map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] text-muted2">{k}</span>
              <span className="text-[11px] font-mono text-ink2">
                {typeof v === "number" ? v.toFixed(4) : String(v)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
