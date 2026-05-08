import { z } from "@hono/zod-openapi";

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
