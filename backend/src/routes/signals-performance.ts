/**
 * Phase 8 performance API routes — GET /signals/history, /accuracy,
 * /calibration, /attribution.
 *
 * All routes are authenticated (requireAuth). No tier gate — calibration data
 * is product-public per the issue spec.
 *
 * Mounted at /api/signals in index.ts alongside the existing genie routes.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";

import { requireAuth } from "../middleware/require-auth.js";
import {
  getSignalHistory,
  getAccuracyAggregate,
  getCalibrationData,
  getRuleAttributionData,
} from "../lib/signals-performance-store.js";
import {
  SignalHistoryQuerySchema,
  SignalHistoryPerformanceResponse,
  SignalAccuracyQuerySchema,
  SignalAccuracyResponse,
  SignalCalibrationQuerySchema,
  SignalCalibrationResponse,
  SignalAttributionQuerySchema,
  SignalAttributionResponse,
} from "../lib/schemas/signals-performance.js";
// Inline 404 response schema for accuracy — needed because OpenAPIHono sub-apps
// don't have the global app.onError handler that maps NotFoundError → 404.
const AccuracyNotFoundSchema = z
  .object({
    success: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  })
  .openapi("AccuracyNotFoundResponse");

const signalsPerformance = new OpenAPIHono();
signalsPerformance.use("*", requireAuth);

// ---------------------------------------------------------------------------
// GET /history
// ---------------------------------------------------------------------------

const historyRoute = createRoute({
  method: "get",
  path: "/history",
  tags: ["Performance"],
  summary: "Get resolved signal history",
  description:
    "Returns resolved signal outcomes for a pair within a rolling window. " +
    "Paginated via cursor (nextCursor in response meta). Window enum: 7d | 30d | 90d.",
  security: [{ Bearer: [] }],
  request: {
    query: SignalHistoryQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: SignalHistoryPerformanceResponse } },
      description: "Resolved signal outcomes (empty array when none exist in the window)",
    },
  },
});

signalsPerformance.openapi(historyRoute, async (c) => {
  const { pair, window, limit, cursor } = c.req.valid("query");
  const result = await getSignalHistory(pair, window, limit, cursor);
  return c.json(
    {
      success: true as const,
      data: {
        outcomes: result.outcomes,
        meta: {
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        },
      },
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// GET /accuracy
// ---------------------------------------------------------------------------

const accuracyRoute = createRoute({
  method: "get",
  path: "/accuracy",
  tags: ["Performance"],
  summary: "Get rolling accuracy badge",
  description:
    "Returns rolling accuracy metrics for a pair: totalResolved, correct/incorrect/neutral counts, " +
    "accuracyPct. Brier and ECE are only included when totalResolved >= 30.",
  security: [{ Bearer: [] }],
  request: {
    query: SignalAccuracyQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: SignalAccuracyResponse } },
      description: "Accuracy badge data",
    },
    404: {
      content: { "application/json": { schema: AccuracyNotFoundSchema } },
      description: "No accuracy data found for this pair / window",
    },
  },
});

signalsPerformance.openapi(accuracyRoute, async (c) => {
  const { pair, timeframe, window } = c.req.valid("query");
  const accuracy = await getAccuracyAggregate(pair, timeframe, window);

  if (!accuracy) {
    return c.json(
      {
        success: false as const,
        error: {
          code: "NOT_FOUND",
          message:
            `No accuracy data found for pair=${pair} timeframe=${timeframe} window=${window}. ` +
            "Accuracy aggregates are computed as signals resolve — check back after outcomes have been recorded.",
        },
      } satisfies z.infer<typeof AccuracyNotFoundSchema>,
      404,
    );
  }

  return c.json(
    {
      success: true as const,
      data: { accuracy },
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// GET /calibration
// ---------------------------------------------------------------------------

const calibrationRoute = createRoute({
  method: "get",
  path: "/calibration",
  tags: ["Performance"],
  summary: "Get calibration chart data",
  description:
    "Returns K=10 confidence bins aggregated from raw signal outcomes for a (pair, timeframe). " +
    "Each bin has binLow, binHigh, count, meanConfidence, actualAccuracy.",
  security: [{ Bearer: [] }],
  request: {
    query: SignalCalibrationQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: SignalCalibrationResponse } },
      description: "Calibration chart data",
    },
  },
});

signalsPerformance.openapi(calibrationRoute, async (c) => {
  const { pair, timeframe, window } = c.req.valid("query");
  const result = await getCalibrationData(pair, timeframe, window);

  return c.json(
    {
      success: true as const,
      data: {
        pair,
        timeframe,
        window,
        totalUsed: result.totalUsed,
        bins: result.bins,
      },
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// GET /attribution
// ---------------------------------------------------------------------------

const attributionRoute = createRoute({
  method: "get",
  path: "/attribution",
  tags: ["Performance"],
  summary: "Get per-rule attribution",
  description:
    "Returns per-rule accuracy attribution for a (pair, timeframe). Shows which rules " +
    "contributed to correct vs incorrect outcomes. Window: 30d | 90d.",
  security: [{ Bearer: [] }],
  request: {
    query: SignalAttributionQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: SignalAttributionResponse } },
      description: "Per-rule attribution data",
    },
  },
});

signalsPerformance.openapi(attributionRoute, async (c) => {
  const { pair, timeframe, window } = c.req.valid("query");
  const rules = await getRuleAttributionData(pair, timeframe, window);

  return c.json(
    {
      success: true as const,
      data: {
        pair,
        timeframe,
        window,
        rules,
      },
    },
    200,
  );
});

export { signalsPerformance };
