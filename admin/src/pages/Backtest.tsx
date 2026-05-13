import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";

import { apiFetch } from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BacktestRunSummary {
  runId: string;
  status: "queued" | "running" | "done" | "failed";
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

interface ListResponse {
  items: BacktestRunSummary[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function statusBadge(status: BacktestRunSummary["status"]): string {
  if (status === "done") return "bg-up-soft/40 text-up-strong border-up/40";
  if (status === "running") return "bg-brand/15 text-brand border-brand/30";
  if (status === "queued") return "bg-warn-soft text-warn border-warn/40";
  if (status === "failed") return "bg-down-soft/40 text-down border-down/40";
  return "bg-sunken text-muted2 border-line";
}

function metricCell(metricsSummary?: Record<string, unknown>): string {
  if (!metricsSummary) return "—";
  const sharpe = metricsSummary["sharpe"];
  const mdd = metricsSummary["maxDrawdownPct"];
  if (sharpe !== undefined && mdd !== undefined) {
    return `Sharpe ${Number(sharpe).toFixed(2)} / MDD ${Number(mdd).toFixed(1)}%`;
  }
  return "—";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Backtest() {
  const [items, setItems] = useState<BacktestRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(async (cursor?: string) => {
    const params = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : "?limit=20";
    const res = await apiFetch<ListResponse>(`/api/admin/backtest${params}`);
    if (!res.success || !res.data) {
      throw new Error(res.error?.message ?? "Failed to load backtest runs");
    }
    return res.data;
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchPage()
      .then((data) => {
        setItems(data.items);
        setNextCursor(data.nextCursor);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, [fetchPage]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(nextCursor);
      setItems((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-ink">Backtest</h1>
          <p className="text-xs text-muted2 mt-0.5">
            Strategy backtests against historical candle data
          </p>
        </div>
        <Link
          to="/backtest/new"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand text-ink text-xs font-medium hover:bg-brand/90 focus-ring transition-colors"
        >
          + New backtest
        </Link>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-down/40 bg-down-soft/40 px-4 py-3 text-xs text-down">
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <p className="text-xs text-muted2 animate-pulse">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-line bg-sunken/40 px-6 py-10 text-center text-xs text-muted2">
          No backtest runs yet.{" "}
          <Link to="/backtest/new" className="text-brand underline underline-offset-2">
            Start one
          </Link>
          .
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-surface overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-sunken/50 border-b border-line">
              <tr>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-muted2 font-medium">
                  Strategy
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-muted2 font-medium">
                  Pair / TF
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-muted2 font-medium">
                  Period
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-muted2 font-medium">
                  Status
                </th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-widest text-muted2 font-medium">
                  Cost
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-muted2 font-medium">
                  Metrics
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-muted2 font-medium">
                  Submitted
                </th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-muted2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((run) => (
                <tr key={run.runId} className="hover:bg-sunken/30 transition-colors">
                  <td className="px-3 py-2 font-mono text-ink2 max-w-[140px] truncate">
                    {run.strategy}
                  </td>
                  <td className="px-3 py-2 text-muted2">
                    {run.pair}{" "}
                    <span className="text-[10px] bg-sunken border border-line rounded px-1 py-0.5">
                      {run.timeframe}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted2 text-[10px] whitespace-nowrap">
                    {run.from.slice(0, 10)} → {run.to.slice(0, 10)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusBadge(run.status)}`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-muted2">
                    {run.actualCostUsd !== undefined
                      ? fmtCost(run.actualCostUsd)
                      : `~${fmtCost(run.estimatedCostUsd)}`}
                  </td>
                  <td className="px-3 py-2 text-muted2 max-w-[180px] truncate">
                    {metricCell(run.metricsSummary)}
                  </td>
                  <td className="px-3 py-2 text-muted2 whitespace-nowrap">
                    {fmtDate(run.submittedAt)}
                  </td>
                  <td className="px-3 py-2 flex items-center gap-2">
                    <Link
                      to={`/backtest/${run.runId}`}
                      className="text-brand text-[11px] hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {nextCursor && (
            <div className="px-3 py-2 border-t border-line">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="text-xs text-brand hover:underline disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
