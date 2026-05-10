import { useEffect, useState } from "react";
import { GLOSSARY } from "@quantara/shared";

import { apiFetch } from "../lib/api";
import { HelpTooltip } from "../components/HelpTooltip";

// ---------------------------------------------------------------------------
// Types (mirrors admin.service.ts PipelineHealth)
// ---------------------------------------------------------------------------

interface ExchangeHealth {
  lastDataAt: string | null;
  streamHealth: "healthy" | "stale" | "down";
  stalenessSec: number | null;
}

interface QuorumHealth {
  successRate: number | null;
  perPair: Record<string, { perTf: Record<string, number | null> }>;
}

interface LambdaHealth {
  invocations: number | null;
  errors: number | null;
  errorRate: number | null;
  avgDurationMs: number | null;
  throttles: number | null;
}

interface FargateHealth {
  runningCount: number;
  desiredCount: number;
  lastRestartAt: string | null;
  cpuUtilizationPct: number | null;
  memoryUtilizationPct: number | null;
}

interface PipelineHealth {
  windowStart: string;
  windowEnd: string;
  exchanges: Record<string, ExchangeHealth>;
  quorum: QuorumHealth;
  lambdas: Record<string, LambdaHealth>;
  fargate: FargateHealth;
}

const POLL_MS = 30_000;
const QUORUM_TIMEFRAMES = ["15m", "1h", "4h"] as const;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function pct(v: number | null): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function num(v: number | null, decimals = 0): string {
  if (v === null) return "—";
  return v.toFixed(decimals);
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diffS = Math.round((Date.now() - ts) / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  const h = Math.floor(diffS / 3600);
  const m = Math.floor((diffS % 3600) / 60);
  return `${h}h${m > 0 ? `${m}m` : ""} ago`;
}

function healthChipClass(health: "healthy" | "stale" | "down"): string {
  if (health === "healthy") return "bg-emerald-900/40 text-emerald-300 border-emerald-700";
  if (health === "stale") return "bg-yellow-900/40 text-yellow-300 border-yellow-700";
  return "bg-red-900/40 text-red-300 border-red-700";
}

function quorumColor(rate: number | null): string {
  if (rate === null) return "bg-slate-800 text-slate-500";
  if (rate >= 0.95) return "bg-emerald-900/60 text-emerald-300";
  if (rate >= 0.8) return "bg-yellow-900/60 text-yellow-300";
  return "bg-red-900/60 text-red-300";
}

function errorRateColor(rate: number | null): string {
  if (rate === null) return "text-slate-500";
  if (rate === 0) return "text-emerald-400";
  if (rate < 0.01) return "text-yellow-400";
  return "text-red-400";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Hero({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${valueClass ?? "text-slate-100"}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exchange panel
// ---------------------------------------------------------------------------

function ExchangePanel({ exchanges }: { exchanges: Record<string, ExchangeHealth> }) {
  return (
    <Card title="Exchange stream health">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500">
            <th className="text-left font-medium pb-2">Exchange</th>
            <th className="text-left font-medium pb-2">
              <span className="inline-flex items-center gap-1">
                Status
                <HelpTooltip label={GLOSSARY.streamHealth.label}>
                  {GLOSSARY.streamHealth.body}
                </HelpTooltip>
              </span>
            </th>
            <th className="text-left font-medium pb-2">Last data</th>
            <th className="text-left font-medium pb-2">Staleness</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(exchanges).map(([name, ex]) => (
            <tr key={name} className="border-t border-slate-800">
              <td className="py-1.5 font-mono text-slate-300">{name}</td>
              <td className="py-1.5">
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded border ${healthChipClass(ex.streamHealth)}`}
                >
                  {ex.streamHealth}
                </span>
              </td>
              <td className="py-1.5 text-slate-400">{ago(ex.lastDataAt)}</td>
              <td className="py-1.5 text-slate-400">
                {ex.stalenessSec !== null ? `${ex.stalenessSec}s` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Quorum heatmap
// ---------------------------------------------------------------------------

function QuorumHeatmap({ quorum }: { quorum: QuorumHealth }) {
  const pairs = Object.keys(quorum.perPair);
  if (pairs.length === 0) {
    return (
      <Card title="Quorum success rate">
        <p className="text-xs text-slate-600">No quorum data available for this window.</p>
      </Card>
    );
  }

  return (
    <Card title="Quorum success rate (pair × timeframe)">
      <p className="text-[11px] text-slate-600 mb-2 inline-flex items-center gap-1">
        ≥2 of 3 exchanges must agree on each bar close.
        <HelpTooltip label={GLOSSARY.quorum.label}>{GLOSSARY.quorum.body}</HelpTooltip>
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="text-left font-medium text-slate-500 pb-1 pr-2 w-28">Pair</th>
              {QUORUM_TIMEFRAMES.map((tf) => (
                <th key={tf} className="text-center font-medium text-slate-500 pb-1 w-16">
                  {tf}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pairs.map((pair) => (
              <tr key={pair}>
                <td className="font-mono text-slate-400 pr-2 py-0.5 text-[11px]">{pair}</td>
                {QUORUM_TIMEFRAMES.map((tf) => {
                  const rate = quorum.perPair[pair]?.perTf[tf] ?? null;
                  return (
                    <td key={tf} className="py-0.5">
                      <div
                        className={`text-center rounded px-1 py-0.5 text-[10px] font-mono ${quorumColor(rate)}`}
                      >
                        {rate !== null ? `${(rate * 100).toFixed(0)}%` : "—"}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Lambda table
// ---------------------------------------------------------------------------

function LambdaTable({ lambdas }: { lambdas: Record<string, LambdaHealth> }) {
  return (
    <Card title="Lambda metrics (CloudWatch, last window)">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500">
            <th className="text-left font-medium pb-2">Function</th>
            <th className="text-left font-medium pb-2">Invocations</th>
            <th className="text-left font-medium pb-2">Error rate</th>
            <th className="text-left font-medium pb-2">Avg duration</th>
            <th className="text-left font-medium pb-2">
              <span className="inline-flex items-center gap-1">
                Throttles
                <HelpTooltip label={GLOSSARY.lambdaThrottles.label}>
                  {GLOSSARY.lambdaThrottles.body}
                </HelpTooltip>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(lambdas).map(([name, l]) => (
            <tr key={name} className="border-t border-slate-800">
              <td className="py-1.5 font-mono text-slate-300">{name}</td>
              <td className="py-1.5 text-slate-300">{num(l.invocations)}</td>
              <td className={`py-1.5 font-mono ${errorRateColor(l.errorRate)}`}>
                {pct(l.errorRate)}
              </td>
              <td className="py-1.5 text-slate-300">
                {l.avgDurationMs !== null ? `${num(l.avgDurationMs, 0)}ms` : "—"}
              </td>
              <td className="py-1.5 text-slate-300">{num(l.throttles)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.values(lambdas).every((l) => l.invocations === null) && (
        <p className="text-[10px] text-slate-600 mt-2">
          CloudWatch metrics unavailable. Possible causes: missing IAM permissions, no recent
          activity, or transient API failure.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fargate panel
// ---------------------------------------------------------------------------

function FargatePanel({ fargate }: { fargate: FargateHealth }) {
  const taskHealthy = fargate.runningCount > 0 && fargate.runningCount >= fargate.desiredCount;
  return (
    <Card title="Fargate ingestion service">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat
          label="Tasks"
          value={`${fargate.runningCount}/${fargate.desiredCount}`}
          valueClass={taskHealthy ? "text-emerald-400" : "text-red-400"}
        />
        <Stat
          label="CPU util"
          value={fargate.cpuUtilizationPct !== null ? `${num(fargate.cpuUtilizationPct, 1)}%` : "—"}
          valueClass={
            fargate.cpuUtilizationPct !== null && fargate.cpuUtilizationPct > 80
              ? "text-red-400"
              : "text-slate-300"
          }
        />
        <Stat
          label="Memory util"
          value={
            fargate.memoryUtilizationPct !== null ? `${num(fargate.memoryUtilizationPct, 1)}%` : "—"
          }
          valueClass={
            fargate.memoryUtilizationPct !== null && fargate.memoryUtilizationPct > 85
              ? "text-red-400"
              : "text-slate-300"
          }
        />
        <Stat label="Last restart" value={ago(fargate.lastRestartAt)} />
      </div>
    </Card>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${valueClass ?? "text-slate-200"}`}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Health() {
  const [data, setData] = useState<PipelineHealth | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await apiFetch<PipelineHealth>("/api/admin/pipeline-health");
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
        setError("");
      } else {
        setError(res.error?.message ?? "Failed to load pipeline health");
      }
    }
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <div className="p-4 rounded bg-red-950/40 text-red-300 border border-red-900 text-sm">
        {error}
      </div>
    );
  }
  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  // Derive top-row summary values
  const exchangeList = Object.values(data.exchanges);
  const healthyCount = exchangeList.filter((e) => e.streamHealth === "healthy").length;
  const totalExchanges = exchangeList.length;

  const lambdaErrors = Object.values(data.lambdas).reduce((sum, l) => sum + (l.errors ?? 0), 0);
  const lambdaInvocations = Object.values(data.lambdas).reduce(
    (sum, l) => sum + (l.invocations ?? 0),
    0,
  );
  const overallErrorRate = lambdaInvocations > 0 ? lambdaErrors / lambdaInvocations : null;

  return (
    <div className="space-y-4">
      {/* Top row summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Hero
          label="Exchanges"
          value={`${healthyCount} / ${totalExchanges}`}
          sub="healthy streams"
          valueClass={healthyCount === totalExchanges ? "text-emerald-400" : "text-yellow-400"}
        />
        <Hero
          label="Quorum rate"
          value={data.quorum.successRate !== null ? pct(data.quorum.successRate) : "—"}
          sub="bar-closes with consensus"
          valueClass={
            data.quorum.successRate !== null && data.quorum.successRate >= 0.95
              ? "text-emerald-400"
              : "text-yellow-400"
          }
        />
        <Hero
          label="Lambda error rate"
          value={overallErrorRate !== null ? pct(overallErrorRate) : "—"}
          sub="all functions"
          valueClass={errorRateColor(overallErrorRate)}
        />
        <Hero
          label="Fargate tasks"
          value={`${data.fargate.runningCount} / ${data.fargate.desiredCount}`}
          sub={data.fargate.runningCount > 0 ? "running" : "down"}
          valueClass={data.fargate.runningCount > 0 ? "text-emerald-400" : "text-red-400"}
        />
      </div>

      {/* Detail panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ExchangePanel exchanges={data.exchanges} />
        <FargatePanel fargate={data.fargate} />
      </div>

      <QuorumHeatmap quorum={data.quorum} />

      <LambdaTable lambdas={data.lambdas} />

      <p className="text-xs text-slate-600">
        Window: {new Date(data.windowStart).toLocaleString()} &mdash;{" "}
        {new Date(data.windowEnd).toLocaleString()} · refreshes every 30s
      </p>
    </div>
  );
}
