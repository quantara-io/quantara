import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { requireAuth } from "../middleware/require-auth.js";
import {
  SignalsResponse,
  SignalByPairResponse,
  SignalHistoryResponse,
} from "../lib/schemas/genie.js";
import { ErrorResponse } from "../lib/schemas/common.js";
import { ADVISORY_DISCLAIMER } from "@quantara/shared";
import { getSignalsForUser, getSignalForPair } from "../lib/signal-service.js";
import { getUser, bootstrapUser } from "../lib/user-store.js";
import { logger } from "../lib/logger.js";

const genie = new OpenAPIHono();
genie.use("*", requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load the user profile, bootstrapping it with default risk profiles if it
 * doesn't exist yet (handles the first-login race before the signup bootstrap
 * has persisted the record).
 */
async function loadOrBootstrapUser(userId: string, email?: string, tierId = "111") {
  const user = await getUser(userId);
  if (user) return user;

  // First time the user hits a protected route before the signup handler has
  // bootstrapped the DDB record — create it now with tier-default risk profiles.
  return bootstrapUser(userId, email ?? userId, tierId);
}

// ---------------------------------------------------------------------------
// GET /signals — all pairs, latest signal with per-user risk attached
// ---------------------------------------------------------------------------

const signalsRoute = createRoute({
  method: "get",
  path: "/signals",
  tags: ["Genie"],
  summary: "Get current trading signals with per-user risk recommendation",
  description:
    "Returns the latest buy/sell/hold signals across all monitored pairs, " +
    "enriched with a per-user risk recommendation computed at read time from the " +
    "authenticated user's risk profile and the latest indicator state.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: SignalsResponse } },
      description: "Current signals with per-user risk",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Not authenticated",
    },
  },
});

genie.openapi(signalsRoute, async (c) => {
  const auth = c.get("auth");
  try {
    const user = await loadOrBootstrapUser(auth.userId, auth.email);
    const signals = await getSignalsForUser(user);
    return c.json({
      success: true as const,
      data: { signals, disclaimer: ADVISORY_DISCLAIMER },
    } as any);
  } catch (err) {
    logger.error({ err, userId: auth.userId }, "genie /signals failed");
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /signals/:pair — single pair signal with per-user risk attached
// ---------------------------------------------------------------------------

const signalByPairRoute = createRoute({
  method: "get",
  path: "/signals/:pair",
  tags: ["Genie"],
  summary: "Get signal for a specific pair with per-user risk recommendation",
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      pair: z.string().describe("Trading pair, e.g. BTC-USDT (hyphens normalized to slashes)"),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SignalByPairResponse } },
      description: "Signal for pair with per-user risk",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Not authenticated",
    },
  },
});

genie.openapi(signalByPairRoute, async (c) => {
  const auth = c.get("auth");
  // Normalize URL-safe "BTC-USDT" to canonical "BTC/USDT"
  const rawPair = c.req.valid("param").pair;
  const pair = rawPair.replace(/-/g, "/");

  try {
    const user = await loadOrBootstrapUser(auth.userId, auth.email);
    const signal = await getSignalForPair(pair, user);
    return c.json({
      success: true as const,
      data: { pair, signal, disclaimer: ADVISORY_DISCLAIMER },
    } as any);
  } catch (err) {
    logger.error({ err, userId: auth.userId, pair }, "genie /signals/:pair failed");
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /history — signal history (pagination stub; Phase 8 will flesh this out)
// ---------------------------------------------------------------------------

const historyRoute = createRoute({
  method: "get",
  path: "/history",
  tags: ["Genie"],
  summary: "Get signal history",
  description:
    "Returns historical signals with outcomes for backtesting and performance evaluation.",
  security: [{ Bearer: [] }],
  request: {
    query: z.object({
      page: z.coerce.number().optional().default(1),
      pageSize: z.coerce.number().optional().default(20),
      pair: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SignalHistoryResponse } },
      description: "Signal history",
    },
  },
});

genie.openapi(historyRoute, (c) => {
  const { page, pageSize } = c.req.valid("query");
  return c.json({
    success: true as const,
    data: {
      history: [],
      meta: { page, pageSize, total: 0, hasMore: false },
    },
  });
});

export { genie };
