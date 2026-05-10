import { useEffect, useRef, useState } from "react";
import { PAIRS, GLOSSARY } from "@quantara/shared";
import type {
  BlendedSignal,
  RiskRecommendation,
  SignalInterpretation,
  TimeframeVote,
} from "@quantara/shared";

import { apiFetch } from "../lib/api";
import { getAccessToken } from "../lib/auth";
import { HelpTooltip } from "../components/HelpTooltip";

interface SignalsData {
  signals: BlendedSignal[];
  disclaimer: string;
}

const BLENDER_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;

// WebSocket endpoint for the realtime signal push channel (PR #131).
// Configured at build time via VITE_WS_BASE; falls back to a sensible dev URL.
const WS_BASE = (import.meta.env.VITE_WS_BASE as string | undefined) ?? "wss://ws.dev.quantara.io";

// Reconnect backoff ceiling — exponential growth from 1s.
const MAX_RECONNECT_DELAY_MS = 30_000;

export function Genie() {
  // Map<pair, signal> — keyed by pair so push updates replace in place.
  const [signalsByPair, setSignalsByPair] = useState<Map<string, BlendedSignal>>(new Map());
  const [disclaimer, setDisclaimer] = useState("");
  const [error, setError] = useState("");
  const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "closed" | "error">(
    "connecting",
  );
  const [loading, setLoading] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  // Initial fetch — populates the page with current signals before WS is open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch<SignalsData>("/api/genie/signals");
      if (cancelled) return;
      if (res.success && res.data) {
        const map = new Map<string, BlendedSignal>();
        for (const sig of res.data.signals) map.set(sig.pair, sig);
        setSignalsByPair(map);
        setDisclaimer(res.data.disclaimer ?? "");
        setError("");
      } else {
        setError(res.error?.message ?? "Failed to load signals");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // WebSocket subscription — receives push updates as signals emit.
  useEffect(() => {
    intentionalCloseRef.current = false;

    function connect() {
      const jwt = getAccessToken();
      if (!jwt) {
        setWsStatus("error");
        return;
      }
      // ws-connect Lambda reads JWT from `token` query param (no "Bearer" prefix).
      // WebSocket handshake doesn't support custom headers, so we pass it via query.
      const url = `${WS_BASE}?pairs=${encodeURIComponent(PAIRS.join(","))}&token=${encodeURIComponent(jwt)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setWsStatus("connecting");

      ws.addEventListener("open", () => {
        reconnectAttemptRef.current = 0;
        setWsStatus("open");
      });

      ws.addEventListener("message", (event) => {
        try {
          const signal = JSON.parse(event.data as string) as BlendedSignal;
          // Defensive: only update on a recognizable signal shape with a pair key.
          if (!signal || typeof signal.pair !== "string") return;
          setSignalsByPair((prev) => {
            const next = new Map(prev);
            next.set(signal.pair, signal);
            return next;
          });
        } catch {
          // Ignore non-JSON or malformed messages.
        }
      });

      ws.addEventListener("close", () => {
        if (intentionalCloseRef.current) return;
        setWsStatus("closed");
        // Exponential backoff: 1s, 2s, 4s, ... capped at MAX_RECONNECT_DELAY_MS.
        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      });

      ws.addEventListener("error", () => {
        setWsStatus("error");
      });
    }

    connect();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  if (error)
    return (
      <div className="p-3 rounded bg-down-soft text-down-strong border border-down/30 text-sm">
        {error}
      </div>
    );
  if (loading) return <div className="text-sm text-muted2">Loading…</div>;

  // Render in canonical PAIRS order so the layout is stable as updates arrive.
  const orderedSignals = PAIRS.map((pair) => signalsByPair.get(pair)).filter(
    (s): s is BlendedSignal => s != null,
  );

  return (
    <div className="space-y-4">
      <WsStatusBanner status={wsStatus} />
      {orderedSignals.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface p-6 text-center text-sm text-muted">
          No signals available yet — pipeline may be warming up.
        </div>
      ) : (
        orderedSignals.map((signal) => <SignalCard key={signal.pair} signal={signal} />)
      )}
      {disclaimer && <p className="text-[11px] text-muted2 text-center">{disclaimer}</p>}
    </div>
  );
}

function WsStatusBanner({ status }: { status: "connecting" | "open" | "closed" | "error" }) {
  if (status === "open") return null;
  const text =
    status === "connecting"
      ? "Connecting to realtime feed…"
      : status === "closed"
        ? "Reconnecting to realtime feed…"
        : "Realtime feed unavailable — initial snapshot only.";
  const cls =
    status === "error"
      ? "bg-down-soft text-down-strong border-down/30"
      : "bg-surface text-muted border-line";
  return <div className={`rounded border px-3 py-1.5 text-[11px] ${cls}`}>{text}</div>;
}

function SignalCard({ signal }: { signal: BlendedSignal }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4 space-y-3">
      {/* Invalidation banner */}
      {signal.invalidatedAt != null && (
        <div className="rounded bg-warn-soft border border-warn/30 px-3 py-2 text-xs text-warn flex items-center gap-2">
          <span className="font-medium">Refreshing</span>
          {signal.invalidationReason && (
            <span className="text-warn/80">{signal.invalidationReason}</span>
          )}
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-ink">{signal.pair}</h2>
        <TypeBadge type={signal.type} />
        <span className="text-sm text-ink2 font-mono">
          {Math.round(signal.confidence * 100)}%
        </span>
        {signal.volatilityFlag && <VolatilityChip />}
        {signal.gateReason != null && <GateChip reason={signal.gateReason} />}
      </div>

      {/* Timestamps */}
      <div className="flex gap-4 text-[11px] text-muted2">
        <span>
          <span className="text-muted2">asOf </span>
          {new Date(signal.asOf).toLocaleString()}
        </span>
        <span>
          <span className="text-muted2">emitting </span>
          {signal.emittingTimeframe}
        </span>
      </div>

      {/* Interpretation — Phase B2 (#171).
          interpretation.text is the consolidated user-facing narrative sourced from
          either the LLM ratification reasoning or the algo rulesFired summary.
          When source === "llm-downgraded", also show the algo → LLM transition. */}
      {signal.interpretation ? (
        <InterpretationBlock
          interpretation={signal.interpretation}
          finalType={signal.type}
          finalConfidence={signal.confidence}
        />
      ) : (
        /* Pre-B2 fallback: render rulesFired list as before */
        <div className="text-sm text-ink2">
          {signal.rulesFired.length > 0 ? (
            <ul className="list-disc list-inside space-y-0.5 text-muted text-xs">
              {signal.rulesFired.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          ) : (
            <span className="text-muted2 text-xs italic">No rules attributed</span>
          )}
        </div>
      )}

      {/* Per-timeframe breakdown */}
      <PerTimeframeTable perTimeframe={signal.perTimeframe} weightsUsed={signal.weightsUsed} />

      {/* Risk recommendation */}
      {signal.risk != null && signal.type !== "hold" && <RiskBlock risk={signal.risk} />}
    </div>
  );
}

function InterpretationBlock({
  interpretation,
  finalType,
  finalConfidence,
}: {
  interpretation: SignalInterpretation;
  /** Final signal type after ratification — used to render the "→ LLM: hold 50%" tail on downgraded transitions. */
  finalType: "buy" | "sell" | "hold";
  /** Final signal confidence after ratification. */
  finalConfidence: number;
}) {
  const sourceLabel =
    interpretation.source === "llm-ratified"
      ? "LLM ratified"
      : interpretation.source === "llm-downgraded"
        ? "LLM downgraded"
        : "Algo";

  const sourceClass =
    interpretation.source === "llm-ratified"
      ? "bg-up-soft border-up/30 text-up"
      : interpretation.source === "llm-downgraded"
        ? "bg-amber-950/40 border-amber-900 text-amber-400"
        : "bg-surface border-line text-muted";

  return (
    <div className={`rounded border px-3 py-2 space-y-1.5 ${sourceClass}`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest opacity-70 inline-flex items-center gap-1">
          {sourceLabel}
          <HelpTooltip label={GLOSSARY.ratificationVerdict.label}>
            {GLOSSARY.ratificationVerdict.body}
          </HelpTooltip>
        </span>
      </div>
      <p className="text-sm leading-snug">{interpretation.text}</p>
      {interpretation.source === "llm-downgraded" && interpretation.originalAlgo && (
        <p className="text-xs text-muted2">
          Algo:{" "}
          <span className="font-mono text-muted">
            {interpretation.originalAlgo.type}{" "}
            {Math.round(interpretation.originalAlgo.confidence * 100)}%
          </span>{" "}
          &rarr; LLM:{" "}
          <span className="font-mono text-amber-400">
            {finalType} {Math.round(finalConfidence * 100)}%
          </span>
        </p>
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: "buy" | "sell" | "hold" }) {
  const classes =
    type === "buy"
      ? "bg-up-soft text-up-strong border border-up/30"
      : type === "sell"
        ? "bg-down-soft text-down-strong border border-down/30"
        : "bg-sunken text-muted border border-line";
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${classes}`}
    >
      {type}
    </span>
  );
}

function VolatilityChip() {
  return (
    <span className="px-1.5 py-0.5 rounded bg-warn-soft text-warn border border-warn/30 text-[11px]">
      high vol
    </span>
  );
}

function GateChip({ reason }: { reason: "vol" | "dispersion" | "stale" }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-warn-soft text-warn border border-warn/30 text-[11px]">
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
      <p className="text-[11px] text-muted2 uppercase tracking-widest mb-1">
        Timeframe breakdown
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted2">
            {["TF", "Vote", "Confidence", "Weight"].map((h) => (
              <th key={h} className="text-left font-medium pb-1">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BLENDER_TIMEFRAMES.map((tf) => {
            const vote: TimeframeVote | null | undefined = perTimeframe[tf];
            const weight: number | undefined = weightsUsed[tf];
            return (
              <tr key={tf} className="border-t border-line/60">
                <td className="py-1 text-muted font-mono">{tf}</td>
                <td className="py-1">
                  {vote != null ? (
                    <TypeBadge type={vote.type} />
                  ) : (
                    <span className="text-muted2">—</span>
                  )}
                </td>
                <td className="py-1 text-ink2 font-mono">
                  {vote != null ? `${Math.round(vote.confidence * 100)}%` : "—"}
                </td>
                <td className="py-1 text-muted2 font-mono">
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
    <div className="rounded border border-line bg-paper/60 p-3 space-y-2">
      <p className="text-[11px] text-muted2 uppercase tracking-widest">Risk recommendation</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-muted2">Position size</span>
        <span className="text-ink2 font-mono">
          {(risk.positionSizePct * 100).toFixed(1)}%
          <span className="text-muted2 ml-1">({risk.positionSizeModel})</span>
        </span>
        <span className="text-muted2">Stop loss</span>
        <span className="text-ink2 font-mono">{formatPrice(risk.stopLoss)}</span>
        <span className="text-muted2">Invalidation</span>
        <span className="text-ink2">{risk.invalidationCondition}</span>
      </div>
      {risk.takeProfit.length > 0 && (
        <div>
          <p className="text-[11px] text-muted2 mb-1">Take-profit ladder</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted2">
                {["Level", "Price", "Close %", "R-multiple"].map((h) => (
                  <th key={h} className="text-left font-medium pb-0.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {risk.takeProfit.map((tp, i) => (
                <tr key={i} className="border-t border-line/60">
                  <td className="py-0.5 text-muted2">TP{i + 1}</td>
                  <td className="py-0.5 text-up font-mono">{formatPrice(tp.price)}</td>
                  <td className="py-0.5 text-ink2 font-mono">
                    {(tp.closePct * 100).toFixed(0)}%
                  </td>
                  <td className="py-0.5 text-ink2 font-mono">{tp.rMultiple.toFixed(1)}R</td>
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
