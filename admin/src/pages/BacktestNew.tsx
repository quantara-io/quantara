import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiFetch } from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StrategyMeta {
  name: string;
  description: string;
}

interface SubmitResult {
  runId: string;
  estimateUsd: number;
}

const PAIRS = [
  "BTC/USDT",
  "ETH/USDT",
  "SOL/USDT",
  "BNB/USDT",
  "XRP/USDT",
  "ADA/USDT",
  "DOGE/USDT",
  "AVAX/USDT",
  "DOT/USDT",
  "LINK/USDT",
] as const;

const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;

const RATIFICATION_MODES = [
  { value: "none", label: "None (skip LLM)" },
  { value: "skip-bedrock", label: "Skip Bedrock (algo only)" },
  { value: "replay-bedrock", label: "Replay Bedrock (live ratification)" },
] as const;

const MODELS = [
  { value: "haiku", label: "Claude Haiku 4.5 (cheap)" },
  { value: "sonnet", label: "Claude Sonnet 4.6 (accurate)" },
] as const;

// Cost cap — disable submit if estimate exceeds this.
const COST_CAP_USD = 1.0;

// ---------------------------------------------------------------------------
// Inline cost estimate (mirrors backend calculation)
// ---------------------------------------------------------------------------

function estimateCost(ratificationMode: string, from: string, to: string, model: string): number {
  if (ratificationMode !== "replay-bedrock" || !from || !to) return 0;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (isNaN(fromMs) || isNaN(toMs) || fromMs >= toMs) return 0;
  const periodMs = toMs - fromMs;
  const bars = Math.floor(periodMs / 900_000); // 15m bars
  const gatedRate = 0.004;
  const estimatedCalls = Math.ceil(bars * gatedRate);
  const inputCostPerM = model === "sonnet" ? 3.0 : 0.25;
  const outputCostPerM = model === "sonnet" ? 15.0 : 1.25;
  return (
    (estimatedCalls * 700 * inputCostPerM) / 1_000_000 +
    (estimatedCalls * 150 * outputCostPerM) / 1_000_000
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BacktestNew() {
  const navigate = useNavigate();

  const [strategies, setStrategies] = useState<StrategyMeta[]>([]);
  const [loadingStrategies, setLoadingStrategies] = useState(true);

  const [strategy, setStrategy] = useState("");
  const [baseline, setBaseline] = useState("");
  const [pair, setPair] = useState("BTC/USDT");
  const [timeframe, setTimeframe] = useState("1d");
  const [from, setFrom] = useState(() => {
    // Default: 6 months ago
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [ratificationMode, setRatificationMode] = useState("none");
  const [model, setModel] = useState("haiku");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load strategies
  useEffect(() => {
    apiFetch<{ strategies: StrategyMeta[] }>("/api/admin/backtest/strategies")
      .then((res) => {
        if (res.success && res.data) {
          setStrategies(res.data.strategies);
          if (res.data.strategies.length > 0 && !strategy) {
            setStrategy(res.data.strategies[0].name);
          }
        }
      })
      .catch(() => {
        /* ignore — will show empty dropdown */
      })
      .finally(() => setLoadingStrategies(false));
  }, []);

  const estimatedCost = estimateCost(ratificationMode, from, to, model);
  const overCap = estimatedCost > COST_CAP_USD;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!strategy) return;
    setSubmitting(true);
    setSubmitError(null);

    const body: Record<string, unknown> = {
      strategy,
      pair,
      timeframe,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      ratificationMode,
      model,
    };
    if (baseline) body.baseline = baseline;
    if (overCap) body.confirmCostUsd = estimatedCost;

    const res = await apiFetch<SubmitResult>("/api/admin/backtest", {
      method: "POST",
      body,
    });
    setSubmitting(false);

    if (!res.success || !res.data) {
      setSubmitError(res.error?.message ?? "Submission failed");
      return;
    }

    navigate(`/backtest/${res.data.runId}`);
  }

  return (
    <div className="max-w-xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-base font-semibold text-ink">New Backtest</h1>
        <p className="text-xs text-muted2 mt-0.5">Configure and submit a strategy backtest run</p>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
        {/* Strategy */}
        <Field label="Strategy" htmlFor="strategy">
          {loadingStrategies ? (
            <p className="text-xs text-muted2 animate-pulse">Loading strategies…</p>
          ) : (
            <select
              id="strategy"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              required
              className="input-base w-full"
            >
              <option value="" disabled>
                Select a strategy…
              </option>
              {strategies.map((s) => (
                <option key={s.name} value={s.name} title={s.description}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {strategy && strategies.find((s) => s.name === strategy) && (
            <p className="text-[10px] text-muted2 mt-1">
              {strategies.find((s) => s.name === strategy)?.description}
            </p>
          )}
        </Field>

        {/* Baseline */}
        <Field label="Baseline (optional)" htmlFor="baseline">
          <select
            id="baseline"
            value={baseline}
            onChange={(e) => setBaseline(e.target.value)}
            className="input-base w-full"
          >
            <option value="">None</option>
            {strategies.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        {/* Pair */}
        <Field label="Pair" htmlFor="pair">
          <select
            id="pair"
            value={pair}
            onChange={(e) => setPair(e.target.value)}
            className="input-base w-full"
          >
            {PAIRS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        {/* Timeframe */}
        <Field label="Timeframe" htmlFor="timeframe">
          <div className="flex gap-2 flex-wrap">
            {TIMEFRAMES.map((tf) => (
              <label key={tf} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="timeframe"
                  value={tf}
                  checked={timeframe === tf}
                  onChange={() => setTimeframe(tf)}
                  className="accent-brand"
                />
                <span className="text-xs text-ink2">{tf}</span>
              </label>
            ))}
          </div>
        </Field>

        {/* Date range */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" htmlFor="from">
            <input
              id="from"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              required
              className="input-base w-full"
            />
          </Field>
          <Field label="To" htmlFor="to">
            <input
              id="to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              required
              className="input-base w-full"
            />
          </Field>
        </div>

        {/* Ratification mode */}
        <Field label="Ratification mode" htmlFor="ratificationMode">
          <select
            id="ratificationMode"
            value={ratificationMode}
            onChange={(e) => setRatificationMode(e.target.value)}
            className="input-base w-full"
          >
            {RATIFICATION_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Model (only shown for replay-bedrock) */}
        {ratificationMode === "replay-bedrock" && (
          <Field label="Model" htmlFor="model">
            <select
              id="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input-base w-full"
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        {/* Cost estimate */}
        {ratificationMode === "replay-bedrock" && (
          <div
            className={`rounded-md border px-3 py-2.5 text-xs ${
              overCap
                ? "border-down/40 bg-down-soft/40 text-down"
                : "border-line bg-sunken/50 text-muted2"
            }`}
          >
            <span className="font-medium">Estimated cost:</span>{" "}
            <span className="font-mono">${estimatedCost.toFixed(4)}</span>
            {overCap && (
              <span className="ml-2">
                — exceeds ${COST_CAP_USD.toFixed(2)} cap. Reduce date range or use Haiku model.
              </span>
            )}
          </div>
        )}

        {/* Error */}
        {submitError && (
          <div className="rounded-md border border-down/40 bg-down-soft/40 px-3 py-2 text-xs text-down">
            {submitError}
          </div>
        )}

        {/* Submit */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !strategy || overCap}
            className="px-4 py-2 rounded-md bg-brand text-ink text-xs font-medium hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed focus-ring transition-colors"
          >
            {submitting ? "Submitting…" : "Submit backtest"}
          </button>
          <button
            type="button"
            onClick={() => navigate("/backtest")}
            className="text-xs text-muted2 hover:text-ink transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field wrapper
// ---------------------------------------------------------------------------

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium text-muted2 uppercase tracking-wide"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
