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

// Timeframe enum — mirrors the canonical TIMEFRAMES constant from @quantara/shared.
const TimeframeEnum = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);

/**
 * BlendedSignalSchema — the full user-facing signal shape that the signal-service
 * emits. Carries per-timeframe votes for transparency and post-renormalization
 * weights (§5.6 of SIGNALS_AND_RISK.md).
 */
export const BlendedSignalSchema = z
  .object({
    pair: z.string(),
    type: z.enum(["buy", "sell", "hold"]),
    confidence: z.number().min(0).max(1),
    volatilityFlag: z.boolean(),
    gateReason: z.enum(["vol", "dispersion", "stale"]).nullable(),
    rulesFired: z.array(z.string()),

    // Per-timeframe vote breakdown — null when a TF had no valid data.
    perTimeframe: z.record(TimeframeEnum, z.unknown().nullable()),
    // Post-renormalization weights per timeframe (§5.6).
    weightsUsed: z.record(TimeframeEnum, z.number()),

    // Lifecycle / identifying
    asOf: z.number().describe("Unix ms of the latest TF close that triggered this blend"),
    emittingTimeframe: TimeframeEnum,

    // Risk recommendation — null when type === "hold"
    risk: z.unknown().nullable(),
  })
  .openapi("BlendedSignalSchema");

export const SignalsResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      signals: z.array(BlendedSignalSchema),
      disclaimer: z.string(),
    }),
  })
  .openapi("SignalsResponse");

export const SignalByPairResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      pair: z.string(),
      signal: BlendedSignalSchema.nullable(),
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
