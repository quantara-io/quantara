import { Hono } from "hono";
import { requireAuth } from "../middleware/require-auth.js";
import { requireAdmin } from "../middleware/require-admin.js";
import { getStatus, getMarket, getNews, getWhitelist, setWhitelist } from "../services/admin.service.js";

const admin = new Hono();

admin.use("*", requireAuth);
admin.use("*", requireAdmin);

admin.get("/status", async (c) => c.json({ success: true, data: await getStatus() }));

admin.get("/market", async (c) => {
  const pair = c.req.query("pair") ?? "BTC/USDT";
  const exchange = c.req.query("exchange") ?? "binanceus";
  return c.json({ success: true, data: await getMarket(pair, exchange) });
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
