import type { TimeframeVote } from "./rules.js";
import type { Timeframe } from "./ingestion.js";
import type { RiskRecommendation } from "./risk.js";

export const SIGNAL_TYPES = ["buy", "sell", "hold"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export interface Signal {
  id: string;
  pair: string;
  type: SignalType;
  confidence: number;
  reasoning: string;
  exchangeData: ExchangePricePoint[];
  volatilityFlag: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface ExchangePricePoint {
  exchange: string;
  price: number;
  volume24h: number;
  timestamp: string;
  stale: boolean;
}

export interface SignalHistoryEntry {
  signalId: string;
  pair: string;
  type: SignalType;
  confidence: number;
  createdAt: string;
  outcome: SignalOutcome;
  priceAtSignal: number;
  priceAtResolution: number | null;
}

export type SignalOutcome = "correct" | "incorrect" | "neutral" | "pending";

/**
 * The user-facing headline signal — one per pair, combining all per-TF votes.
 * Carries the per-TF votes for transparency / reasoning attribution.
 *
 * Design: §5 of docs/SIGNALS_AND_RISK.md
 */
export interface BlendedSignal {
  pair: string;
  type: "buy" | "sell" | "hold";
  confidence: number; // ordinal in v1; calibrated in Phase 8
  volatilityFlag: boolean;
  gateReason: "vol" | "dispersion" | "stale" | null;
  rulesFired: string[]; // union across all contributing TFs

  // Transparency for reasoning string + UI breakdown
  perTimeframe: Record<Timeframe, TimeframeVote | null>;
  weightsUsed: Record<Timeframe, number>; // post-renormalization (per §5.6)

  // Identifying / lifecycle
  asOf: number; // unix ms — latest TF close that triggered this blend
  emittingTimeframe: Timeframe; // which TF's close drove this blend run

  // Risk recommendation — null when type === "hold" (§9.9 / Fix 2)
  risk: RiskRecommendation | null;

  // Breaking-news invalidation (Phase 6b / §6.7).
  // Set when a high-magnitude news event fires for the pair after this signal was emitted.
  // undefined/null = signal is current; non-null string = UI should show a "refreshing" banner.
  // The next regular TF close emits a fresh signal row with invalidatedAt = null.
  invalidatedAt?: string | null;
  invalidationReason?: string | null; // e.g. "Breaking news: Coinbase delists ETH staking"

  // Phase B1 — two-stage ratification status (§B1 of LATENCY_PLAN.md).
  // null / absent = pre-B1 row; "pending" = LLM ratification in flight;
  // "not-required" = hold signal or clear confidence — no LLM call needed;
  // "ratified" = LLM confirmed the algo signal (or graceful fallback); "downgraded" = LLM changed the signal.
  ratificationStatus?: "pending" | "ratified" | "downgraded" | "not-required" | null;

  // Populated by stage-2 write when status is "ratified" or "downgraded".
  // null / absent when ratificationStatus is "pending", "not-required", or pre-B1.
  ratificationVerdict?: { type: "buy" | "sell" | "hold"; confidence: number; reasoning: string } | null;

  // Populated when status is "downgraded". Preserves the original algo signal so the UI
  // can show what changed (e.g. "Algo: buy 0.75 → LLM: hold 0.55").
  algoVerdict?: { type: "buy" | "sell" | "hold"; confidence: number; reasoning: string } | null;
}
