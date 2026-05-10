import { useEffect, useMemo, useState } from "react";
import type { BlendedSignal } from "@quantara/shared";

import { apiFetch } from "../../lib/api";
import { Badge } from "../ui/Badge";
import { formatPrice } from "../ui/MonoNum";
import { SectionHeader } from "../ui/Section";

type Filter = "all" | "buy" | "sell" | "divergence";

interface SignalsResp {
  signals: BlendedSignal[];
}

const POLL_MS = 30_000;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
  { id: "divergence", label: "Divergence" },
];

export function SignalsRail({ activePair }: { activePair: string }) {
  const [signals, setSignals] = useState<BlendedSignal[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await apiFetch<SignalsResp>("/api/genie/signals");
      if (cancelled) return;
      if (res.success && res.data) setSignals(res.data.signals ?? []);
      setLoading(false);
    }
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const filtered = useMemo(() => {
    const forPair = signals.filter((s) => s.pair === activePair);
    const list = forPair.length > 0 ? forPair : signals.slice(0, 8);
    if (filter === "all") return list;
    if (filter === "buy") return list.filter((s) => s.type === "buy");
    if (filter === "sell") return list.filter((s) => s.type === "sell");
    if (filter === "divergence")
      return list.filter((s) => s.rulesFired.some((r) => /div/i.test(r)));
    return list;
  }, [signals, filter, activePair]);

  return (
    <div className="flex flex-col h-full">
      <SectionHeader
        title={
          <span>
            Signals ·{" "}
            <span className="text-ink2 font-semibold normal-case tracking-normal">
              {symbolOf(activePair)}
            </span>
          </span>
        }
        right={<span className="num text-2xs text-muted2">{filtered.length}</span>}
      />
      <div className="flex gap-1 px-3 py-2 border-b border-line">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`text-2xs uppercase tracking-widest px-2 py-1 rounded focus-ring transition-colors ${
              filter === f.id ? "bg-sunken text-ink font-semibold" : "text-muted hover:text-ink2"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto rail-scroll">
        {loading ? (
          <div className="px-4 py-6 text-sm text-muted2">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted2">No signals.</div>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map((s) => (
              <SignalRow key={`${s.pair}-${s.asOf}`} signal={s} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SignalRow({ signal }: { signal: BlendedSignal }) {
  const tone = signal.type === "buy" ? "up" : signal.type === "sell" ? "down" : "warn";
  const strengthLabel = strengthFor(signal);
  const summary = primaryRuleSummary(signal.rulesFired);
  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={tone} size="sm">
          {strengthLabel}
        </Badge>
        <span className="num text-2xs text-muted2">
          {new Date(signal.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <div className="text-sm text-ink2 mt-1.5 line-clamp-2">{summary}</div>
      <div className="flex items-center justify-between gap-2 mt-1.5 text-2xs">
        <span className="text-muted2 uppercase tracking-widest">{signal.emittingTimeframe}</span>
        <span className="num text-muted">conf {(signal.confidence * 100).toFixed(0)}%</span>
      </div>
    </li>
  );
}

function symbolOf(pair: string): string {
  return pair.split("/")[0] ?? pair;
}

function strengthFor(s: BlendedSignal): string {
  const c = s.confidence;
  if (s.type === "buy") return c >= 0.7 ? "Strong Buy" : c >= 0.45 ? "Buy" : "Bull div";
  if (s.type === "sell") return c >= 0.7 ? "Strong Sell" : c >= 0.45 ? "Sell" : "Bear div";
  return s.gateReason === "vol" ? "Range" : "Hold";
}

function primaryRuleSummary(rules: string[]): string {
  if (!rules || rules.length === 0) return "—";
  const head = rules.slice(0, 3).map(prettifyRule).join(" + ");
  return head;
}

function prettifyRule(r: string): string {
  return r
    .replace(/_/g, " ")
    .replace(/\b(ema|macd|rsi|sma|bb|atr|vwap)\b/gi, (m) => m.toUpperCase());
}

// Re-export for the chart's marker logic.
export { formatPrice };
