import { Hono } from "hono";
import { requireAuth } from "../middleware/require-auth.js";
import { ADVISORY_DISCLAIMER } from "@quantara/shared";

const genie = new Hono();

genie.use("*", requireAuth);

genie.get("/signals", (c) => {
  return c.json({
    success: true,
    data: {
      signals: [],
      disclaimer: ADVISORY_DISCLAIMER,
    },
  });
});

genie.get("/signals/:pair", (c) => {
  const pair = c.req.param("pair");
  return c.json({
    success: true,
    data: { pair, signal: null, disclaimer: ADVISORY_DISCLAIMER },
  });
});

genie.get("/history", (c) => {
  return c.json({ success: true, data: { history: [], meta: { page: 1, pageSize: 20, total: 0, hasMore: false } } });
});

export { genie };
