import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { apiFetch } from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RunStatus = "queued" | "running" | "done" | "failed";

interface BacktestRun {
  runId: string;
  userId: string;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  status: RunStatus;
  strategy: string;
  baseline?: string;
  pair: string;
  timeframe: string;
  from: string;
  to: string;
  ratificationMode: string;
  model?: string;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  metricsSummary?: MetricsSummary;
  s3ResultPrefix?: string;
  artifactKeys?: {
    summaryMd: string;
    metricsJson: string;
    tradesCsv: string;
    equityCurveCsv: string;
    perRuleAttributionCsv: string;
    calibrationByBinCsv: string;
  };
  metrics?: Record<string, unknown>;
}

interface MetricsSummary {
  sharpe?: number;
  maxDrawdownPct?: number;
  totalReturnPct?: number;
  winRate?: number;
  totalTrades?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusBadge(status: RunStatus): string {
  if (status === "done") return "bg-up-soft/40 text-up-strong border-up/40";
  if (status === "running") return "bg-brand/15 text-brand border-brand/30";
  if (status === "queued") return "bg-warn-soft text-warn border-warn/40";
  if (status === "failed") return "bg-down-soft/40 text-down border-down/40";
  return "bg-sunken text-muted2 border-line";
}

// ---------------------------------------------------------------------------
// ASCII Sparkline — equity curve
// ---------------------------------------------------------------------------

function asciiSparkline(values: number[], width = 40, height = 6): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  // Downsample to `width` points
  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) sampled.push(values[i]);

  const rows: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    let line = "";
    for (const v of sampled) {
      const norm = ((v - min) / range) * (height - 1);
      const rounded = Math.round(norm);
      line += rounded === row ? "█" : rounded > row ? "│" : " ";
    }
    rows.push(line);
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 border-b border-line/50 last:border-0">
      <span className="text-[10px] text-muted2 shrink-0">{k}</span>
      <span className="text-[11px] font-mono text-ink2 text-right truncate">{v}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line bg-sunken/40">
        <h2 className="text-[10px] uppercase tracking-widest text-muted2 font-medium">{title}</h2>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BacktestRun() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<BacktestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRun = useCallback(async () => {
    if (!runId) return;
    const res = await apiFetch<BacktestRun>(`/api/admin/backtest/${runId}`);
    if (!res.success || !res.data) {
      throw new Error(res.error?.message ?? "Failed to load run");
    }
    return res.data;
  }, [runId]);

  useEffect(() => {
    if (!runId) return;

    setLoading(true);
    fetchRun()
      .then((data) => {
        if (data) setRun(data);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, [runId, fetchRun]);

  // Poll every 10s while running or queued
  useEffect(() => {
    if (!run) return;
    if (run.status !== "running" && run.status !== "queued") return;

    pollRef.current = setInterval(() => {
      fetchRun()
        .then((data) => {
          if (data) setRun(data);
        })
        .catch(() => {
          /* ignore poll errors */
        });
    }, 10_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [run?.status, fetchRun, run]);

  if (loading) {
    return <p className="text-xs text-muted2 animate-pulse">Loading…</p>;
  }

  if (error || !run) {
    return (
      <div className="rounded-md border border-down/40 bg-down-soft/40 px-4 py-3 text-xs text-down">
        {error ?? "Run not found"}
      </div>
    );
  }

  const metrics = run.metrics ?? run.metricsSummary ?? {};

  // Extract equity curve if available in metrics
  const equityValues: number[] = Array.isArray((metrics as Record<string, unknown>).equityCurve)
    ? ((metrics as Record<string, unknown>).equityCurve as number[])
    : [];

  const perRuleRows: Array<Record<string, unknown>> = Array.isArray(
    (metrics as Record<string, unknown>).perRuleAttribution,
  )
    ? ((metrics as Record<string, unknown>).perRuleAttribution as Array<Record<string, unknown>>)
    : [];

  const calibrationBins: Array<Record<string, unknown>> = Array.isArray(
    (metrics as Record<string, unknown>).calibrationByBin,
  )
    ? ((metrics as Record<string, unknown>).calibrationByBin as Array<Record<string, unknown>>)
    : [];

  return (
    <div className="space-y-5">
      {/* Back link */}
      <Link to="/backtest" className="text-xs text-brand hover:underline">
        ← Back to Backtest
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-ink font-mono">{run.strategy}</h1>
            <span
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusBadge(run.status)}`}
            >
              {run.status}
            </span>
          </div>
          <p className="text-xs text-muted2">
            {run.pair} · {run.timeframe} · {run.from.slice(0, 10)} → {run.to.slice(0, 10)}
          </p>
          {(run.status === "running" || run.status === "queued") && (
            <p className="text-[11px] text-brand animate-pulse">Polling every 10s…</p>
          )}
        </div>
        {run.artifactKeys && (
          <div className="flex gap-2 flex-wrap text-xs">
            <DownloadLink
              href={`/api/admin/backtest/${run.runId}/artifact/trades.csv`}
              label="trades.csv"
            />
            <DownloadLink
              href={`/api/admin/backtest/${run.runId}/artifact/equity-curve.csv`}
              label="equity-curve.csv"
            />
            <DownloadLink
              href={`/api/admin/backtest/${run.runId}/artifact/per-rule-attribution.csv`}
              label="per-rule-attribution.csv"
            />
          </div>
        )}
      </div>

      {/* Run details */}
      <Section title="Run details">
        <div className="grid grid-cols-2 gap-x-6 text-xs">
          <div className="space-y-0.5">
            <Kv k="runId" v={<span className="text-[10px]">{run.runId}</span>} />
            <Kv k="strategy" v={run.strategy} />
            {run.baseline && <Kv k="baseline" v={run.baseline} />}
            <Kv k="ratificationMode" v={run.ratificationMode} />
            {run.model && <Kv k="model" v={run.model} />}
          </div>
          <div className="space-y-0.5">
            <Kv k="submittedAt" v={fmtDate(run.submittedAt)} />
            {run.startedAt && <Kv k="startedAt" v={fmtDate(run.startedAt)} />}
            {run.completedAt && <Kv k="completedAt" v={fmtDate(run.completedAt)} />}
            <Kv k="estimatedCost" v={`$${run.estimatedCostUsd.toFixed(4)}`} />
            {run.actualCostUsd !== undefined && (
              <Kv k="actualCost" v={`$${run.actualCostUsd.toFixed(4)}`} />
            )}
          </div>
        </div>
      </Section>

      {/* Metrics summary */}
      {Object.keys(metrics).length > 0 && (
        <Section title="Summary stats">
          <div className="grid grid-cols-3 gap-3 text-xs">
            {Object.entries(metrics)
              .filter(([, v]) => typeof v === "number")
              .slice(0, 9)
              .map(([k, v]) => (
                <div key={k} className="rounded-md bg-sunken/50 border border-line px-3 py-2">
                  <div className="text-[10px] text-muted2 uppercase tracking-wide">{k}</div>
                  <div className="mt-0.5 font-mono text-sm text-ink2">
                    {typeof v === "number" ? v.toFixed(4) : String(v)}
                  </div>
                </div>
              ))}
          </div>
        </Section>
      )}

      {/* Equity curve sparkline */}
      {equityValues.length > 0 && (
        <Section title="Equity curve">
          <pre className="font-mono text-[9px] text-brand leading-tight overflow-x-auto">
            {asciiSparkline(equityValues)}
          </pre>
          <div className="flex justify-between mt-1 text-[10px] text-muted2">
            <span>Start: {equityValues[0]?.toFixed(4)}</span>
            <span>End: {equityValues[equityValues.length - 1]?.toFixed(4)}</span>
            <span>Points: {equityValues.length}</span>
          </div>
        </Section>
      )}

      {/* Calibration bins bar chart (ASCII) */}
      {calibrationBins.length > 0 && (
        <Section title="Calibration by bin">
          <div className="overflow-x-auto">
            <pre className="font-mono text-[9px] text-muted2 leading-snug">
              {renderCalibrationBins(calibrationBins)}
            </pre>
          </div>
        </Section>
      )}

      {/* Per-rule attribution */}
      {perRuleRows.length > 0 && (
        <Section title="Per-rule attribution">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left py-1 text-[10px] text-muted2 font-medium pr-3">Rule</th>
                  <th className="text-right py-1 text-[10px] text-muted2 font-medium pr-3">
                    Signals
                  </th>
                  <th className="text-right py-1 text-[10px] text-muted2 font-medium pr-3">Win%</th>
                  <th className="text-right py-1 text-[10px] text-muted2 font-medium">Contrib</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {perRuleRows.map((row, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3 font-mono text-ink2">
                      {String(row["rule"] ?? row["name"] ?? "—")}
                    </td>
                    <td className="py-1 pr-3 text-right text-muted2">
                      {String(row["signals"] ?? row["count"] ?? "—")}
                    </td>
                    <td className="py-1 pr-3 text-right text-muted2">
                      {typeof row["winRate"] === "number"
                        ? `${(row["winRate"] * 100).toFixed(1)}%`
                        : "—"}
                    </td>
                    <td className="py-1 text-right text-muted2">
                      {typeof row["contribution"] === "number"
                        ? row["contribution"].toFixed(4)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Status-specific empty states */}
      {run.status === "queued" && (
        <div className="rounded-lg border border-line bg-sunken/40 px-6 py-8 text-center text-xs text-muted2">
          Run is queued — waiting for the backtest runner to pick it up.
        </div>
      )}
      {run.status === "running" && (
        <div className="rounded-lg border border-brand/20 bg-brand/5 px-6 py-8 text-center text-xs text-muted2">
          <span className="text-brand font-medium">Running…</span> Results will appear here when
          complete.
        </div>
      )}
      {run.status === "failed" && (
        <div className="rounded-md border border-down/40 bg-down-soft/40 px-4 py-3 text-xs text-down">
          Backtest failed. Check the runner logs for details.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DownloadLink
// ---------------------------------------------------------------------------

function DownloadLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      download
      className="text-[11px] text-brand border border-brand/30 rounded px-2 py-0.5 hover:bg-brand/10 transition-colors"
    >
      ↓ {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Calibration bins ASCII renderer
// ---------------------------------------------------------------------------

function renderCalibrationBins(bins: Array<Record<string, unknown>>): string {
  if (bins.length === 0) return "";
  const BAR_WIDTH = 20;
  const lines: string[] = [];
  const maxN = Math.max(...bins.map((b) => Number(b["n"] ?? b["count"] ?? 0)));

  for (const bin of bins) {
    const label = String(bin["bin"] ?? bin["label"] ?? "?").padEnd(12);
    const n = Number(bin["n"] ?? bin["count"] ?? 0);
    const winRate = typeof bin["winRate"] === "number" ? bin["winRate"] : null;
    const barLen = maxN > 0 ? Math.round((n / maxN) * BAR_WIDTH) : 0;
    const bar = "█".repeat(barLen).padEnd(BAR_WIDTH);
    const wr = winRate !== null ? `wr=${(winRate * 100).toFixed(0)}%` : "     ";
    lines.push(`${label} ${bar} n=${String(n).padStart(4)} ${wr}`);
  }

  return lines.join("\n");
}
