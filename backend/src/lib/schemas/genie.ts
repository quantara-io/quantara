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
 * Subset of TimeframeEnum that the multi-horizon blender actually emits.
 * Per §5.2 of SIGNALS_AND_RISK.md, blending uses only 15m/1h/4h/1d (1m and 5m
 * are too noisy for the headline signal). The indicator-handler writes
 * BlendedSignal records with perTimeframe/weightsUsed keyed only on these 4 TFs;
 * the schema must reflect the production write shape, otherwise OpenAPI
 * response validation rejects real data.
 */
const BlendTimeframeEnum = z.enum(["15m", "1h", "4h", "1d"]);

/**
 * Per-timeframe vote produced by scoreTimeframe.
 * Mirrors the TimeframeVote interface from @quantara/shared so the OpenAPI
 * spec exposes a typed schema instead of an opaque blob.
 */
export const TimeframeVoteSchema = z
  .object({
    type: z.enum(["buy", "sell", "hold"]),
    confidence: z.number(),
    rulesFired: z.array(z.string()),
    bullishScore: z.number(),
    bearishScore: z.number(),
    volatilityFlag: z.boolean(),
    gateReason: z.enum(["vol", "dispersion", "stale"]).nullable(),
    asOf: z.number(),
  })
  .openapi("TimeframeVote");

/**
 * Risk recommendation emitted alongside each non-hold BlendedSignal.
 * Mirrors the RiskRecommendation interface from @quantara/shared.
 * null when signal.type === "hold" or computed sizePct is below the threshold.
 */
export const RiskRecommendationSchema = z
  .object({
    pair: z.string(),
    profile: z.enum(["conservative", "moderate", "aggressive"]),
    positionSizePct: z.number(),
    positionSizeModel: z.enum(["fixed", "vol-targeted", "kelly"]),
    stopLoss: z.number(),
    stopDistance: z.number().describe("ATR × multiplier (price delta, not an R-multiple)"),
    takeProfit: z.array(
      z.object({
        price: z.number(),
        closePct: z.number(),
        rMultiple: z.number(),
      }),
    ),
    invalidationCondition: z.string().describe("Human-readable invalidation condition"),
    trailingStopAfterTP2: z.object({
      multiplier: z.number(),
      reference: z.literal("ATR"),
    }),
  })
  .openapi("RiskRecommendation");

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
    // Keyed only on the 4 blender TFs (§5.2); 1m/5m are not part of blended signals.
    // z.record permits missing keys, so a real persisted item with just 15m/1h/4h/1d passes.
    perTimeframe: z.record(BlendTimeframeEnum, TimeframeVoteSchema.nullable()),
    // Post-renormalization weights per timeframe (§5.6).
    weightsUsed: z.record(BlendTimeframeEnum, z.number()),

    // Lifecycle / identifying
    asOf: z.number().describe("Unix ms of the latest TF close that triggered this blend"),
    // Match the canonical Timeframe type (all 6) — in practice the indicator-handler
    // only emits the 4 blender TFs, but typing this against the wider Timeframe keeps
    // BlendedSignalSchema assignable to BlendedSignal without a manual narrowing cast.
    emittingTimeframe: TimeframeEnum,

    // Risk recommendation — null when type === "hold"
    risk: RiskRecommendationSchema.nullable(),
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
