import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { ADVISORY_DISCLAIMER, PAIRS } from "@quantara/shared";
import type { TradingPair } from "@quantara/shared";

import { requireAuth } from "../middleware/require-auth.js";
import { ErrorResponse } from "../lib/schemas/common.js";
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
genie.openapi(signalsRoute, (c) =>
  c.json({ success: true as const, data: { signals: [], disclaimer: ADVISORY_DISCLAIMER } }),
);

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
      content: { "application/json": { schema: ErrorResponse } },
      description: "Unknown trading pair",
    },
  },
});
genie.openapi(signalByPairRoute, (c) => {
  const { pair: rawPair } = c.req.valid("param");
  // Normalise BTC-USDT → BTC/USDT so both dash and slash forms are accepted.
  const pair = rawPair.replace(/-/g, "/");
  if (!PAIRS.includes(pair as TradingPair)) {
    return c.json(
      {
        success: false as const,
        error: {
          code: "INVALID_PAIR",
          message: `Pair must be one of: ${PAIRS.join(", ")}`,
        },
      },
      404 as 404,
    ) as any;
  }
  return c.json({
    success: true as const,
    data: { pair, signal: null, disclaimer: ADVISORY_DISCLAIMER },
  });
});

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
    data: { history: [], meta: { page, pageSize, total: 0, hasMore: false } },
  });
});

export { genie };
