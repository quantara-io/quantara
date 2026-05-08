import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { ADVISORY_DISCLAIMER, PAIRS } from "@quantara/shared";

import { requireAuth } from "../middleware/require-auth.js";
import { getSignalForUser, getAllSignalsForUser, getSignalHistoryForUser } from "../lib/signal-service.js";
import {
  SignalsResponse,
  SignalByPairResponse,
  SignalHistoryResponse,
} from "../lib/schemas/genie.js";

const genie = new OpenAPIHono();
genie.use("*", requireAuth);

const signalsRoute = createRoute({
  method: "get",
  path: "/signals",
  tags: ["Genie"],
  summary: "Get current trading signals",
  description: "Returns the latest buy/sell/hold signals across all monitored pairs.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: SignalsResponse } },
      description: "Current signals",
    },
  },
});
genie.openapi(signalsRoute, async (c) => {
  const auth = c.get("auth");
  const signals = await getAllSignalsForUser(auth.userId, auth.email);
  return c.json({ success: true as const, data: { signals, disclaimer: ADVISORY_DISCLAIMER } });
});

const pairNotFoundSchema = z
  .object({
    success: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  })
  .openapi("PairNotFoundResponse");

const signalByPairRoute = createRoute({
  method: "get",
  path: "/signals/:pair",
  tags: ["Genie"],
  summary: "Get signal for a specific pair",
  security: [{ Bearer: [] }],
  request: { params: z.object({ pair: z.string().describe("Trading pair e.g. BTC-USDT") }) },
  responses: {
    200: {
      content: { "application/json": { schema: SignalByPairResponse } },
      description: "Signal for pair",
    },
    404: {
      content: { "application/json": { schema: pairNotFoundSchema } },
      description: "Unknown trading pair",
    },
  },
});
genie.openapi(signalByPairRoute, async (c) => {
  const { pair } = c.req.valid("param");

  // Whitelist pair against the canonical PAIRS constant.
  if (!(PAIRS as readonly string[]).includes(pair)) {
    return c.json(
      {
        success: false as const,
        error: { code: "UNKNOWN_PAIR", message: `Unknown trading pair: ${pair}` },
      } satisfies z.infer<typeof pairNotFoundSchema>,
      404,
    );
  }

  const auth = c.get("auth");
  const signal = await getSignalForUser(auth.userId, pair as (typeof PAIRS)[number], auth.email);
  return c.json(
    {
      success: true as const,
      data: { pair, signal, disclaimer: ADVISORY_DISCLAIMER },
    } satisfies z.infer<typeof SignalByPairResponse>,
    200,
  );
});

const historyRoute = createRoute({
  method: "get",
  path: "/history",
  tags: ["Genie"],
  summary: "Get signal history",
  description:
    "Returns historical signals with outcomes for backtesting and performance evaluation. Paginated via cursor (nextCursor in response meta).",
  security: [{ Bearer: [] }],
  request: {
    query: z.object({
      pageSize: z.coerce.number().optional().default(20),
      pair: z.string().optional(),
      /** Opaque cursor from previous response meta.nextCursor. */
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SignalHistoryResponse } },
      description: "Signal history",
    },
  },
});
genie.openapi(historyRoute, async (c) => {
  const { pageSize, pair, cursor } = c.req.valid("query");
  const auth = c.get("auth");

  const result = await getSignalHistoryForUser(auth.userId, auth.email, {
    pageSize,
    pair,
    cursor,
  });

  return c.json({
    success: true as const,
    data: {
      history: result.history,
      meta: {
        total: result.total,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
    },
  });
});

export { genie };
