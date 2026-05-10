import { useEffect, useState } from "react";

import { apiFetch } from "../lib/api";

interface Status {
  tableCounts: { name: string; count: number; size: number }[];
  fearGreed: { value: number; classification: string } | null;
  ecsStatus: { status: string; running: number; desired: number; taskId?: string };
  queueDepths: { name: string; messages: number; inflight: number; dlq: boolean }[];
  recentLogs: string[];
  lambdaStatuses: { name: string; state: string; lastModified: string; size: number }[];
  timestamp: string;
}

const POLL_MS = 30_000;

export function Ops() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await apiFetch<Status>("/api/admin/status");
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
        setError("");
      } else setError(res.error?.message ?? "Failed to load");
    }
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error)
    return (
      <div className="p-4 rounded bg-down-soft text-down-strong border border-down/30 text-sm">
        {error}
      </div>
    );
  if (!data) return <div className="text-sm text-muted2">Loading…</div>;

  const fg = data.fearGreed;
  const fgColor = fg ? fgColorFor(fg.value) : "text-muted2";
  const totalRecords = data.tableCounts.reduce((s, t) => s + (t.count > 0 ? t.count : 0), 0);
  const totalSizeMB = (data.tableCounts.reduce((s, t) => s + t.size, 0) / 1024 / 1024).toFixed(1);
  const ecsHealthy = data.ecsStatus.running > 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Hero label="Records" value={totalRecords.toLocaleString()} />
        <Hero label="Storage" value={`${totalSizeMB} MB`} />
        <Hero
          label="Fear & Greed"
          value={fg ? `${fg.value}` : "—"}
          sub={fg?.classification ?? ""}
          valueClass={fgColor}
        />
        <Hero
          label="Ingestion"
          value={`${data.ecsStatus.running}/${data.ecsStatus.desired}`}
          sub={data.ecsStatus.status}
          valueClass={ecsHealthy ? "text-up" : "text-down"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="DynamoDB Tables">
          <Table
            headers={["Table", "Count", "Size"]}
            rows={data.tableCounts.map((t) => [
              t.name,
              t.count < 0 ? "—" : t.count.toLocaleString(),
              `${(t.size / 1024 / 1024).toFixed(2)} MB`,
            ])}
          />
        </Card>

        <Card title="SQS Queues">
          <Table
            headers={["Queue", "Messages", "In-flight"]}
            rows={data.queueDepths.map((q) => [
              q.dlq ? `${q.name} ⚠` : q.name,
              q.messages < 0 ? "—" : q.messages.toLocaleString(),
              q.inflight.toLocaleString(),
            ])}
          />
        </Card>

        <Card title="Lambda Functions">
          <Table
            headers={["Function", "State", "Size"]}
            rows={data.lambdaStatuses.map((l) => [
              l.name,
              l.state,
              l.size ? `${(l.size / 1024).toFixed(0)} KB` : "—",
            ])}
          />
        </Card>

        <Card title="Recent Ingestion Logs">
          <pre className="text-[11px] text-muted whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
            {data.recentLogs.join("\n")}
          </pre>
        </Card>
      </div>

      <p className="text-xs text-muted2">
        Updated {new Date(data.timestamp).toLocaleTimeString()} · refreshes every 30s
      </p>
    </div>
  );
}

function fgColorFor(v: number) {
  if (v <= 25) return "text-down";
  if (v <= 45) return "text-warn";
  if (v <= 55) return "text-warn";
  if (v <= 75) return "text-up";
  return "text-up";
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
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-[10px] uppercase tracking-widest text-muted2">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${valueClass ?? "text-ink"}`}>{value}</div>
      {sub && <div className="text-xs text-muted2 mt-1">{sub}</div>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-xs uppercase tracking-widest text-muted2 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted2">
          {headers.map((h) => (
            <th key={h} className="text-left font-medium pb-2">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-line">
            {r.map((v, j) => (
              <td key={j} className="py-1.5 text-ink2">
                {v}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
