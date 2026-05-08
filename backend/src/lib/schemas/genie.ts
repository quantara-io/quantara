import { z } from "@hono/zod-openapi";

/**
 * Mirrors the shared TimeframeVote interface — per-timeframe vote produced by
 * scoreTimeframe in ingestion/src/signals/score.ts.  Declared here so the
 * OpenAPI contract exposes the full wire shape of BlendedSignalSchema.
 */
export const TimeframeVoteSchema = z
  .object({
    type: z.enum(["buy", "sell", "hold"]),
    confidence: z.number().min(0).max(1),
    rulesFired: z.array(z.string()),
    bullishScore: z.number(),
    bearishScore: z.number(),
    volatilityFlag: z.boolean(),
    gateReason: z.enum(["vol", "dispersion", "stale"]).nullable(),
    asOf: z.number(),
  })
  .openapi("TimeframeVoteSchema");

/**
 * Mirrors the shared BlendedSignal interface — full wire shape returned by the
 * ingestion pipeline and surfaced via the genie route.  The perTimeframe and
 * weightsUsed fields were missing from the previous schema; adding them aligns
 * the OpenAPI contract with the DynamoDB-persisted shape.
 */
export const BlendedSignalSchema = z
  .object({
    pair: z.string(),
    type: z.enum(["buy", "sell", "hold"]),
    confidence: z.number().min(0).max(1),
    volatilityFlag: z.boolean(),
    gateReason: z.enum(["vol", "dispersion", "stale"]).nullable(),
    rulesFired: z.array(z.string()),
    perTimeframe: z.record(z.string(), TimeframeVoteSchema.nullable()).optional(),
    weightsUsed: z.record(z.string(), z.number()).optional(),
    asOf: z.number(),
    emittingTimeframe: z.string(),
    risk: z.unknown().nullable().optional(),
  })
  .openapi("BlendedSignalSchema");

export const ExchangePricePoint = z
  .object({
    exchange: z.string(),
    price: z.number(),
    volume24h: z.number(),
    timestamp: z.string(),
    stale: z.boolean(),
  })
  .openapi("ExchangePricePoint");

export const Signal = z
  .object({
    id: z.string(),
    pair: z.string(),
    type: z.enum(["buy", "sell", "hold"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
    exchangeData: z.array(ExchangePricePoint),
    volatilityFlag: z.boolean(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .openapi("Signal");

export const SignalsResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      signals: z.array(Signal),
      disclaimer: z.string(),
    }),
  })
  .openapi("SignalsResponse");

export const SignalByPairResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      pair: z.string(),
      signal: Signal.nullable(),
      disclaimer: z.string(),
    }),
  })
  .openapi("SignalByPairResponse");

export const SignalHistoryEntry = z
  .object({
    signalId: z.string(),
    pair: z.string(),
    type: z.enum(["buy", "sell", "hold"]),
    confidence: z.number(),
    createdAt: z.string(),
    outcome: z.enum(["correct", "incorrect", "neutral", "pending"]),
    priceAtSignal: z.number(),
    priceAtResolution: z.number().nullable(),
  })
  .openapi("SignalHistoryEntry");

export const SignalHistoryResponse = z
  .object({
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
  })
  .openapi("SignalHistoryResponse");
