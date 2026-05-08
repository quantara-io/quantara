import { z } from "@hono/zod-openapi";

export const ExchangePricePoint = z.object({
  exchange: z.string(),
  price: z.number(),
  volume24h: z.number(),
  timestamp: z.string(),
  stale: z.boolean(),
}).openapi("ExchangePricePoint");

export const Signal = z.object({
  id: z.string(),
  pair: z.string(),
  type: z.enum(["buy", "sell", "hold"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  exchangeData: z.array(ExchangePricePoint),
  volatilityFlag: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
}).openapi("Signal");

// ---------------------------------------------------------------------------
// RiskRecommendation — per-user advisory, attached at read time
// ---------------------------------------------------------------------------

const TakeProfitLevel = z.object({
  price: z.number(),
  closePct: z.number(),
  rMultiple: z.number(),
}).openapi("TakeProfitLevel");

const TrailingStop = z.object({
  multiplier: z.number(),
  reference: z.literal("ATR"),
}).openapi("TrailingStop");

export const RiskRecommendationSchema = z.object({
  pair: z.string(),
  profile: z.enum(["conservative", "moderate", "aggressive"]),
  positionSizePct: z.number(),
  positionSizeModel: z.enum(["fixed", "vol-targeted", "kelly"]),
  stopLoss: z.number(),
  stopDistance: z.number(),
  takeProfit: z.array(TakeProfitLevel),
  invalidationCondition: z.string(),
  trailingStopAfterTP2: TrailingStop,
}).openapi("RiskRecommendation");

// ---------------------------------------------------------------------------
// BlendedSignal — the core signal returned to authenticated users
// ---------------------------------------------------------------------------

export const BlendedSignalSchema = z.object({
  pair: z.string(),
  type: z.enum(["buy", "sell", "hold"]),
  confidence: z.number().min(0).max(1),
  volatilityFlag: z.boolean(),
  gateReason: z.enum(["vol", "dispersion", "stale"]).nullable(),
  rulesFired: z.array(z.string()),
  asOf: z.number(),
  emittingTimeframe: z.string(),
  signalId: z.string(),
  emittedAt: z.string(),
  // risk is null for hold signals or when indicator state is unavailable
  risk: RiskRecommendationSchema.nullable(),
}).openapi("BlendedSignal");

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

export const SignalsResponse = z.object({
  success: z.literal(true),
  data: z.object({
    signals: z.array(BlendedSignalSchema),
    disclaimer: z.string(),
  }),
}).openapi("SignalsResponse");

export const SignalByPairResponse = z.object({
  success: z.literal(true),
  data: z.object({
    pair: z.string(),
    signal: BlendedSignalSchema.nullable(),
    disclaimer: z.string(),
  }),
}).openapi("SignalByPairResponse");

export const SignalHistoryEntry = z.object({
  signalId: z.string(),
  pair: z.string(),
  type: z.enum(["buy", "sell", "hold"]),
  confidence: z.number(),
  createdAt: z.string(),
  outcome: z.enum(["correct", "incorrect", "neutral", "pending"]),
  priceAtSignal: z.number(),
  priceAtResolution: z.number().nullable(),
}).openapi("SignalHistoryEntry");

export const SignalHistoryResponse = z.object({
  success: z.literal(true),
  data: z.object({
    history: z.array(SignalHistoryEntry),
    meta: z.object({
      page: z.number(),
      pageSize: z.number(),
      total: z.number(),
      hasMore: z.boolean(),
    }),
  }),
}).openapi("SignalHistoryResponse");
