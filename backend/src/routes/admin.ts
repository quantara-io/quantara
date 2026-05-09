import { Hono } from "hono";
import { PAIRS } from "@quantara/shared";

import { requireAuth } from "../middleware/require-auth.js";
import { requireAdmin } from "../middleware/require-admin.js";
import {
  getStatus,
  getMarket,
  getNews,
  getNewsUsage,
  getWhitelist,
  setWhitelist,
  getSignals,
  getRatifications,
} from "../services/admin.service.js";

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
    return c.json(
      { success: false, error: { code: "BAD_REQUEST", message: "pair is required" } },
      400,
    );
  }
  if (!(PAIRS as readonly string[]).includes(pair)) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: `pair must be one of: ${PAIRS.join(", ")}` },
      },
      400,
    );
  }

  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 100;
  if (isNaN(limit) || limit < 1 || limit > 500) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "limit must be between 1 and 500" },
      },
      400,
    );
  }

  const sinceRaw = c.req.query("since");
  let since: Date;
  if (sinceRaw !== undefined) {
    since = new Date(sinceRaw);
    if (isNaN(since.getTime())) {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "since must be a valid ISO 8601 date" },
        },
        400,
      );
    }
  } else {
    since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  const signals = await getSignals(pair, since, limit);
  return c.json({ success: true, data: { signals } });
});

admin.get("/ratifications", async (c) => {
  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 50;
  if (isNaN(limit) || limit < 1 || limit > 200) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "limit must be between 1 and 200" },
      },
      400,
    );
  }

  // Validate since / until as ISO 8601 (matches the /signals route's pattern).
  // Bad input would otherwise reach DDB as a malformed sort-key prefix and
  // either return empty silently or surface as a generic 500.
  const sinceRaw = c.req.query("since");
  if (sinceRaw !== undefined && isNaN(new Date(sinceRaw).getTime())) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "since must be a valid ISO 8601 date" },
      },
      400,
    );
  }
  const untilRaw = c.req.query("until");
  if (untilRaw !== undefined && isNaN(new Date(untilRaw).getTime())) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "until must be a valid ISO 8601 date" },
      },
      400,
    );
  }

  // Validate cursor: must be base64-decodable JSON. The service still
  // tolerates malformed cursors (logs + ignores), but rejecting at the
  // route turns a silent empty-page bug into an explicit 400.
  const cursorRaw = c.req.query("cursor");
  if (cursorRaw !== undefined) {
    try {
      const decoded = Buffer.from(cursorRaw, "base64").toString();
      const parsed = JSON.parse(decoded);
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    } catch {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "cursor must be a base64-encoded JSON object" },
        },
        400,
      );
    }
  }

  const { items, cursor } = await getRatifications({
    pair: c.req.query("pair"),
    timeframe: c.req.query("timeframe"),
    triggerReason: c.req.query("triggerReason"),
    since: sinceRaw,
    until: untilRaw,
    cursor: cursorRaw,
    limit,
  });

  return c.json({ success: true, data: { items, cursor } });
});

admin.get("/news", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  return c.json({ success: true, data: await getNews(limit) });
});

admin.get("/news/usage", async (c) => {
  const sinceRaw = c.req.query("since");
  let since: Date;
  if (sinceRaw !== undefined) {
    since = new Date(sinceRaw);
    if (isNaN(since.getTime())) {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "since must be a valid ISO 8601 date" },
        },
        400,
      );
    }
  } else {
    since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }
  return c.json({ success: true, data: await getNewsUsage(since) });
});

admin.get("/whitelist", async (c) => c.json({ success: true, data: await getWhitelist() }));

admin.put("/whitelist", async (c) => {
  const body = await c.req.json<{ ips?: unknown }>();
  if (!Array.isArray(body.ips) || !body.ips.every((x) => typeof x === "string")) {
    return c.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Body must be { ips: string[] }" } },
      400,
    );
  }
  return c.json({ success: true, data: await setWhitelist(body.ips) });
});

export { admin };
