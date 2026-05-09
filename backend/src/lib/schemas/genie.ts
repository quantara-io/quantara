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
    // Keys are individually optional so that:
    //   - Test fixtures need not populate every TF
    //   - Historical DDB items written before schema-tightening (PR #103) still parse
    //   - Future indicator-handler regressions that drop a TF degrade gracefully
    perTimeframe: z.object({
      "15m": TimeframeVoteSchema.nullable().optional(),
      "1h": TimeframeVoteSchema.nullable().optional(),
      "4h": TimeframeVoteSchema.nullable().optional(),
      "1d": TimeframeVoteSchema.nullable().optional(),
    }),
    // Post-renormalization weights per timeframe (§5.6).
    // Same optional-key pattern as perTimeframe — partial DDB items and test
    // fixtures need not carry every TF weight.
    weightsUsed: z.object({
      "15m": z.number().optional(),
      "1h": z.number().optional(),
      "4h": z.number().optional(),
      "1d": z.number().optional(),
    }),

    // Lifecycle / identifying
    asOf: z.number().describe("Unix ms of the latest TF close that triggered this blend"),
    // Match the canonical Timeframe type (all 6) — in practice the indicator-handler
    // only emits the 4 blender TFs, but typing this against the wider Timeframe keeps
    // BlendedSignalSchema assignable to BlendedSignal without a manual narrowing cast.
    emittingTimeframe: TimeframeEnum,

    // Risk recommendation — null when type === "hold"
    risk: RiskRecommendationSchema.nullable(),

    // Phase 6b — breaking-news invalidation banner.
    // null / absent = signal is current; non-null = UI shows "refreshing" banner.
    // The next regular TF close emits a fresh row with invalidatedAt = null.
    invalidatedAt: z.string().nullable().optional(),
    invalidationReason: z.string().nullable().optional(),

    // Phase B1 — two-stage ratification status.
    // null / absent = pre-B1 row.
    ratificationStatus: z
      .enum(["pending", "ratified", "downgraded", "not-required"])
      .nullable()
      .optional(),

    // Populated by stage-2 write when ratificationStatus is "ratified" or "downgraded".
    ratificationVerdict: z
      .object({
        type: z.enum(["buy", "sell", "hold"]),
        confidence: z.number(),
        reasoning: z.string(),
      })
      .nullable()
      .optional(),

    // Populated when ratificationStatus is "downgraded". Preserves the original algo signal.
    algoVerdict: z
      .object({
        type: z.enum(["buy", "sell", "hold"]),
        confidence: z.number(),
        reasoning: z.string(),
      })
      .nullable()
      .optional(),
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
        /** Count of entries returned in this page. */
        total: z.number(),
        hasMore: z.boolean(),
        /**
         * Opaque DynamoDB cursor for the next page.
         * Pass as `cursor` query param to retrieve the next batch.
         * Absent when there are no more pages.
         */
        nextCursor: z.string().optional(),
      }),
    }),
  })
  .openapi("SignalHistoryResponse");
