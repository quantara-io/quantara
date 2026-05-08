import { Hono } from "hono";

import { requireAuth } from "../middleware/require-auth.js";
import { requireAdmin } from "../middleware/require-admin.js";
import { getStatus, getMarket, getNews, getWhitelist, setWhitelist, getSignals } from "../services/admin.service.js";
import { PAIRS } from "@quantara/shared";

const admin = new Hono();

admin.use("*", requireAuth);
admin.use("*", requireAdmin);

admin.get("/status", async (c) => c.json({ success: true, data: await getStatus() }));

admin.get("/market", async (c) => {
  const pair = c.req.query("pair") ?? "BTC/USDT";
  const exchange = c.req.query("exchange") ?? "binanceus";
  return c.json({ success: true, data: await getMarket(pair, exchange) });
});

admin.get("/signals", async (c) => {
  const pair = c.req.query("pair");
  if (!pair) {
    return c.json({ success: false, error: { code: "BAD_REQUEST", message: "pair is required" } }, 400);
  }
  if (!(PAIRS as readonly string[]).includes(pair)) {
    return c.json({ success: false, error: { code: "BAD_REQUEST", message: `pair must be one of: ${PAIRS.join(", ")}` } }, 400);
  }

  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 100;
  if (isNaN(limit) || limit < 1 || limit > 500) {
    return c.json({ success: false, error: { code: "BAD_REQUEST", message: "limit must be between 1 and 500" } }, 400);
  }

  const sinceRaw = c.req.query("since");
  let since: Date;
  if (sinceRaw !== undefined) {
    since = new Date(sinceRaw);
    if (isNaN(since.getTime())) {
      return c.json({ success: false, error: { code: "BAD_REQUEST", message: "since must be a valid ISO 8601 date" } }, 400);
    }
  } else {
    since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  const signals = await getSignals(pair, since, limit);
  return c.json({ success: true, data: { signals } });
});

admin.get("/news", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  return c.json({ success: true, data: await getNews(limit) });
});

admin.get("/whitelist", async (c) => c.json({ success: true, data: await getWhitelist() }));

admin.put("/whitelist", async (c) => {
  const body = await c.req.json<{ ips?: unknown }>();
  if (!Array.isArray(body.ips) || !body.ips.every((x) => typeof x === "string")) {
    return c.json({ success: false, error: { code: "BAD_REQUEST", message: "Body must be { ips: string[] }" } }, 400);
  }
  return c.json({ success: true, data: await setWhitelist(body.ips) });
});

export { admin };
