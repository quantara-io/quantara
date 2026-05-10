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
  getGenieMetrics,
  getRatifications,
} from "../services/admin.service.js";
import { getPipelineState } from "../services/pipeline-state.service.js";
import {
  forceRatification,
  replayNewsEnrichment,
  injectSentimentShock,
} from "../services/admin-debug.service.js";

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

admin.get("/pipeline-state", async (c) => {
  const pair = c.req.query("pair");
  if (pair !== undefined && !(PAIRS as readonly string[]).includes(pair)) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: `pair must be one of: ${PAIRS.join(", ")}` },
      },
      400,
    );
  }
  const data = await getPipelineState(pair);
  return c.json({ success: true, data });
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

  // Validate `pair` against the shared PAIRS list when provided. Matches the
  // `/signals` pattern so unknown pairs return 400 instead of fanning out
  // to a partition that has no rows (silent empty page + wasted DDB Query).
  const pairRaw = c.req.query("pair");
  if (pairRaw !== undefined && !(PAIRS as readonly string[]).includes(pairRaw)) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: `pair must be one of: ${PAIRS.join(", ")}` },
      },
      400,
    );
  }

  // Validate since / until as ISO 8601 (matches the /signals route's pattern)
  // AND normalize to canonical `Date#toISOString()` format before passing to
  // the service. The DDB sort key (`invokedAtRecordId`) is built from
  // `new Date().toISOString()` (millisecond precision, always-Z), so inputs
  // like `2026-05-01T00:00:00Z` (no millis) compare lexicographically before
  // stored values like `2026-05-01T00:00:00.000Z`, which would silently
  // exclude boundary rows. Re-serializing through Date pins the precision.
  const sinceRaw = c.req.query("since");
  let since: string | undefined;
  if (sinceRaw !== undefined) {
    const parsed = new Date(sinceRaw);
    if (isNaN(parsed.getTime())) {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "since must be a valid ISO 8601 date" },
        },
        400,
      );
    }
    since = parsed.toISOString();
  }
  const untilRaw = c.req.query("until");
  let until: string | undefined;
  if (untilRaw !== undefined) {
    const parsed = new Date(untilRaw);
    if (isNaN(parsed.getTime())) {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "until must be a valid ISO 8601 date" },
        },
        400,
      );
    }
    until = parsed.toISOString();
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
    pair: pairRaw,
    timeframe: c.req.query("timeframe"),
    triggerReason: c.req.query("triggerReason"),
    since,
    until,
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

// Allowed timeframes match the blender's emit set in
// ingestion/src/signals/blend.ts. Validating here prevents accidental
// expensive queries on garbage strings.
const VALID_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;

admin.get("/genie-metrics", async (c) => {
  const sinceRaw = c.req.query("since");
  // Canonicalise the parsed Date back to ISO 8601 Z before forwarding.
  // The service uses this in DDB string range comparisons (BETWEEN), which
  // assume a consistent Z-suffixed format. A `2026-05-09T12:00:00+00:00`
  // is parseable but not lex-comparable to `2026-05-09T12:00:00.000Z`,
  // which would silently produce wrong filtering.
  let sinceCanon: string | undefined;
  if (sinceRaw !== undefined) {
    const parsed = new Date(sinceRaw);
    if (isNaN(parsed.getTime())) {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "since must be a valid ISO 8601 date" },
        },
        400,
      );
    }
    sinceCanon = parsed.toISOString();
  }

  const pair = c.req.query("pair");
  if (pair !== undefined && !(PAIRS as readonly string[]).includes(pair)) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: `pair must be one of: ${PAIRS.join(", ")}` },
      },
      400,
    );
  }

  const timeframe = c.req.query("timeframe");
  if (timeframe !== undefined && !(VALID_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: `timeframe must be one of: ${VALID_TIMEFRAMES.join(", ")}`,
        },
      },
      400,
    );
  }

  const metrics = await getGenieMetrics(sinceCanon, pair, timeframe);
  return c.json({ success: true, data: metrics });
});

// ---------------------------------------------------------------------------
// Debug endpoints (admin-only, real Bedrock calls, count against daily cap)
// ---------------------------------------------------------------------------

const VALID_TIMEFRAMES_DEBUG = ["15m", "1h", "4h", "1d"] as const;

/**
 * POST /api/admin/debug/force-ratification
 * Body: { pair, timeframe }
 * Reads the latest signal for the cell, calls Bedrock Sonnet 4.6 (matches the
 * production ratification model — see `ingestion/src/llm/ratify.ts`), writes
 * a ratification record (triggerReason="manual"), returns result inline.
 * Counts against the daily cap — returns 429 if exhausted. Server-side
 * idempotency: duplicate requests within 60s for the same (admin user, pair,
 * timeframe) collapse to 409.
 */
admin.post("/debug/force-ratification", async (c) => {
  const body = await c.req.json<{ pair?: unknown; timeframe?: unknown }>();
  const auth = c.get("auth");

  if (typeof body.pair !== "string" || !(PAIRS as readonly string[]).includes(body.pair)) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: `pair must be one of: ${PAIRS.join(", ")}` },
      },
      400,
    );
  }

  if (
    typeof body.timeframe !== "string" ||
    !(VALID_TIMEFRAMES_DEBUG as readonly string[]).includes(body.timeframe)
  ) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: `timeframe must be one of: ${VALID_TIMEFRAMES_DEBUG.join(", ")}`,
        },
      },
      400,
    );
  }

  const result = await forceRatification({
    pair: body.pair,
    timeframe: body.timeframe,
    userId: auth.userId,
  });

  if (result.duplicate) {
    return c.json(
      {
        success: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message:
            "Duplicate force-ratification within 60s window for the same (user, pair, timeframe). The first request is still processing.",
        },
      },
      409,
    );
  }

  if (result.capped) {
    return c.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: `Daily debug cap reached (${result.capCount} invocations in the past 24h)`,
        },
      },
      429,
    );
  }

  return c.json({ success: true, data: result });
});

/**
 * POST /api/admin/debug/replay-news-enrichment
 * Body: { newsId }
 * Re-runs Phase 5a enrichment (pair-tagging + sentiment) for the article.
 * Does NOT mutate the stored row — read-only diff tool. Server-side
 * idempotency: duplicate requests within 60s for the same (admin user,
 * newsId) collapse to 409.
 */
admin.post("/debug/replay-news-enrichment", async (c) => {
  const body = await c.req.json<{ newsId?: unknown }>();
  const auth = c.get("auth");

  if (typeof body.newsId !== "string" || body.newsId.trim() === "") {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "newsId must be a non-empty string" },
      },
      400,
    );
  }

  const result = await replayNewsEnrichment({
    newsId: body.newsId.trim(),
    userId: auth.userId,
  });

  if (result.duplicate) {
    return c.json(
      {
        success: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message:
            "Duplicate replay-news-enrichment within 60s window for the same (user, newsId). The first request is still processing.",
        },
      },
      409,
    );
  }

  return c.json({ success: true, data: result });
});

/**
 * POST /api/admin/debug/inject-sentiment-shock
 * Body: { pair, deltaScore, deltaMagnitude }
 * Synthesizes a sentiment shock and runs the detection + cost-gate path.
 * The shock IS written to the ratifications table (triggerReason="sentiment_shock")
 * so the full path can be observed end-to-end. Server-side idempotency:
 * duplicate requests within 60s for the same (admin user, pair, deltas)
 * collapse to 409.
 */
admin.post("/debug/inject-sentiment-shock", async (c) => {
  const body = await c.req.json<{
    pair?: unknown;
    deltaScore?: unknown;
    deltaMagnitude?: unknown;
  }>();
  const auth = c.get("auth");

  if (typeof body.pair !== "string" || !(PAIRS as readonly string[]).includes(body.pair)) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: `pair must be one of: ${PAIRS.join(", ")}` },
      },
      400,
    );
  }

  const deltaScore = Number(body.deltaScore);
  const deltaMagnitude = Number(body.deltaMagnitude);

  if (!Number.isFinite(deltaScore) || Math.abs(deltaScore) > 2) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "deltaScore must be a finite number in [-2, 2]" },
      },
      400,
    );
  }

  if (!Number.isFinite(deltaMagnitude) || Math.abs(deltaMagnitude) > 1) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: "deltaMagnitude must be a finite number in [-1, 1]",
        },
      },
      400,
    );
  }

  const result = await injectSentimentShock({
    pair: body.pair,
    deltaScore,
    deltaMagnitude,
    userId: auth.userId,
  });

  if (result.duplicate) {
    return c.json(
      {
        success: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message:
            "Duplicate inject-sentiment-shock within 60s window for the same (user, pair, deltas).",
        },
      },
      409,
    );
  }

  return c.json({ success: true, data: result });
});

export { admin };
