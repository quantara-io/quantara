import { useEffect, useRef, useState } from "react";
import { PAIRS } from "@quantara/shared";

import { apiFetch } from "../lib/api";
import { HelpTooltip } from "../components/HelpTooltip";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface EquityCurvePoint {
  ts: string;
  cumulativeUsd: number;
}

interface DrawdownResult {
  maxUsd: number;
  maxPct: number;
  durationDays: number;
}

interface PerSliceStats {
  trades: number;
  pnlUsd: number;
  winRate: number | null;
}

interface PnlResult {
  windowStart: string;
  windowEnd: string;
  trades: { count: number; wins: number; losses: number; neutral: number };
  pnl: { totalUsd: number; avgPerTradeUsd: number; bestUsd: number; worstUsd: number };
  equityCurve: EquityCurvePoint[];
  drawdown: DrawdownResult;
  perPair: Record<string, PerSliceStats>;
  perTimeframe: Record<string, PerSliceStats>;
}

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

type DirectionFilter = "both" | "long" | "short";

const TIMEFRAMES = ["15m", "1h", "4h", "1d"];
const WINDOWS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function Pnl() {
  const [data, setData] = useState<PnlResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Filters
  const [windowDays, setWindowDays] = useState(30);
  const [pair, setPair] = useState("all");
  const [timeframe, setTimeframe] = useState("all");
  const [positionSize, setPositionSize] = useState(100);
  const [feeBps, setFeeBps] = useState(5);
  const [direction, setDirection] = useState<DirectionFilter>("both");

  // Sort state for per-pair / per-timeframe tables
  const [pairSort, setPairSort] = useState<"pnl" | "winRate" | "trades">("pnl");
  const [tfSort, setTfSort] = useState<"pnl" | "winRate" | "trades">("pnl");

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError("");

    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const qs = new URLSearchParams({
      since,
      positionSize: String(positionSize),
      feeBps: String(feeBps),
      direction,
    });
    if (pair !== "all") qs.set("pair", pair);
    if (timeframe !== "all") qs.set("timeframe", timeframe);

    void apiFetch<PnlResult>(`/api/admin/pnl-simulation?${qs.toString()}`, {
      signal: controller.signal,
    }).then((res) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (res.success && res.data) {
        setData(res.data);
      } else if (res.error?.code !== "ABORTED") {
        setError(res.error?.message ?? "Failed to load simulation");
      }
    });

    return () => controller.abort();
  }, [windowDays, pair, timeframe, positionSize, feeBps, direction]);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 items-end">
        <FilterRow label="Window">
          {WINDOWS.map((w) => (
            <ToggleBtn
              key={w.days}
              active={windowDays === w.days}
              onClick={() => setWindowDays(w.days)}
            >
              {w.label}
            </ToggleBtn>
          ))}
        </FilterRow>

        <FilterRow label="Pair">
          <Selector
            value={pair}
            onChange={setPair}
            options={[["all", "All pairs"], ...PAIRS.map((p) => [p, p] as [string, string])]}
          />
        </FilterRow>

        <FilterRow label="Timeframe">
          <Selector
            value={timeframe}
            onChange={setTimeframe}
            options={[["all", "All TFs"], ...TIMEFRAMES.map((t) => [t, t] as [string, string])]}
          />
        </FilterRow>

        <FilterRow label="Direction">
          {(["both", "long", "short"] as DirectionFilter[]).map((d) => (
            <ToggleBtn key={d} active={direction === d} onClick={() => setDirection(d)}>
              {d}
            </ToggleBtn>
          ))}
        </FilterRow>

        <FilterRow label="Position ($)">
          <NumInput value={positionSize} min={1} onChange={setPositionSize} />
        </FilterRow>

        <FilterRow label="Fee (bps)">
          <NumInput value={feeBps} min={0} onChange={setFeeBps} />
        </FilterRow>
      </div>

      {error && (
        <div className="p-3 rounded bg-down-soft text-down-strong border border-down/30 text-sm">
          {error}
        </div>
      )}

      {loading && <div className="text-sm text-muted2">Running simulation…</div>}

      {!loading && data && (
        <>
          {/* Top row hero stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Hero
              label="Total PnL"
              value={fmt$(data.pnl.totalUsd)}
              valueClass={data.pnl.totalUsd >= 0 ? "text-up" : "text-down"}
            />
            <Hero
              label={`Trades (${data.trades.wins}W / ${data.trades.losses}L)`}
              value={String(data.trades.count)}
            />
            <Hero
              label="Max Drawdown"
              value={fmt$(data.drawdown.maxUsd)}
              sub={`${(data.drawdown.maxPct * 100).toFixed(1)}%`}
              valueClass="text-warn"
            />
            <Hero label="DD Duration" value={`${data.drawdown.durationDays.toFixed(1)}d`} />
          </div>

          {/* Secondary hero row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Hero label="Avg / Trade" value={fmt$(data.pnl.avgPerTradeUsd)} />
            <Hero label="Best Trade" value={fmt$(data.pnl.bestUsd)} valueClass="text-up" />
            <Hero label="Worst Trade" value={fmt$(data.pnl.worstUsd)} valueClass="text-down" />
            <Hero
              label="Win Rate"
              value={
                data.trades.wins + data.trades.losses > 0
                  ? `${((data.trades.wins / (data.trades.wins + data.trades.losses)) * 100).toFixed(1)}%`
                  : "—"
              }
            />
          </div>

          {/* Equity curve */}
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-xs uppercase tracking-widest text-muted2">Equity Curve</h2>
              {/* Assumption caveat tooltip */}
              <HelpTooltip label="Simulation assumptions" position="bottom">
                <ul className="space-y-1 list-disc list-inside text-muted">
                  <li>
                    Signals are executed at <span className="text-ink2">emit-bar close price</span>{" "}
                    (priceAtSignal).
                  </li>
                  <li>No slippage, no partial fills, no order-book effects.</li>
                  <li>Fixed position size per trade — no real risk sizing.</li>
                  <li>Round-trip fee is applied flat (feeBps) regardless of price impact.</li>
                  <li>Hold signals are excluded (no directional PnL).</li>
                  <li>Invalidated outcomes are excluded.</li>
                </ul>
              </HelpTooltip>
            </div>
            <EquityCurveChart curve={data.equityCurve} />
            {data.equityCurve.length < 2 && (
              <p className="text-sm text-muted2 text-center py-6">
                No resolved trades in this window — equity curve unavailable.
              </p>
            )}
          </div>

          {/* Per-pair table */}
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs uppercase tracking-widest text-muted2">By Pair</h2>
              <SortPicker value={pairSort} onChange={setPairSort} />
            </div>
            <SliceTable stats={data.perPair} sort={pairSort} />
          </div>

          {/* Per-timeframe table */}
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs uppercase tracking-widest text-muted2">By Timeframe</h2>
              <SortPicker value={tfSort} onChange={setTfSort} />
            </div>
            <SliceTable stats={data.perTimeframe} sort={tfSort} />
          </div>

          <p className="text-xs text-muted2">
            Window: {new Date(data.windowStart).toLocaleDateString()} –{" "}
            {new Date(data.windowEnd).toLocaleDateString()}
            {" · "}Position: ${positionSize} · Fee: {feeBps} bps round-trip
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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

function EquityCurveChart({ curve }: { curve: EquityCurvePoint[] }) {
  if (curve.length < 2) return null;

  const W = 800;
  const H = 160;
  const PAD = { top: 12, right: 12, bottom: 24, left: 56 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const values = curve.map((p) => p.cumulativeUsd);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(0, ...values);
  const range = maxVal - minVal || 1;

  // Map to SVG coordinates.
  const toX = (i: number) => PAD.left + (i / (curve.length - 1)) * innerW;
  const toY = (v: number) => PAD.top + innerH - ((v - minVal) / range) * innerH;

  // Build polyline points.
  const points = curve
    .map((p, i) => `${toX(i).toFixed(1)},${toY(p.cumulativeUsd).toFixed(1)}`)
    .join(" ");

  // Zero line Y position.
  const zeroY = toY(0).toFixed(1);

  // Y-axis tick values: 3 evenly spaced ticks.
  const ticks = [minVal, (minVal + maxVal) / 2, maxVal];

  // X-axis: show first and last date labels.
  const firstDate = new Date(curve[0].ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const lastDate = new Date(curve[curve.length - 1].ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  const lineColor = values[values.length - 1] >= 0 ? "#34d399" : "#f87171";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Equity curve">
      {/* Zero line */}
      <line
        x1={PAD.left}
        y1={zeroY}
        x2={W - PAD.right}
        y2={zeroY}
        stroke="#475569"
        strokeWidth="1"
        strokeDasharray="4 3"
      />

      {/* Y-axis ticks */}
      {ticks.map((v, i) => {
        const y = toY(v).toFixed(1);
        return (
          <g key={i}>
            <line x1={PAD.left - 4} y1={y} x2={PAD.left} y2={y} stroke="#475569" strokeWidth="1" />
            <text
              x={PAD.left - 6}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="10"
              fill="#64748b"
            >
              {fmt$(v)}
            </text>
          </g>
        );
      })}

      {/* Equity curve fill */}
      <polygon
        points={`${PAD.left},${zeroY} ${points} ${toX(curve.length - 1).toFixed(1)},${zeroY}`}
        fill={lineColor}
        fillOpacity="0.08"
      />

      {/* Equity curve line */}
      <polyline
        points={points}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* X-axis labels */}
      <text x={PAD.left} y={H - 4} fontSize="10" fill="#64748b">
        {firstDate}
      </text>
      <text x={W - PAD.right} y={H - 4} fontSize="10" fill="#64748b" textAnchor="end">
        {lastDate}
      </text>
    </svg>
  );
}

function SliceTable({
  stats,
  sort,
}: {
  stats: Record<string, PerSliceStats>;
  sort: "pnl" | "winRate" | "trades";
}) {
  const rows = Object.entries(stats).sort(([, a], [, b]) => {
    if (sort === "pnl") return b.pnlUsd - a.pnlUsd;
    if (sort === "winRate") return (b.winRate ?? -1) - (a.winRate ?? -1);
    return b.trades - a.trades;
  });

  if (rows.length === 0) {
    return <p className="text-xs text-muted2">No data</p>;
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted2">
          {["Name", "Trades", "PnL (USD)", "Win Rate"].map((h) => (
            <th key={h} className="text-left font-medium pb-2">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, s]) => (
          <tr key={name} className="border-t border-line">
            <td className="py-1.5 text-ink2 font-mono">{name}</td>
            <td className="py-1.5 text-muted">{s.trades}</td>
            <td
              className={`py-1.5 font-mono font-semibold ${s.pnlUsd >= 0 ? "text-up" : "text-down"}`}
            >
              {fmt$(s.pnlUsd)}
            </td>
            <td className="py-1.5 text-ink2">
              {s.winRate != null ? `${(s.winRate * 100).toFixed(1)}%` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SortPicker({
  value,
  onChange,
}: {
  value: "pnl" | "winRate" | "trades";
  onChange: (v: "pnl" | "winRate" | "trades") => void;
}) {
  return (
    <div className="flex gap-1">
      {(["pnl", "winRate", "trades"] as const).map((opt) => (
        <ToggleBtn key={opt} active={value === opt} onClick={() => onChange(opt)}>
          {opt === "pnl" ? "PnL" : opt === "winRate" ? "Win %" : "Trades"}
        </ToggleBtn>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared primitives
// ---------------------------------------------------------------------------

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-muted2">{label}</span>
      <div className="flex gap-1">{children}</div>
    </label>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
        active
          ? "bg-brand-soft text-brand border border-brand/30"
          : "bg-surface text-muted border border-line hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Selector({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md bg-paper border border-line px-2 py-1 text-xs text-ink focus:outline-none focus:border-brand"
    >
      {options.map(([val, label]) => (
        <option key={val} value={val}>
          {label}
        </option>
      ))}
    </select>
  );
}

function NumInput({
  value,
  min,
  onChange,
}: {
  value: number;
  min: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (isFinite(v) && v >= min) onChange(v);
      }}
      className="w-20 rounded-md bg-paper border border-line px-2 py-1 text-xs text-ink focus:outline-none focus:border-brand"
    />
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  const abs = Math.abs(v);
  const formatted =
    abs >= 1000 ? abs.toLocaleString(undefined, { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${v < 0 ? "-" : ""}$${formatted}`;
}
