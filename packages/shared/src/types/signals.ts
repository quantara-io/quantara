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
