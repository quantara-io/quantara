import { useEffect, useState } from "react";

import type { BlendedSignal, RiskRecommendation, TimeframeVote } from "@quantara/shared";

import { apiFetch } from "../lib/api";

interface SignalsData {
  signals: BlendedSignal[];
  disclaimer: string;
}

const BLENDER_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
type BlenderTF = (typeof BLENDER_TIMEFRAMES)[number];

export function Genie() {
  const [data, setData] = useState<SignalsData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await apiFetch<SignalsData>("/api/genie/signals");
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
        setError("");
      } else {
        setError(res.error?.message ?? "Failed to load signals");
      }
    }
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error)
    return (
      <div className="p-3 rounded bg-red-950/40 text-red-300 border border-red-900 text-sm">
        {error}
      </div>
    );
  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  return (
    <div className="space-y-4">
      {data.signals.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-center text-sm text-slate-400">
          No signals available yet — pipeline may be warming up.
        </div>
      ) : (
        data.signals.map((signal) => <SignalCard key={signal.pair} signal={signal} />)
      )}
      {data.disclaimer && (
        <p className="text-[11px] text-slate-600 text-center">{data.disclaimer}</p>
      )}
    </div>
  );
}

function SignalCard({ signal }: { signal: BlendedSignal }) {
  const hasReasoning =
    signal.invalidationReason != null ||
    (signal.rulesFired && signal.rulesFired.length > 0);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-3">
      {/* Invalidation banner */}
      {signal.invalidatedAt != null && (
        <div className="rounded bg-yellow-950/60 border border-yellow-800 px-3 py-2 text-xs text-yellow-300 flex items-center gap-2">
          <span className="font-medium">Refreshing</span>
          {signal.invalidationReason && (
            <span className="text-yellow-400/80">{signal.invalidationReason}</span>
          )}
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-slate-100">{signal.pair}</h2>
        <TypeBadge type={signal.type} />
        <span className="text-sm text-slate-300 font-mono">
          {Math.round(signal.confidence * 100)}%
        </span>
        {signal.volatilityFlag && <VolatilityChip />}
        {signal.gateReason != null && <GateChip reason={signal.gateReason} />}
      </div>

      {/* Timestamps */}
      <div className="flex gap-4 text-[11px] text-slate-500">
        <span>
          <span className="text-slate-600">asOf </span>
          {new Date(signal.asOf).toLocaleString()}
        </span>
        <span>
          <span className="text-slate-600">emitting </span>
          {signal.emittingTimeframe}
        </span>
      </div>

      {/* Reasoning */}
      <div className="text-sm text-slate-300">
        {signal.invalidationReason != null ? (
          <p className="italic text-yellow-300/80">{signal.invalidationReason}</p>
        ) : signal.rulesFired.length > 0 ? (
          <ul className="list-disc list-inside space-y-0.5 text-slate-400 text-xs">
            {signal.rulesFired.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        ) : (
          <span className="text-slate-600 text-xs italic">No rules attributed</span>
        )}
      </div>

      {/* Per-timeframe breakdown */}
      <PerTimeframeTable perTimeframe={signal.perTimeframe} weightsUsed={signal.weightsUsed} />

      {/* Risk recommendation */}
      {signal.risk != null && signal.type !== "hold" && (
        <RiskBlock risk={signal.risk} />
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: "buy" | "sell" | "hold" }) {
  const classes =
    type === "buy"
      ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
      : type === "sell"
        ? "bg-red-950 text-red-300 border border-red-800"
        : "bg-slate-800 text-slate-400 border border-slate-700";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${classes}`}>
      {type}
    </span>
  );
}

function VolatilityChip() {
  return (
    <span className="px-1.5 py-0.5 rounded bg-yellow-950 text-yellow-400 border border-yellow-800 text-[11px]">
      high vol
    </span>
  );
}

function GateChip({ reason }: { reason: "vol" | "dispersion" | "stale" }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-orange-950 text-orange-400 border border-orange-800 text-[11px]">
      gate: {reason}
    </span>
  );
}

function PerTimeframeTable({
  perTimeframe,
  weightsUsed,
}: {
  perTimeframe: BlendedSignal["perTimeframe"];
  weightsUsed: BlendedSignal["weightsUsed"];
}) {
  return (
    <div>
      <p className="text-[11px] text-slate-600 uppercase tracking-widest mb-1">Timeframe breakdown</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500">
            {["TF", "Vote", "Confidence", "Weight"].map((h) => (
              <th key={h} className="text-left font-medium pb-1">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BLENDER_TIMEFRAMES.map((tf) => {
            const vote: TimeframeVote | null | undefined =
              perTimeframe[tf as BlenderTF];
            const weight: number | undefined = weightsUsed[tf as BlenderTF];
            return (
              <tr key={tf} className="border-t border-slate-800/60">
                <td className="py-1 text-slate-400 font-mono">{tf}</td>
                <td className="py-1">
                  {vote != null ? (
                    <TypeBadge type={vote.type} />
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
                <td className="py-1 text-slate-300 font-mono">
                  {vote != null ? `${Math.round(vote.confidence * 100)}%` : "—"}
                </td>
                <td className="py-1 text-slate-500 font-mono">
                  {weight != null ? weight.toFixed(2) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RiskBlock({ risk }: { risk: RiskRecommendation }) {
  return (
    <div className="rounded border border-slate-700 bg-slate-950/60 p-3 space-y-2">
      <p className="text-[11px] text-slate-600 uppercase tracking-widest">Risk recommendation</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-slate-500">Position size</span>
        <span className="text-slate-300 font-mono">
          {(risk.positionSizePct * 100).toFixed(1)}%
          <span className="text-slate-600 ml-1">({risk.positionSizeModel})</span>
        </span>
        <span className="text-slate-500">Stop loss</span>
        <span className="text-slate-300 font-mono">{formatPrice(risk.stopLoss)}</span>
        <span className="text-slate-500">Invalidation</span>
        <span className="text-slate-300">{risk.invalidationCondition}</span>
      </div>
      {risk.takeProfit.length > 0 && (
        <div>
          <p className="text-[11px] text-slate-600 mb-1">Take-profit ladder</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                {["Level", "Price", "Close %", "R-multiple"].map((h) => (
                  <th key={h} className="text-left font-medium pb-0.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {risk.takeProfit.map((tp, i) => (
                <tr key={i} className="border-t border-slate-800/60">
                  <td className="py-0.5 text-slate-500">TP{i + 1}</td>
                  <td className="py-0.5 text-emerald-400 font-mono">{formatPrice(tp.price)}</td>
                  <td className="py-0.5 text-slate-300 font-mono">
                    {(tp.closePct * 100).toFixed(0)}%
                  </td>
                  <td className="py-0.5 text-slate-300 font-mono">{tp.rMultiple.toFixed(1)}R</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}
