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
  runId?: string;
  estimateUsd?: number;
  runs?: Array<{ runId: string; pair: string; timeframe: string; estimateUsd: number }>;
  totalEstimateUsd?: number;
}

interface EstimateResponse {
  estimatedCostUsd: number;
  estimatedCalls: number;
  estimatedTokens: { input: number; output: number };
  closes: number;
  gatedRate: number;
  estimatedLatencyMs: number;
  model: "haiku" | "sonnet";
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

// Cost cap — when the SUM-of-leaves estimate exceeds this, the operator must
// tick "I accept this cost" to enable submit. Mirrors the backend cap.
const COST_CAP_USD = 1.0;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BacktestNew() {
  const navigate = useNavigate();

  const [strategies, setStrategies] = useState<StrategyMeta[]>([]);
  const [loadingStrategies, setLoadingStrategies] = useState(true);

  const [strategy, setStrategy] = useState("");
  const [baseline, setBaseline] = useState("");
  // Multi-select pairs + timeframes — PR #376 finding 5.
  // Default to one entry each so the v1 single-select UX still works.
  const [selectedPairs, setSelectedPairs] = useState<string[]>(["BTC/USDT"]);
  const [selectedTfs, setSelectedTfs] = useState<string[]>(["1d"]);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [ratificationMode, setRatificationMode] = useState("none");
  const [model, setModel] = useState<"haiku" | "sonnet">("haiku");

  // Live-estimate state, populated by debounced POST /backtest/estimate calls.
  // PR #376 finding 2 — the SAME estimator the submission path uses.
  const [estimateUsd, setEstimateUsd] = useState(0);
  const [estimating, setEstimating] = useState(false);
  const [acceptCost, setAcceptCost] = useState(false); // finding 6 — bypass

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load strategies on mount.
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
        /* ignore — empty dropdown is the visible signal */
      })
      .finally(() => setLoadingStrategies(false));
  }, []);

  // Live cost estimate — sums per-leaf calls to /backtest/estimate.
  // Debounced via the dep array — recomputed on every input change.
  useEffect(() => {
    if (!from || !to || selectedPairs.length === 0 || selectedTfs.length === 0) {
      setEstimateUsd(0);
      return;
    }
    if (ratificationMode !== "replay-bedrock") {
      setEstimateUsd(0);
      return;
    }
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (isNaN(fromMs) || isNaN(toMs) || fromMs >= toMs) {
      setEstimateUsd(0);
      return;
    }

    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        setEstimating(true);
        try {
          // One call per (pair, tf) leaf — keeps the backend response simple.
          // The endpoint is dirt cheap (single DDB query) so a small fan-out
          // is fine; we cap at 10 × 4 = 40 worst case which is well under
          // browser concurrency limits.
          const results = await Promise.all(
            selectedPairs.flatMap((pair) =>
              selectedTfs.map((tf) =>
                apiFetch<EstimateResponse>("/api/admin/backtest/estimate", {
                  method: "POST",
                  body: {
                    pair,
                    timeframe: tf,
                    from: new Date(from).toISOString(),
                    to: new Date(to).toISOString(),
                    ratificationMode,
                    model,
                    ...(strategy ? { strategy } : {}),
                  },
                }),
              ),
            ),
          );
          if (cancelled) return;
          const total = results.reduce(
            (sum, r) => sum + (r.success && r.data ? r.data.estimatedCostUsd : 0),
            0,
          );
          setEstimateUsd(total);
        } catch {
          if (!cancelled) setEstimateUsd(0);
        } finally {
          if (!cancelled) setEstimating(false);
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [selectedPairs, selectedTfs, from, to, ratificationMode, model, strategy]);

  const overCap = estimateUsd > COST_CAP_USD;
  const submitDisabled =
    submitting ||
    !strategy ||
    selectedPairs.length === 0 ||
    selectedTfs.length === 0 ||
    (overCap && !acceptCost);

  const leafCount = selectedPairs.length * selectedTfs.length;

  function togglePair(p: string) {
    setSelectedPairs((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  function toggleTf(t: string) {
    setSelectedTfs((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!strategy) return;
    if (selectedPairs.length === 0 || selectedTfs.length === 0) return;

    setSubmitting(true);
    setSubmitError(null);

    const body: Record<string, unknown> = {
      strategy,
      pairs: selectedPairs,
      timeframes: selectedTfs,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      ratificationMode,
      model,
    };
    if (baseline) body.baseline = baseline;
    // PR #376 finding 6: confirmCostUsd is the over-cap bypass. The UI gates
    // it behind the "I accept this cost" checkbox the operator must tick.
    if (overCap && acceptCost) {
      body.confirmCostUsd = estimateUsd;
    }

    const res = await apiFetch<SubmitResult>("/api/admin/backtest", {
      method: "POST",
      body,
    });
    setSubmitting(false);

    if (!res.success || !res.data) {
      setSubmitError(res.error?.message ?? "Submission failed");
      return;
    }

    // Single-run path stays on the run detail; multi-leaf path returns to the
    // landing page so the operator sees the batch as a grouped list.
    if (res.data.runs && res.data.runs.length > 1) {
      navigate("/backtest");
    } else if (res.data.runId) {
      navigate(`/backtest/${res.data.runId}`);
    } else {
      navigate("/backtest");
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-base font-semibold text-ink">New Backtest</h1>
        <p className="text-xs text-muted2 mt-0.5">
          Configure and submit a strategy backtest. Multi-select pair / TF expands to one run per
          combination.
        </p>
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

        {/* Pairs (multi-select) */}
        <Field label={`Pairs (${selectedPairs.length} selected)`} htmlFor="pair">
          <div className="grid grid-cols-3 gap-1.5">
            {PAIRS.map((p) => {
              const checked = selectedPairs.includes(p);
              return (
                <label
                  key={p}
                  className={`flex items-center gap-1.5 cursor-pointer px-2 py-1 rounded border text-xs ${
                    checked
                      ? "bg-brand/10 border-brand/40 text-ink"
                      : "border-line text-muted2 hover:bg-sunken/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePair(p)}
                    className="accent-brand"
                  />
                  <span className="font-mono">{p}</span>
                </label>
              );
            })}
          </div>
        </Field>

        {/* Timeframes (multi-select) */}
        <Field label={`Timeframes (${selectedTfs.length} selected)`} htmlFor="timeframe">
          <div className="flex gap-2 flex-wrap">
            {TIMEFRAMES.map((tf) => {
              const checked = selectedTfs.includes(tf);
              return (
                <label
                  key={tf}
                  className={`flex items-center gap-1.5 cursor-pointer px-3 py-1 rounded border text-xs ${
                    checked
                      ? "bg-brand/10 border-brand/40 text-ink"
                      : "border-line text-muted2 hover:bg-sunken/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleTf(tf)}
                    className="accent-brand"
                  />
                  <span className="font-mono">{tf}</span>
                </label>
              );
            })}
          </div>
          {leafCount > 1 && (
            <p className="text-[10px] text-muted2 mt-1">
              {leafCount} run{leafCount === 1 ? "" : "s"} will be queued — one per (pair, TF).
            </p>
          )}
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
              onChange={(e) => setModel(e.target.value as "haiku" | "sonnet")}
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

        {/* Cost estimate — driven by the backend estimator (finding 2). */}
        {ratificationMode === "replay-bedrock" && (
          <div
            className={`rounded-md border px-3 py-2.5 text-xs space-y-1 ${
              overCap
                ? "border-warn/40 bg-warn-soft text-warn"
                : "border-line bg-sunken/50 text-muted2"
            }`}
          >
            <div>
              <span className="font-medium">
                Estimated cost{leafCount > 1 ? " (sum of all runs)" : ""}:
              </span>{" "}
              <span className="font-mono">${estimateUsd.toFixed(4)}</span>
              {estimating && <span className="ml-2 animate-pulse">estimating…</span>}
            </div>
            {overCap && (
              <>
                <p>
                  Exceeds the ${COST_CAP_USD.toFixed(2)} soft cap. You can still submit by
                  acknowledging the cost.
                </p>
                {/* PR #376 finding 6: confirmCostUsd bypass — operator opt-in. */}
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <input
                    type="checkbox"
                    checked={acceptCost}
                    onChange={(e) => setAcceptCost(e.target.checked)}
                    className="accent-warn"
                  />
                  <span>I accept this cost (${estimateUsd.toFixed(4)})</span>
                </label>
              </>
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
            disabled={submitDisabled}
            className="px-4 py-2 rounded-md bg-brand text-ink text-xs font-medium hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed focus-ring transition-colors"
          >
            {submitting
              ? "Submitting…"
              : leafCount > 1
                ? `Submit ${leafCount} backtests`
                : "Submit backtest"}
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
