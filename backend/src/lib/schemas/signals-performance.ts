/**
 * Zod-openapi schemas for the Phase 8 performance API endpoints:
 *   GET /signals/history
 *   GET /signals/accuracy
 *   GET /signals/calibration
 *   GET /signals/attribution
 */

import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Shared enums / building blocks
// ---------------------------------------------------------------------------

export const AccuracyWindowEnum = z.enum(["7d", "30d", "90d"]).openapi("AccuracyWindow");
export const AttributionWindowEnum = z.enum(["30d", "90d"]).openapi("AttributionWindow");
export const OutcomeValueEnum = z.enum(["correct", "incorrect", "neutral"]).openapi("OutcomeValue");

// ---------------------------------------------------------------------------
// GET /signals/history
// ---------------------------------------------------------------------------

export const SignalHistoryQuerySchema = z
  .object({
    pair: z.string().describe("Trading pair e.g. BTC/USDT"),
    window: AccuracyWindowEnum.default("30d").describe("Rolling window: 7d | 30d | 90d"),
    limit: z.coerce.number().min(1).max(200).default(50).describe("Max results to return"),
    cursor: z.string().optional().describe("Opaque pagination cursor from previous response"),
  })
  .openapi("SignalHistoryQuery");

/** One resolved signal outcome row. */
export const SignalOutcomeEntry = z
  .object({
    pair: z.string(),
    signalId: z.string(),
    type: z.enum(["buy", "sell", "hold"]),
    confidence: z.number().min(0).max(1),
    createdAt: z.string(),
    expiresAt: z.string(),
    resolvedAt: z.string(),
    priceAtSignal: z.number(),
    priceAtResolution: z.number(),
    priceMovePct: z.number(),
    thresholdUsed: z.number(),
    outcome: OutcomeValueEnum,
    rulesFired: z.array(z.string()),
    emittingTimeframe: z.string(),
    invalidatedExcluded: z.boolean(),
  })
  .openapi("SignalOutcomeEntry");

export const SignalHistoryPerformanceResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      outcomes: z.array(SignalOutcomeEntry),
      meta: z.object({
        hasMore: z.boolean(),
        nextCursor: z.string().optional(),
      }),
    }),
  })
  .openapi("SignalHistoryPerformanceResponse");

// ---------------------------------------------------------------------------
// GET /signals/accuracy
// ---------------------------------------------------------------------------

export const SignalAccuracyQuerySchema = z
  .object({
    pair: z.string().describe("Trading pair e.g. BTC/USDT"),
    window: AccuracyWindowEnum.default("30d").describe("Rolling window: 7d | 30d | 90d"),
  })
  .openapi("SignalAccuracyQuery");

/** Rolling accuracy badge shape. */
export const AccuracyBadge = z
  .object({
    pair: z.string(),
    window: AccuracyWindowEnum,
    totalResolved: z.number(),
    correctCount: z.number(),
    incorrectCount: z.number(),
    neutralCount: z.number(),
    invalidatedCount: z.number(),
    /** correct / (correct + incorrect). null when no directional outcomes. */
    accuracyPct: z.number().nullable(),
    /** Brier score — only present when totalResolved >= 30. */
    brier: z.number().nullable().optional(),
    /** Expected Calibration Error — only present when totalResolved >= 30. */
    ece: z.number().nullable().optional(),
    computedAt: z.string(),
  })
  .openapi("AccuracyBadge");

export const SignalAccuracyResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      accuracy: AccuracyBadge,
    }),
  })
  .openapi("SignalAccuracyResponse");

// ---------------------------------------------------------------------------
// GET /signals/calibration
// ---------------------------------------------------------------------------

export const SignalCalibrationQuerySchema = z
  .object({
    pair: z.string().describe("Trading pair e.g. BTC/USDT"),
    timeframe: z
      .enum(["15m", "1h", "4h", "1d"])
      .default("1h")
      .describe("Emitting timeframe filter"),
    window: AccuracyWindowEnum.default("90d").describe("Rolling window: 7d | 30d | 90d"),
  })
  .openapi("SignalCalibrationQuery");

/** One K=10 confidence bin. */
export const CalibrationBin = z
  .object({
    binLow: z.number().describe("Lower bound of confidence bin (inclusive)"),
    binHigh: z.number().describe("Upper bound of confidence bin (exclusive, except last bin)"),
    count: z.number().describe("Number of non-neutral outcomes in this bin"),
    meanConfidence: z.number().describe("Mean model confidence for outcomes in this bin"),
    actualAccuracy: z.number().describe("Fraction of correct outcomes in this bin"),
  })
  .openapi("CalibrationBin");

export const SignalCalibrationResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      pair: z.string(),
      timeframe: z.string(),
      window: AccuracyWindowEnum,
      totalUsed: z.number(),
      bins: z.array(CalibrationBin),
    }),
  })
  .openapi("SignalCalibrationResponse");

// ---------------------------------------------------------------------------
// GET /signals/attribution
// ---------------------------------------------------------------------------

export const SignalAttributionQuerySchema = z
  .object({
    pair: z.string().describe("Trading pair e.g. BTC/USDT"),
    timeframe: z
      .enum(["15m", "1h", "4h", "1d"])
      .default("1h")
      .describe("Emitting timeframe filter"),
    window: AttributionWindowEnum.default("30d").describe("Rolling window: 30d | 90d"),
  })
  .openapi("SignalAttributionQuery");

/** Per-rule attribution row. */
export const RuleAttributionEntry = z
  .object({
    rule: z.string(),
    fireCount: z.number(),
    correctCount: z.number(),
    incorrectCount: z.number(),
    neutralCount: z.number(),
    /**
     * correctCount / (correctCount + incorrectCount).
     * null when no directional outcomes.
     */
    contribution: z.number().nullable(),
    computedAt: z.string(),
  })
  .openapi("RuleAttributionEntry");

export const SignalAttributionResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      pair: z.string(),
      timeframe: z.string(),
      window: AttributionWindowEnum,
      rules: z.array(RuleAttributionEntry),
    }),
  })
  .openapi("SignalAttributionResponse");
