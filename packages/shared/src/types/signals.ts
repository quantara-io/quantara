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
}
