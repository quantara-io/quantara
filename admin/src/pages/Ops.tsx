import { useEffect, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { Card, CardHeader } from "../components/ui/Card";
import { formatBytes, formatNum, MonoNum } from "../components/ui/MonoNum";
import { PageHeader } from "../components/ui/Section";
import { StatTile } from "../components/ui/StatTile";
import { DataTable } from "../components/ui/Table";
import { apiFetch } from "../lib/api";

interface TableCount {
  name: string;
  count: number;
  size: number;
}
interface Queue {
  name: string;
  messages: number;
  inflight: number;
  dlq: boolean;
}
interface LambdaStatus {
  name: string;
  state: string;
  lastModified: string;
  size: number;
}

interface Status {
  tableCounts: TableCount[];
  fearGreed: { value: number; classification: string } | null;
  ecsStatus: { status: string; running: number; desired: number; taskId?: string };
  queueDepths: Queue[];
  recentLogs: string[];
  lambdaStatuses: LambdaStatus[];
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

  if (error) {
    return (
      <>
        <PageHeader title="Ops" subtitle="Backend services snapshot" />
        <div className="rounded-md border border-down/30 bg-down-soft text-down-strong text-sm p-3">
          {error}
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Ops" subtitle="Backend services snapshot" />
        <div className="text-sm text-muted2">Loading…</div>
      </>
    );
  }

  const fg = data.fearGreed;
  const totalRecords = data.tableCounts.reduce((s, t) => s + (t.count > 0 ? t.count : 0), 0);
  const totalBytes = data.tableCounts.reduce((s, t) => s + t.size, 0);
  const ecsHealthy = data.ecsStatus.running > 0;
  const updatedAt = new Date(data.timestamp);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Ops"
        subtitle="DynamoDB · SQS · Lambda · ingestion — refreshes every 30s"
        right={
          <span className="num text-2xs text-muted2">
            Updated {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Records" value={formatNum(totalRecords)} />
        <StatTile label="Storage" value={formatBytes(totalBytes)} />
        <StatTile
          label="Fear & Greed"
          value={fg ? fg.value : "—"}
          sub={fg?.classification}
          tone={fearGreedTone(fg?.value)}
        />
        <StatTile
          label="Ingestion"
          value={`${data.ecsStatus.running}/${data.ecsStatus.desired}`}
          sub={data.ecsStatus.status}
          tone={ecsHealthy ? "up" : "down"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card padding="none">
          <div className="px-4 pt-4">
            <CardHeader title="DynamoDB tables" />
          </div>
          <DataTable
            dense
            rowKey={(r) => r.name}
            rows={data.tableCounts}
            columns={[
              {
                key: "name",
                header: "Table",
                render: (r) => <span className="font-medium text-ink">{r.name}</span>,
              },
              {
                key: "count",
                header: "Count",
                align: "right",
                render: (r) => <MonoNum>{r.count < 0 ? "—" : formatNum(r.count)}</MonoNum>,
              },
              {
                key: "size",
                header: "Size",
                align: "right",
                render: (r) => <MonoNum>{formatBytes(r.size)}</MonoNum>,
              },
            ]}
          />
        </Card>

        <Card padding="none">
          <div className="px-4 pt-4">
            <CardHeader title="SQS queues" />
          </div>
          <DataTable
            dense
            rowKey={(r) => r.name}
            rows={data.queueDepths}
            columns={[
              {
                key: "name",
                header: "Queue",
                render: (q) => (
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-ink truncate">{q.name}</span>
                    {q.dlq && (
                      <Badge tone="warn" size="sm">
                        DLQ
                      </Badge>
                    )}
                  </span>
                ),
              },
              {
                key: "messages",
                header: "Messages",
                align: "right",
                render: (q) => <MonoNum>{q.messages < 0 ? "—" : formatNum(q.messages)}</MonoNum>,
              },
              {
                key: "inflight",
                header: "In-flight",
                align: "right",
                render: (q) => <MonoNum>{formatNum(q.inflight)}</MonoNum>,
              },
            ]}
          />
        </Card>

        <Card padding="none">
          <div className="px-4 pt-4">
            <CardHeader title="Lambda functions" />
          </div>
          <DataTable
            dense
            rowKey={(r) => r.name}
            rows={data.lambdaStatuses}
            columns={[
              {
                key: "name",
                header: "Function",
                render: (l) => <span className="font-medium text-ink truncate">{l.name}</span>,
              },
              {
                key: "state",
                header: "State",
                render: (l) => (
                  <Badge tone={lambdaTone(l.state)} size="sm">
                    {l.state}
                  </Badge>
                ),
              },
              {
                key: "size",
                header: "Size",
                align: "right",
                render: (l) => <MonoNum>{formatBytes(l.size)}</MonoNum>,
              },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Recent ingestion logs" />
          <pre className="num text-2xs text-muted whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto rail-scroll">
            {data.recentLogs.join("\n")}
          </pre>
        </Card>
      </div>
    </div>
  );
}

function fearGreedTone(v?: number): "up" | "down" | "warn" | "default" {
  if (v === undefined) return "default";
  if (v <= 25) return "down";
  if (v <= 45) return "warn";
  if (v <= 55) return "warn";
  return "up";
}

function lambdaTone(state: string): "up" | "down" | "neutral" {
  const s = state.toLowerCase();
  if (s === "active") return "up";
  if (s === "failed" || s === "inactive") return "down";
  return "neutral";
}
