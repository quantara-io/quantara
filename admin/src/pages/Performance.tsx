import { useEffect, useState } from "react";
import { PAIRS, GLOSSARY } from "@quantara/shared";

import { apiFetch } from "../lib/api";
import { HelpTooltip } from "../components/HelpTooltip";

// ---------------------------------------------------------------------------
// Types (mirror backend response shape)
// ---------------------------------------------------------------------------

interface CalibrationBin {
  binMin: number;
  binMax: number;
  signalCount: number;
  winRate: number;
  avgConfidence: number;
}

interface PerRuleRow {
  rule: string;
  fireCount: number;
  tpRate: number;
  avgConfidence: number;
}

interface CoOccurrenceRow {
  rules: [string, string];
  jointCount: number;
  tpRateWhenJoint: number;
}

interface VolatilityBucket {
  atrPercentile: number;
  signalCount: number;
  winRate: number;
}

interface HourBucket {
  utcHour: number;
  signalCount: number;
  winRate: number;
}

interface DeepDiveData {
  windowStart: string;
  windowEnd: string;
  calibration: CalibrationBin[];
  rules: {
    perRule: PerRuleRow[];
    coOccurrence: CoOccurrenceRow[];
  };
  regime: {
    byVolatility: VolatilityBucket[];
    byHour: HourBucket[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
type Timeframe = (typeof TIMEFRAMES)[number] | "";

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function winRateColor(rate: number): string {
  if (rate >= 0.6) return "text-up";
  if (rate >= 0.45) return "text-warn";
  return "text-down";
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-xs uppercase tracking-widest text-muted2 mb-4">{title}</h2>
      {children}
    </div>
  );
}

// -----------
// Calibration
// -----------

function CalibrationSection({ bins }: { bins: CalibrationBin[] }) {
  if (bins.length === 0) {
    return (
      <SectionCard title="Confidence Calibration">
        <p className="text-sm text-muted2 text-center py-4">
          Not enough data — each confidence bin needs at least a handful of resolved signals.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Confidence Calibration">
      <p className="text-xs text-muted2 mb-3 inline-flex items-center gap-1">
        Stated confidence (x) vs realized win rate (bar). Diagonal = perfect calibration.
        <HelpTooltip label={GLOSSARY.confidenceCalibration.label}>
          {GLOSSARY.confidenceCalibration.body}
        </HelpTooltip>
      </p>

      {/* Simple bar chart */}
      <div className="space-y-2">
        {bins.map((bin) => {
          const barWidth = `${(bin.winRate * 100).toFixed(1)}%`;
          const idealWidth = `${(((bin.binMin + bin.binMax) / 2) * 100).toFixed(1)}%`;
          return (
            <div key={`${bin.binMin}-${bin.binMax}`} className="flex items-center gap-3 text-xs">
              <span className="text-muted2 w-14 text-right font-mono shrink-0">
                {pct(bin.binMin)}
              </span>
              <div className="relative flex-1 h-5 bg-sunken rounded overflow-hidden">
                {/* Ideal diagonal reference */}
                <div
                  className="absolute top-0 left-0 h-full bg-line/40 rounded"
                  style={{ width: idealWidth }}
                />
                {/* Actual win rate bar */}
                <div
                  className={`absolute top-0 left-0 h-full rounded ${bin.winRate >= (bin.binMin + bin.binMax) / 2 ? "bg-up" : "bg-down-soft"}`}
                  style={{ width: barWidth }}
                />
              </div>
              <span className={`w-12 font-mono text-right ${winRateColor(bin.winRate)}`}>
                {pct(bin.winRate)}
              </span>
              <span className="text-muted2 w-14 text-right font-mono shrink-0">
                n={bin.signalCount}
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 text-[11px] text-muted2">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2 bg-line/60 rounded" /> Ideal
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2 bg-up rounded" /> Actual (above ideal)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2 bg-down-soft rounded" /> Actual (below ideal)
        </span>
      </div>

      {/* Scatter-style table for precision */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted2">
              <th className="text-left font-medium pb-2">Bin</th>
              <th className="text-left font-medium pb-2">Avg Conf</th>
              <th className="text-left font-medium pb-2">
                <span className="inline-flex items-center gap-1">
                  Win Rate
                  <HelpTooltip label={GLOSSARY.winRate.label}>{GLOSSARY.winRate.body}</HelpTooltip>
                </span>
              </th>
              <th className="text-left font-medium pb-2">Signals</th>
            </tr>
          </thead>
          <tbody>
            {bins.map((bin) => (
              <tr key={`row-${bin.binMin}`} className="border-t border-line">
                <td className="py-1.5 text-muted font-mono">
                  {pct(bin.binMin)}&ndash;{pct(bin.binMax)}
                </td>
                <td className="py-1.5 text-ink2 font-mono">{pct(bin.avgConfidence)}</td>
                <td className={`py-1.5 font-mono ${winRateColor(bin.winRate)}`}>
                  {pct(bin.winRate)}
                </td>
                <td className="py-1.5 text-muted2">{bin.signalCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// -----
// Rules
// -----

type RuleSortKey = "fireCount" | "tpRate" | "avgConfidence";

function RulesSection({
  perRule,
  coOccurrence,
}: {
  perRule: PerRuleRow[];
  coOccurrence: CoOccurrenceRow[];
}) {
  const [sortKey, setSortKey] = useState<RuleSortKey>("fireCount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: RuleSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sorted = [...perRule].sort((a, b) => {
    const diff = a[sortKey] - b[sortKey];
    return sortDir === "desc" ? -diff : diff;
  });

  const SortHeader = ({
    k,
    label,
    tooltip,
  }: {
    k: RuleSortKey;
    label: string;
    tooltip?: React.ReactNode;
  }) => (
    <th
      className="text-left font-medium pb-2 cursor-pointer select-none hover:text-ink2"
      onClick={() => toggleSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {tooltip}
        {sortKey === k ? (sortDir === "desc" ? " v" : " ^") : ""}
      </span>
    </th>
  );

  return (
    <SectionCard title="Rule Attribution">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Per-rule table */}
        <div>
          <p className="text-[11px] text-muted2 mb-2">Click a column header to sort.</p>
          {perRule.length === 0 ? (
            <p className="text-sm text-muted2 py-2">No rule data available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted2">
                    <th className="text-left font-medium pb-2">Rule</th>
                    <SortHeader k="fireCount" label="Fires" />
                    <SortHeader
                      k="tpRate"
                      label="TP Rate"
                      tooltip={
                        <HelpTooltip label={GLOSSARY.tpRate.label}>
                          {GLOSSARY.tpRate.body}
                        </HelpTooltip>
                      }
                    />
                    <SortHeader k="avgConfidence" label="Avg Conf" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => (
                    <tr key={row.rule} className="border-t border-line">
                      <td className="py-1.5 text-ink2 font-mono text-[11px]">{row.rule}</td>
                      <td className="py-1.5 text-muted">{row.fireCount}</td>
                      <td className={`py-1.5 font-mono ${winRateColor(row.tpRate)}`}>
                        {pct(row.tpRate)}
                      </td>
                      <td className="py-1.5 text-muted font-mono">{pct(row.avgConfidence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Co-occurrence table */}
        <div>
          <p className="text-[11px] text-muted2 mb-2 inline-flex items-center gap-1">
            Pairwise rule co-occurrence (rules that fire together on the same signal).
            <HelpTooltip label={GLOSSARY.coOccurrence.label}>
              {GLOSSARY.coOccurrence.body}
            </HelpTooltip>
          </p>
          {coOccurrence.length === 0 ? (
            <p className="text-sm text-muted2 py-2">No co-occurrence data available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted2">
                    <th className="text-left font-medium pb-2 w-1/2">Rule Pair</th>
                    <th className="text-left font-medium pb-2">Joint Count</th>
                    <th className="text-left font-medium pb-2">
                      <span className="inline-flex items-center gap-1">
                        TP Rate
                        <HelpTooltip label={GLOSSARY.tpRate.label}>
                          {GLOSSARY.tpRate.body}
                        </HelpTooltip>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {coOccurrence.slice(0, 20).map((row) => (
                    <tr key={row.rules.join("|")} className="border-t border-line">
                      <td className="py-1.5 text-muted font-mono text-[11px]">
                        {row.rules[0]}
                        <br />
                        {row.rules[1]}
                      </td>
                      <td className="py-1.5 text-muted">{row.jointCount}</td>
                      <td className={`py-1.5 font-mono ${winRateColor(row.tpRateWhenJoint)}`}>
                        {pct(row.tpRateWhenJoint)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ------
// Regime
// ------

const QUARTILE_LABELS: Record<number, string> = {
  0: "Q1 (0-25th)",
  25: "Q2 (25-50th)",
  50: "Q3 (50-75th)",
  75: "Q4 (75-100th)",
};

function RegimeSection({
  byVolatility,
  byHour,
}: {
  byVolatility: VolatilityBucket[];
  byHour: HourBucket[];
}) {
  const maxVol = Math.max(...byVolatility.map((b) => b.signalCount), 1);
  const maxHour = Math.max(...byHour.map((b) => b.signalCount), 1);

  return (
    <SectionCard title="Market Regime">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* ATR Quartile bars */}
        <div>
          <p className="text-[11px] text-muted2 mb-3 inline-flex items-center gap-1">
            Win rate by ATR volatility quartile.
            <HelpTooltip label={GLOSSARY.volatilityQuartile.label}>
              {GLOSSARY.volatilityQuartile.body}
            </HelpTooltip>
          </p>
          {byVolatility.length === 0 ? (
            <p className="text-sm text-muted2 py-2">No ATR data available.</p>
          ) : (
            <div className="space-y-2">
              {byVolatility.map((b) => (
                <div key={b.atrPercentile} className="flex items-center gap-3 text-xs">
                  <span className="text-muted2 w-24 shrink-0 text-right">
                    {QUARTILE_LABELS[b.atrPercentile] ?? `Q(${b.atrPercentile}+)`}
                  </span>
                  <div className="relative flex-1 h-5 bg-sunken rounded overflow-hidden">
                    <div
                      className="h-full bg-brand-soft rounded"
                      style={{ width: `${(b.signalCount / maxVol) * 100}%` }}
                    />
                  </div>
                  <span className={`w-14 font-mono text-right ${winRateColor(b.winRate)}`}>
                    {pct(b.winRate)}
                  </span>
                  <span className="text-muted2 w-10 text-right font-mono shrink-0">
                    n={b.signalCount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 24-hour heat strip */}
        <div>
          <p className="text-[11px] text-muted2 mb-3 inline-flex items-center gap-1">
            Win rate by UTC hour of signal close time.
            <HelpTooltip label={GLOSSARY.hourBucket.label}>{GLOSSARY.hourBucket.body}</HelpTooltip>
          </p>
          {byHour.length === 0 ? (
            <p className="text-sm text-muted2 py-2">No hourly data available.</p>
          ) : (
            <>
              {/* Heat strip — 24 columns */}
              <div className="flex gap-px mb-1">
                {Array.from({ length: 24 }, (_, h) => {
                  const bucket = byHour.find((b) => b.utcHour === h);
                  const intensity = bucket ? bucket.winRate : null;
                  const bg =
                    intensity === null
                      ? "bg-sunken"
                      : intensity >= 0.65
                        ? "bg-up"
                        : intensity >= 0.5
                          ? "bg-up-soft"
                          : intensity >= 0.35
                            ? "bg-warn/60"
                            : "bg-down-soft";
                  return (
                    <div
                      key={h}
                      className={`flex-1 h-8 rounded-sm ${bg} relative group cursor-default`}
                      title={
                        bucket
                          ? `${String(h).padStart(2, "0")}:00 UTC — WR ${pct(bucket.winRate)} (n=${bucket.signalCount})`
                          : `${String(h).padStart(2, "0")}:00 UTC — no data`
                      }
                    />
                  );
                })}
              </div>
              {/* Hour labels */}
              <div className="flex gap-px text-[9px] text-muted2 mb-3">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="flex-1 text-center">
                    {h % 6 === 0 ? h : ""}
                  </div>
                ))}
              </div>

              {/* Compact table */}
              <div className="overflow-x-auto max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted2">
                      <th className="text-left font-medium pb-2">UTC Hour</th>
                      <th className="text-left font-medium pb-2">Signals</th>
                      <th className="text-left font-medium pb-2">Win Rate</th>
                      <th className="text-left font-medium pb-2">Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byHour
                      .slice()
                      .sort((a, b) => b.winRate - a.winRate)
                      .map((b) => (
                        <tr key={b.utcHour} className="border-t border-line">
                          <td className="py-1 text-muted font-mono">
                            {String(b.utcHour).padStart(2, "0")}:00
                          </td>
                          <td className="py-1 text-muted">{b.signalCount}</td>
                          <td className={`py-1 font-mono ${winRateColor(b.winRate)}`}>
                            {pct(b.winRate)}
                          </td>
                          <td className="py-1">
                            <div
                              className="h-1.5 bg-brand-soft rounded"
                              style={{ width: `${(b.signalCount / maxHour) * 80}px` }}
                            />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function Performance() {
  const [data, setData] = useState<DeepDiveData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Filters
  const [since, setSince] = useState("30d");
  const [pair, setPair] = useState<string>("");
  const [timeframe, setTimeframe] = useState<Timeframe>("");

  function buildQuery() {
    const params = new URLSearchParams();
    if (since === "7d") {
      params.set("since", new Date(Date.now() - 7 * 86400_000).toISOString());
    } else if (since === "30d") {
      params.set("since", new Date(Date.now() - 30 * 86400_000).toISOString());
    } else if (since === "90d") {
      params.set("since", new Date(Date.now() - 90 * 86400_000).toISOString());
    }
    if (pair) params.set("pair", pair);
    if (timeframe) params.set("timeframe", timeframe);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    (async () => {
      const res = await apiFetch<DeepDiveData>(`/api/admin/genie-deepdive${buildQuery()}`);
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
        setError("");
      } else {
        setError(res.error?.message ?? "Failed to load deep-dive data");
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [since, pair, timeframe]);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-muted2 uppercase tracking-wider">Window</label>
        <select
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="bg-sunken border border-line text-ink2 text-xs rounded px-2 py-1"
        >
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
        </select>

        <label className="text-xs text-muted2 uppercase tracking-wider ml-2">Pair</label>
        <select
          value={pair}
          onChange={(e) => setPair(e.target.value)}
          className="bg-sunken border border-line text-ink2 text-xs rounded px-2 py-1"
        >
          <option value="">All pairs</option>
          {PAIRS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <label className="text-xs text-muted2 uppercase tracking-wider ml-2">Timeframe</label>
        <select
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value as Timeframe)}
          className="bg-sunken border border-line text-ink2 text-xs rounded px-2 py-1"
        >
          <option value="">All timeframes</option>
          {TIMEFRAMES.map((tf) => (
            <option key={tf} value={tf}>
              {tf}
            </option>
          ))}
        </select>

        {loading && <span className="text-xs text-muted2 ml-2">Loading…</span>}
      </div>

      {/* Error state */}
      {error && (
        <div className="p-4 rounded bg-down-soft text-down-strong border border-down/30 text-sm">
          {error}
        </div>
      )}

      {/* Content */}
      {data && (
        <>
          <div className="text-xs text-muted2">
            Window {new Date(data.windowStart).toLocaleDateString()} &ndash;{" "}
            {new Date(data.windowEnd).toLocaleDateString()}
          </div>
          <CalibrationSection bins={data.calibration} />
          <RulesSection perRule={data.rules.perRule} coOccurrence={data.rules.coOccurrence} />
          <RegimeSection byVolatility={data.regime.byVolatility} byHour={data.regime.byHour} />
        </>
      )}

      {!loading && !data && !error && (
        <div className="text-sm text-muted2 text-center py-8">No data available.</div>
      )}
    </div>
  );
}
