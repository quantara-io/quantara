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
  getPipelineHealth,
  getActivity,
  getShadowSignals,
} from "../services/admin.service.js";
import { getPipelineState } from "../services/pipeline-state.service.js";
import { getPnlSimulation } from "../services/pnl-simulation.service.js";
import { getGenieDeepDive } from "../services/genie-deepdive.service.js";
import {
  forceRatification,
  previewNewsEnrichment,
  reenrichNews,
  injectSentimentShock,
  forceIndicators,
  FORCE_INDICATORS_TIMEFRAMES,
  FORCE_INDICATORS_EXCHANGES,
} from "../services/admin-debug.service.js";
import { listRuleStatuses, setManualOverride } from "../services/rule-status.service.js";

const admin = new Hono();

admin.use("*", requireAuth);
admin.use("*", requireAdmin);

admin.get("/status", async (c) => c.json({ success: true, data: await getStatus() }));

// Whitelist of supported timeframes — must match what the candle ingestion
// writes to the `quantara-{env}-candles` table. Anything outside this set is
// rejected so callers can't probe for arbitrary partition keys.
const SUPPORTED_TIMEFRAMES = ["1m", "15m", "1h", "4h", "1d", "1w"] as const;
type SupportedTimeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

admin.get("/market", async (c) => {
  const pair = c.req.query("pair") ?? "BTC/USDT";
  const exchange = c.req.query("exchange") ?? "binanceus";
  const tfRaw = c.req.query("timeframe") ?? "1m";
  if (!(SUPPORTED_TIMEFRAMES as readonly string[]).includes(tfRaw)) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: `timeframe must be one of: ${SUPPORTED_TIMEFRAMES.join(", ")}`,
        },
      },
      400,
    );
  }
  const timeframe = tfRaw as SupportedTimeframe;
  const limitRaw = c.req.query("limit");
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 60;
  if (Number.isNaN(limit) || limit < 1 || limit > 500) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "limit must be between 1 and 500" },
      },
      400,
    );
  }
  // Optional `before` param for lazy backfill: return candles whose openTime
  // is strictly before this millisecond timestamp. When omitted, returns the
  // most recent `limit` candles (existing behaviour — backwards compatible).
  const beforeRaw = c.req.query("before");
  let beforeMs: number | undefined;
  if (beforeRaw !== undefined) {
    beforeMs = parseInt(beforeRaw, 10);
    if (!Number.isInteger(beforeMs) || beforeMs <= 0) {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "before must be a positive integer (ms epoch)" },
        },
        400,
      );
    }
  }
  return c.json({
    success: true,
    data: await getMarket(pair, exchange, timeframe, limit, beforeMs),
  });
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

admin.get("/pipeline-health", async (c) => {
  const windowHoursRaw = c.req.query("windowHours");
  let windowHours = 24;
  if (windowHoursRaw !== undefined) {
    const parsed = parseInt(windowHoursRaw, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 168) {
      return c.json(
        {
          success: false,
          error: {
            code: "BAD_REQUEST",
            message: "windowHours must be an integer between 1 and 168",
          },
        },
        400,
      );
    }
    windowHours = parsed;
  }
  const data = await getPipelineHealth(windowHours);
  return c.json({ success: true, data });
});

admin.get("/news", async (c) => {
  const limitRaw = c.req.query("limit") ?? "50";
  const limit = parseInt(limitRaw, 10);
  if (isNaN(limit) || limit < 1 || limit > 200) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "limit must be between 1 and 200" },
      },
      400,
    );
  }
  const cursor = c.req.query("cursor");
  return c.json({ success: true, data: await getNews(limit, cursor) });
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

// Allowed timeframes reused for pnl-simulation (same blended TF set).
admin.get("/pnl-simulation", async (c) => {
  // --- since ---
  const sinceRaw = c.req.query("since");
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

  // --- pair ---
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

  // --- timeframe ---
  const timeframeRaw = c.req.query("timeframe");
  if (
    timeframeRaw !== undefined &&
    !(VALID_TIMEFRAMES as readonly string[]).includes(timeframeRaw)
  ) {
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

  // --- positionSize ---
  const positionSizeRaw = c.req.query("positionSize");
  let positionSizeUsd: number | undefined;
  if (positionSizeRaw !== undefined) {
    positionSizeUsd = parseFloat(positionSizeRaw);
    if (!isFinite(positionSizeUsd) || positionSizeUsd <= 0) {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "positionSize must be a positive number" },
        },
        400,
      );
    }
  }

  // --- feeBps ---
  const feeBpsRaw = c.req.query("feeBps");
  let feeBps: number | undefined;
  if (feeBpsRaw !== undefined) {
    feeBps = parseFloat(feeBpsRaw);
    if (!isFinite(feeBps) || feeBps < 0) {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "feeBps must be a non-negative number" },
        },
        400,
      );
    }
  }

  // --- direction ---
  const directionRaw = c.req.query("direction");
  let direction: "both" | "long" | "short" | undefined;
  if (directionRaw !== undefined) {
    if (directionRaw !== "both" && directionRaw !== "long" && directionRaw !== "short") {
      return c.json(
        {
          success: false,
          error: { code: "BAD_REQUEST", message: "direction must be one of: both, long, short" },
        },
        400,
      );
    }
    direction = directionRaw;
  }

  const result = await getPnlSimulation({
    since: sinceCanon,
    pair: pairRaw,
    timeframe: timeframeRaw,
    positionSizeUsd,
    feeBps,
    direction,
  });
  return c.json({ success: true, data: result });
});

admin.get("/genie-deepdive", async (c) => {
  const sinceRaw = c.req.query("since");
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

  const data = await getGenieDeepDive(sinceCanon, pair, timeframe);
  return c.json({ success: true, data });
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
 * POST /api/admin/debug/preview-news-enrichment
 * Body: { newsId }
 * Re-runs Phase 5a enrichment (pair-tagging + sentiment) for the article
 * in-memory and returns the recomputed result. Read-only diff tool — does
 * not overwrite the stored row. Server-side idempotency: duplicate requests
 * within 60s for the same (admin user, newsId) collapse to 409.
 */
admin.post("/debug/preview-news-enrichment", async (c) => {
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

  const result = await previewNewsEnrichment({
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
            "Duplicate preview-news-enrichment within 60s window for the same (user, newsId). The first request is still processing.",
        },
      },
      409,
    );
  }

  return c.json({ success: true, data: result });
});

/**
 * POST /api/admin/debug/reenrich-news
 * Body: { newsId, publishedAt }
 * Resets the news_events row status to "raw" and publishes a message to the
 * enrichment SQS queue so the enrichment Lambda re-processes the article and
 * overwrites the stored enrichment fields. Async — re-enrichment typically
 * completes within seconds. Server-side idempotency: duplicate requests within
 * 60s for the same (admin user, newsId) collapse to 409.
 */
admin.post("/debug/reenrich-news", async (c) => {
  const body = await c.req.json<{ newsId?: unknown; publishedAt?: unknown }>();
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

  if (typeof body.publishedAt !== "string" || body.publishedAt.trim() === "") {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "publishedAt must be a non-empty string" },
      },
      400,
    );
  }
  // publishedAt is a DDB sort key. Reject anything that isn't a parseable
  // date — without this, a typo (e.g. "yesterday") is forwarded to DDB and
  // would create a phantom row via the default UpdateCommand-creates-if-
  // missing behavior. The service-layer ConditionExpression catches it too,
  // but failing fast at the route gives a cleaner 400 instead of a 500.
  if (!Number.isFinite(Date.parse(body.publishedAt))) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: "publishedAt must be a valid ISO 8601 date string",
        },
      },
      400,
    );
  }

  const result = await reenrichNews({
    newsId: body.newsId.trim(),
    publishedAt: body.publishedAt.trim(),
    userId: auth.userId,
  });

  if (result.duplicate) {
    return c.json(
      {
        success: false,
        error: {
          code: "DUPLICATE_REQUEST",
          message:
            "Duplicate reenrich-news within 60s window for the same (user, newsId). The first request is still processing.",
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

// ---------------------------------------------------------------------------
// GET /api/admin/activity
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/activity?limit=100
 *
 * Returns the most recent N pipeline events aggregated across signal-history,
 * ratifications, news-events (enriched), and indicator-state. The response
 * shape matches the WS `PipelineEvent` union so the frontend can use the same
 * rendering path for both historical backfill and live events.
 *
 * Default limit: 100. Max: 500.
 */
admin.get("/activity", async (c) => {
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

  const data = await getActivity(limit);
  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /api/admin/signals-shadow
// Issue #133: query shadow signals from signals-collection (1m/5m data collection)
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/signals-shadow?pair=BTC/USDT&timeframe=1m&since=ISO&limit=100
 *
 * Returns shadow signals from the signals-collection table written by the
 * indicator-handler-shadow Lambda. These are 1m/5m signals produced without
 * LLM ratification and without WebSocket fanout — for data analysis only.
 *
 * Each row includes a `shadow: true` field so the UI can render a "shadow"
 * badge to distinguish these from production signals.
 *
 * Params:
 *   - pair       (optional) — one of the supported PAIRS; omit to query all pairs
 *   - timeframe  (optional) — "1m" or "5m"; omit to query both
 *   - since      (optional) — ISO 8601 date; defaults to last 24h
 *   - limit      (optional) — 1–500; default 100
 */
const SHADOW_TIMEFRAMES_VALID = ["1m", "5m"] as const;

admin.get("/signals-shadow", async (c) => {
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

  const timeframeRaw = c.req.query("timeframe");
  if (
    timeframeRaw !== undefined &&
    !(SHADOW_TIMEFRAMES_VALID as readonly string[]).includes(timeframeRaw)
  ) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: `timeframe must be one of: ${SHADOW_TIMEFRAMES_VALID.join(", ")}`,
        },
      },
      400,
    );
  }

  const sinceRaw = c.req.query("since");
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

  const signals = await getShadowSignals({
    pair: pairRaw,
    timeframe: timeframeRaw,
    since: sinceCanon,
    limit,
  });

  return c.json({ success: true, data: { signals } });
});

/**
 * POST /api/admin/debug/force-indicators
 * Body (targeted): { pair: string, exchange: string, timeframe: string }
 * Body (bulk):     { all: true }
 *
 * Triggers an immediate recompute of IndicatorState for one or more
 * (pair, exchange, timeframe) tuples by invoking the indicator-handler Lambda
 * with a synthetic DynamoDBStreamEvent. Useful after a candle backfill run
 * when the indicator Lambda's DDB Streams FilterCriteria (source="live") has
 * correctly filtered out the backfill writes, leaving IndicatorState stale.
 *
 * Auth: requireAuth + requireAdmin (matches other /debug/* endpoints).
 * Returns: { results: Array<{ pair, exchange, timeframe, ok, error? }> }
 *
 * Issue #288.
 */
admin.post("/debug/force-indicators", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  // Bulk mode: { all: true }
  if (body.all === true) {
    const result = await forceIndicators({ all: true });
    return c.json({ success: true as const, data: result });
  }

  // Targeted mode: { pair, exchange, timeframe }
  const { pair, exchange, timeframe } = body;

  if (typeof pair !== "string" || !(PAIRS as readonly string[]).includes(pair)) {
    return c.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: `pair must be one of: ${PAIRS.join(", ")}` },
      },
      400,
    );
  }

  if (
    typeof timeframe !== "string" ||
    !(FORCE_INDICATORS_TIMEFRAMES as readonly string[]).includes(timeframe)
  ) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: `timeframe must be one of: ${FORCE_INDICATORS_TIMEFRAMES.join(", ")}`,
        },
      },
      400,
    );
  }

  if (
    typeof exchange !== "string" ||
    !(FORCE_INDICATORS_EXCHANGES as readonly string[]).includes(exchange)
  ) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: `exchange must be one of: ${FORCE_INDICATORS_EXCHANGES.join(", ")}`,
        },
      },
      400,
    );
  }

  const result = await forceIndicators({
    pair,
    exchange: exchange as (typeof FORCE_INDICATORS_EXCHANGES)[number],
    timeframe: timeframe as (typeof FORCE_INDICATORS_TIMEFRAMES)[number],
  });
  return c.json({ success: true as const, data: result });
});

// ---------------------------------------------------------------------------
// GET /api/admin/rule-status
// Phase 8 §10.10: list all rule lifecycle status rows from the rule_status table.
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/rule-status
 *
 * Returns all rule_status rows (≤280 entries — one per (rule, pair, TF) bucket).
 * Each row includes status, brier, n, highBrierWindows, disabledAt, and
 * manualOverrideUntil so the admin can see the current lifecycle state.
 *
 * Auth: requireAuth + requireAdmin.
 */
admin.get("/rule-status", async (c) => {
  const items = await listRuleStatuses();
  return c.json({ success: true as const, data: { items } });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/rule-status/:key
// Phase 8 §10.10: set manual-override / re-enable a specific bucket.
// ---------------------------------------------------------------------------

/**
 * PATCH /api/admin/rule-status/:key
 *
 * Upserts a rule_status row. The `:key` path param is the composite pk
 * (`{rule}#{pair}#{TF}`, URL-encoded). Allows an admin to:
 *   - Set status="manual-override" (prevents auto-disable by the prune job)
 *   - Set status="enabled" (clears a previous disable or override)
 *   - Set status="disabled" (manual disable — rare but supported)
 *
 * Body: { status: "manual-override" | "enabled" | "disabled", reason?: string, manualOverrideUntil?: string }
 *
 * Auth: requireAuth + requireAdmin.
 */
const VALID_OVERRIDE_STATUSES = ["manual-override", "enabled", "disabled"] as const;

admin.patch("/rule-status/:key", async (c) => {
  const key = c.req.param("key");
  if (!key || key.trim() === "") {
    return c.json(
      { success: false, error: { code: "BAD_REQUEST", message: "key path param is required" } },
      400,
    );
  }
  const pk = decodeURIComponent(key);

  // Validate pk structure: must be "{rule}#{pair}#{TF}" (two "#" separators).
  const parts = pk.split("#");
  if (parts.length < 3) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: "key must be a composite pk in the form {rule}#{pair}#{TF}",
        },
      },
      400,
    );
  }

  const body = await c.req.json<Record<string, unknown>>();
  const auth = c.get("auth");

  const { status, reason, manualOverrideUntil } = body;

  if (
    typeof status !== "string" ||
    !(VALID_OVERRIDE_STATUSES as readonly string[]).includes(status)
  ) {
    return c.json(
      {
        success: false,
        error: {
          code: "BAD_REQUEST",
          message: `status must be one of: ${VALID_OVERRIDE_STATUSES.join(", ")}`,
        },
      },
      400,
    );
  }

  if (reason !== undefined && typeof reason !== "string") {
    return c.json(
      { success: false, error: { code: "BAD_REQUEST", message: "reason must be a string" } },
      400,
    );
  }

  if (manualOverrideUntil !== undefined) {
    if (typeof manualOverrideUntil !== "string" || isNaN(Date.parse(manualOverrideUntil))) {
      return c.json(
        {
          success: false,
          error: {
            code: "BAD_REQUEST",
            message: "manualOverrideUntil must be a valid ISO 8601 date string",
          },
        },
        400,
      );
    }
  }

  const record = await setManualOverride({
    pk,
    status: status as (typeof VALID_OVERRIDE_STATUSES)[number],
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof manualOverrideUntil === "string" ? { manualOverrideUntil } : {}),
    updatedBy: auth.userId,
  });

  return c.json({ success: true as const, data: { record } });
});

export { admin };
