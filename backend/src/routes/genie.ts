import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { requireAuth } from "../middleware/require-auth.js";
import { SignalsResponse, SignalByPairResponse, SignalHistoryResponse } from "../lib/schemas/genie.js";
import { ADVISORY_DISCLAIMER } from "@quantara/shared";

const genie = new OpenAPIHono();
genie.use("*", requireAuth);

const signalsRoute = createRoute({
  method: "get", path: "/signals", tags: ["Genie"], summary: "Get current trading signals",
  description: "Returns the latest buy/sell/hold signals across all monitored pairs.",
  security: [{ Bearer: [] }],
  responses: { 200: { content: { "application/json": { schema: SignalsResponse } }, description: "Current signals" } },
});
genie.openapi(signalsRoute, (c) => c.json({ success: true as const, data: { signals: [], disclaimer: ADVISORY_DISCLAIMER } }));

const signalByPairRoute = createRoute({
  method: "get", path: "/signals/:pair", tags: ["Genie"], summary: "Get signal for a specific pair",
  security: [{ Bearer: [] }],
  request: { params: z.object({ pair: z.string().describe("Trading pair e.g. BTC-USDT") }) },
  responses: { 200: { content: { "application/json": { schema: SignalByPairResponse } }, description: "Signal for pair" } },
});
genie.openapi(signalByPairRoute, (c) => {
  const { pair } = c.req.valid("param");
  return c.json({ success: true as const, data: { pair, signal: null, disclaimer: ADVISORY_DISCLAIMER } });
});

const historyRoute = createRoute({
  method: "get", path: "/history", tags: ["Genie"], summary: "Get signal history",
  description: "Returns historical signals with outcomes for backtesting and performance evaluation.",
  security: [{ Bearer: [] }],
  request: { query: z.object({ page: z.coerce.number().optional().default(1), pageSize: z.coerce.number().optional().default(20), pair: z.string().optional() }) },
  responses: { 200: { content: { "application/json": { schema: SignalHistoryResponse } }, description: "Signal history" } },
});
genie.openapi(historyRoute, (c) => {
  const { page, pageSize } = c.req.valid("query");
  return c.json({ success: true as const, data: { history: [], meta: { page, pageSize, total: 0, hasMore: false } } });
});

export { genie };
