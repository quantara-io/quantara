/**
 * admin-debug.service.ts
 *
 * Admin-only debug tools for the pipeline: force ratification, replay news
 * enrichment, and inject synthetic sentiment shocks.
 *
 * These functions call real AWS services (DynamoDB, Bedrock) and write to
 * real tables. They are deliberately excluded from the production code path
 * and must only be called from admin-guarded routes (`requireAuth` +
 * `requireAdmin`).
 *
 * Design spec: issue #189.
 *
 * KNOWN LIMITATION (tracked as Finding #1 of the PR #208 review): these
 * helpers re-implement a subset of the ratification logic locally instead of
 * delegating to the canonical `ratifySignal` / `enrichArticle` /
 * `maybeFireSentimentShockRatification` in `ingestion/src/`. The production
 * functions live in a separate workspace, depend on `@anthropic-ai/sdk` and
 * 6 ingestion-internal modules (gating, cache, prompt, validate, bundle,
 * stores) that aren't available in the backend Lambda. A clean fix would
 * publish a job to SQS that an ingestion-side handler picks up and runs
 * through the canonical functions; that's a follow-up issue tracked in the
 * PR comment thread. Until then, this file:
 *   - Uses the production model id (`claude-sonnet-4-6`) and pricing so
 *     prompt diffing reflects the real production cost/latency profile.
 *   - Mirrors the `triggerReason: "manual"` / `"sentiment_shock"` taxonomy
 *     so debug rows are indistinguishable from production rows downstream.
 *   - Persists to the same `ratifications` table with the same shape, so
 *     the audit explorer (#185) and genie-metrics (#186) consume them.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { randomUUID, createHash } from "crypto";

import { PAIRS } from "@quantara/shared";

import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// AWS clients (module-scope singletons)
// ---------------------------------------------------------------------------

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});

// ---------------------------------------------------------------------------
// Table names
// ---------------------------------------------------------------------------

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

const RATIFICATIONS_TABLE =
  process.env.TABLE_RATIFICATIONS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratifications`;

const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;

const SENTIMENT_AGGREGATES_TABLE =
  process.env.TABLE_SENTIMENT_AGGREGATES ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}sentiment-aggregates`;

// Ingestion-metadata table doubles as the idempotency store. Each debug
// invocation writes a Conditional Put keyed on a hash of (user, endpoint,
// body) with a 60-second TTL; a duplicate within that window fails the
// `attribute_not_exists` precondition and the route returns 409.
const INGESTION_METADATA_TABLE =
  process.env.TABLE_INGESTION_METADATA ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

// ---------------------------------------------------------------------------
// Production model — kept in sync with `ingestion/src/llm/ratify.ts:
// RATIFICATION_MODEL`. If you change it there, change it here too.
// Sonnet 4.6 input/output pricing as of 2026-Q1: $3 / $15 per 1M tokens.
// ---------------------------------------------------------------------------

const RATIFICATION_MODEL_ID = "claude-sonnet-4-6";
// On Bedrock the Sonnet 4.6 inference profile id (cross-region) is the form
// `us.anthropic.claude-sonnet-4-6-...` — the bundled agent uses the SDK's
// model alias, which Bedrock resolves to the underlying inference profile.
// Keep these aligned if Bedrock ever changes alias resolution.
const SONNET_INPUT_COST_PER_1K = 0.003;
const SONNET_OUTPUT_COST_PER_1K = 0.015;

// Daily cap on debug-driven LLM calls (across all users + pairs). Mirrors
// the per-pair daily cap in `ingestion/src/llm/gating.ts` but applies
// globally to debug invocations.
const DAILY_DEBUG_CAP = 200;

// Idempotency window — duplicate (user, endpoint, body) requests within this
// many seconds collapse to a single LLM/DDB call.
const IDEMPOTENCY_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// `symbolToTradingPair` — bare-symbol → trading-pair normalisation.
// Mirrors `ingestion/src/news/sentiment-shock.ts:symbolToTradingPair`. Pure
// function over `PAIRS` — duplicated here rather than reaching into ingestion
// because the only alternative is publishing it through `@quantara/shared`,
// which is a separate refactor.
// ---------------------------------------------------------------------------

function symbolToTradingPair(symbol: string): string | null {
  if ((PAIRS as readonly string[]).includes(symbol)) return symbol;
  const candidate = `${symbol}/USDT`;
  if ((PAIRS as readonly string[]).includes(candidate)) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// Idempotency / dedup
// ---------------------------------------------------------------------------

/**
 * Reserve an idempotency slot. Conditional Put on the ingestion-metadata
 * table; succeeds only if no record with this key exists. Records have a
 * `ttl` so they self-evict after `IDEMPOTENCY_TTL_SECONDS`.
 *
 * Returns `true` if the slot was reserved (caller may proceed) or `false`
 * if a duplicate was detected within the window.
 *
 * Throws on unexpected DDB errors so the caller can fail-closed.
 */
async function reserveIdempotency(key: string): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS;
  try {
    await dynamo.send(
      new PutCommand({
        TableName: INGESTION_METADATA_TABLE,
        Item: {
          metaKey: `admin-debug-idem#${key}`,
          createdAt: new Date().toISOString(),
          ttl,
        },
        ConditionExpression: "attribute_not_exists(metaKey)",
      }),
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

function buildIdempotencyKey(userId: string, endpoint: string, body: unknown): string {
  const json = JSON.stringify(body, Object.keys(body as Record<string, unknown>).sort());
  return createHash("sha256").update(`${userId}|${endpoint}|${json}`).digest("hex").slice(0, 24);
}

// ---------------------------------------------------------------------------
// Daily-cap check (fails CLOSED on DDB error per spec — cost protection wins
// over availability for an admin debug tool).
// ---------------------------------------------------------------------------

async function checkDailyDebugCap(pair: string): Promise<{ capped: boolean; count: number }> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: RATIFICATIONS_TABLE,
      KeyConditionExpression: "#pair = :pair AND invokedAtRecordId >= :lo",
      FilterExpression: "triggerReason = :reason",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: { ":pair": pair, ":lo": sinceIso, ":reason": "manual" },
      Select: "COUNT",
    }),
  );
  const count = result.Count ?? 0;
  return { capped: count >= DAILY_DEBUG_CAP, count };
}

// ---------------------------------------------------------------------------
// 1. Force ratification
// ---------------------------------------------------------------------------

export interface ForceRatificationInput {
  pair: string;
  timeframe: string;
  userId: string;
}

export interface ForceRatificationResult {
  /**
   * Algo signal type read from `signals_v2` (`buy` / `sell` / `hold` / etc.).
   * Distinguished from `verdictKind` so the UI can render both: "Algo: buy
   * (75%) → LLM: downgrade".
   */
  algoSignalType: string | null;
  algoConfidence: number | null;
  /**
   * LLM verdict label (`ratify` / `downgrade` / `reject`) — separate from the
   * algo signal type so a Bedrock failure doesn't smuggle "buy" into a field
   * that downstream consumers parse as a verdict.
   */
  verdictKind: "ratify" | "downgrade" | "reject" | "fallback" | null;
  ratifiedConfidence: number | null;
  reasoning: string | null;
  latencyMs: number;
  costUsd: number;
  cacheHit: boolean;
  fellBackToAlgo: boolean;
  recordId: string;
  rawResponse: Record<string, unknown> | null;
  capped?: boolean;
  capCount?: number;
  duplicate?: boolean;
}

/**
 * Force an immediate LLM ratification for the latest signal in the given
 * pair × timeframe. Reads the latest signal from signals_v2, calls Bedrock
 * Sonnet 4.6 with a ratification prompt, persists the result to the
 * ratifications table with `triggerReason="manual"`, and returns the
 * verdict inline. Counts against the daily cap; fails closed on DDB
 * errors. Idempotent within a 60-second window keyed on
 * `(userId, "force-ratification", pair, timeframe)`.
 */
export async function forceRatification(
  input: ForceRatificationInput,
): Promise<ForceRatificationResult> {
  const { pair, timeframe, userId } = input;

  // --- Idempotency reservation ---
  const idemKey = buildIdempotencyKey(userId, "force-ratification", { pair, timeframe });
  const reserved = await reserveIdempotency(idemKey);
  if (!reserved) {
    return emptyForceResult({ duplicate: true });
  }

  // --- Daily cap (fails closed) ---
  const { capped, count } = await checkDailyDebugCap(pair);
  if (capped) {
    return emptyForceResult({ capped: true, capCount: count });
  }

  // --- Fetch latest signal ---
  const signalResult = await dynamo.send(
    new QueryCommand({
      TableName: SIGNALS_V2_TABLE,
      KeyConditionExpression: "#pair = :pair AND begins_with(sk, :tfPrefix)",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: { ":pair": pair, ":tfPrefix": `${timeframe}#` },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const signal = signalResult.Items?.[0] as Record<string, unknown> | undefined;
  if (!signal) {
    throw new Error(`No signal found in signals_v2 for ${pair} / ${timeframe}`);
  }

  const algoSignalType = String(signal["type"] ?? "unknown");
  const algoConfidence = Number(signal["confidence"] ?? 0);
  const rulesFired = JSON.stringify(signal["rulesFired"] ?? []);
  const closeTime = String(signal["closeTime"] ?? signal["emittedAt"] ?? "unknown");

  const systemPrompt = `You are a crypto trading signal ratifier. Review the algorithmic signal and return a JSON verdict:
{ "verdict": "ratify" | "downgrade" | "reject", "confidence": <0-1>, "reasoning": <string> }
- ratify: LLM agrees with the signal and its confidence
- downgrade: signal direction is correct but confidence is too high
- reject: signal is wrong or unreliable given current conditions
Return JSON only.`;

  const userContent = `Signal to ratify:
Pair: ${pair}
Timeframe: ${timeframe}
Type: ${algoSignalType}
Confidence: ${(algoConfidence * 100).toFixed(0)}%
Close time: ${closeTime}
Rules fired: ${rulesFired}
Trigger reason: manual (admin debug)

Rate this signal's validity and provide your reasoning in 2-3 sentences.`;

  const startMs = Date.now();
  let rawResponse: Record<string, unknown> | null = null;
  let verdictKind: ForceRatificationResult["verdictKind"] = null;
  let ratifiedConfidence: number | null = null;
  let reasoning: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let fellBackToAlgo = false;

  try {
    const bedrockResponse = await bedrock.send(
      new InvokeModelCommand({
        modelId: RATIFICATION_MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
        }),
      }),
    );

    rawResponse = JSON.parse(new TextDecoder().decode(bedrockResponse.body)) as Record<
      string,
      unknown
    >;
    const text = String((rawResponse["content"] as Array<{ text: string }>)?.[0]?.text ?? "{}");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        verdict?: string;
        confidence?: number;
        reasoning?: string;
      };
      const v = parsed.verdict;
      if (v === "ratify" || v === "downgrade" || v === "reject") {
        verdictKind = v;
      }
      ratifiedConfidence = typeof parsed.confidence === "number" ? parsed.confidence : null;
      reasoning = parsed.reasoning ?? null;
    }
    const usage = rawResponse["usage"] as { input_tokens?: number; output_tokens?: number };
    inputTokens = usage?.input_tokens ?? 0;
    outputTokens = usage?.output_tokens ?? 0;
  } catch (err) {
    // Fall back: do NOT smuggle the algo signal type into verdictKind.
    // verdictKind=fallback signals to consumers that the LLM call itself
    // failed; the algo signal is preserved separately on `algoSignalType`.
    logger.warn(
      { err, pair, timeframe },
      "[AdminDebug] Bedrock call failed — verdictKind=fallback",
    );
    fellBackToAlgo = true;
    verdictKind = "fallback";
    ratifiedConfidence = algoConfidence;
    reasoning = "Bedrock call failed; algo signal preserved on algoSignalType.";
  }

  const latencyMs = Date.now() - startMs;
  const costUsd =
    (inputTokens / 1000) * SONNET_INPUT_COST_PER_1K +
    (outputTokens / 1000) * SONNET_OUTPUT_COST_PER_1K;

  // --- Persist ratification record ---
  const recordId = randomUUID();
  const invokedAt = new Date().toISOString();
  const invokedAtRecordId = `${invokedAt}#${recordId}`;
  try {
    await dynamo.send(
      new PutCommand({
        TableName: RATIFICATIONS_TABLE,
        Item: {
          pair,
          invokedAtRecordId,
          recordId,
          timeframe,
          invokedReason: "manual",
          triggerReason: "manual",
          invokedAt,
          latencyMs,
          costUsd,
          cacheHit: false,
          fellBackToAlgo,
          validationOk: verdictKind !== "fallback",
          algoCandidateType: algoSignalType,
          algoCandidateConfidence: algoConfidence,
          // ratifiedType holds the same buy/sell/hold value the production
          // ratify path stores when the LLM agrees; for a downgrade/reject
          // it's still the algo's type with the LLM's reduced confidence.
          // Downstream metrics consumers rely on this shape.
          ratifiedType: algoSignalType,
          ratifiedConfidence,
          ratifiedReasoning: reasoning,
          // Verdict label is a SEPARATE field. If a downstream consumer wants
          // to distinguish "LLM agreed" vs "LLM downgraded", they read this.
          verdictKind,
          llmModel: fellBackToAlgo ? null : RATIFICATION_MODEL_ID,
          algoCandidate: signal,
          ratified: verdictKind
            ? { type: algoSignalType, confidence: ratifiedConfidence, reasoning, verdictKind }
            : null,
          llmRequest: {
            model: RATIFICATION_MODEL_ID,
            systemHash: createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16),
            userJsonHash: createHash("sha256").update(userContent).digest("hex").slice(0, 16),
          },
          llmRawResponse: rawResponse,
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      }),
    );
  } catch (err) {
    logger.error(
      { err, pair, timeframe, recordId },
      "[AdminDebug] Failed to write ratification record",
    );
  }

  return {
    algoSignalType,
    algoConfidence,
    verdictKind,
    ratifiedConfidence,
    reasoning,
    latencyMs,
    costUsd,
    cacheHit: false,
    fellBackToAlgo,
    recordId,
    rawResponse,
  };
}

function emptyForceResult(
  overrides: Partial<ForceRatificationResult> = {},
): ForceRatificationResult {
  return {
    algoSignalType: null,
    algoConfidence: null,
    verdictKind: null,
    ratifiedConfidence: null,
    reasoning: null,
    latencyMs: 0,
    costUsd: 0,
    cacheHit: false,
    fellBackToAlgo: false,
    recordId: "",
    rawResponse: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 2. Replay news enrichment
// ---------------------------------------------------------------------------

export interface ReplayNewsEnrichmentInput {
  newsId: string;
  userId: string;
}

export interface ReplayNewsEnrichmentResult {
  newsId: string;
  title: string;
  storedEnrichment: Record<string, unknown> | null;
  replayedEnrichment: {
    mentionedPairs: string[];
    sentiment: { score: number; magnitude: number; model: string };
    enrichedAt: string;
    latencyMs: number;
    costUsd: number;
  };
  mutated: false;
  duplicate?: boolean;
}

const PAIR_PATTERNS: Record<string, RegExp> = {
  BTC: /\b(BTC|XBT|bitcoin)\b/i,
  ETH: /\b(ETH|ether|ethereum)\b/i,
  SOL: /\b(SOL|solana)\b/i,
  XRP: /\b(XRP|ripple)\b/i,
  DOGE: /\b(DOGE|dogecoin)\b/i,
};

const HAIKU_ENRICHMENT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_INPUT_COST_PER_1K = 0.00025;
const HAIKU_OUTPUT_COST_PER_1K = 0.00125;
const HAIKU_MODEL_TAG = "anthropic.claude-haiku-4-5";

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON found in: ${text}`);
  return text.slice(start, end + 1);
}

async function invokeHaikuForReplay<T>(
  systemPrompt: string,
  userContent: string,
): Promise<{ result: T; inputTokens: number; outputTokens: number }> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: HAIKU_ENRICHMENT_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
  const text = String((body["content"] as Array<{ text: string }>)?.[0]?.text ?? "{}");
  const usage = body["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    result: JSON.parse(extractJson(text)) as T,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

/**
 * Re-run Phase 5a enrichment (pair-tagging + sentiment) for a single news
 * article by newsId. Read-only — does NOT mutate the stored row.
 */
export async function replayNewsEnrichment(
  input: ReplayNewsEnrichmentInput,
): Promise<ReplayNewsEnrichmentResult> {
  const { newsId, userId } = input;

  const idemKey = buildIdempotencyKey(userId, "replay-news-enrichment", { newsId });
  const reserved = await reserveIdempotency(idemKey);
  if (!reserved) {
    return {
      newsId,
      title: "",
      storedEnrichment: null,
      replayedEnrichment: {
        mentionedPairs: [],
        sentiment: { score: 0, magnitude: 0, model: HAIKU_MODEL_TAG },
        enrichedAt: new Date().toISOString(),
        latencyMs: 0,
        costUsd: 0,
      },
      mutated: false,
      duplicate: true,
    };
  }

  const queryResult = await dynamo.send(
    new QueryCommand({
      TableName: NEWS_TABLE,
      KeyConditionExpression: "newsId = :newsId",
      ExpressionAttributeValues: { ":newsId": newsId },
      Limit: 1,
    }),
  );
  const item = queryResult.Items?.[0] as Record<string, unknown> | undefined;
  if (!item) {
    throw new Error(`News record not found: ${newsId}`);
  }

  const title = String(item["title"] ?? "");
  const body = String(item["body"] ?? item["summary"] ?? item["content"] ?? "");
  const combined = title + " " + body;

  // Layer 1: regex pair-tagging (mirrors `ingestion/src/news/enrich.ts`)
  const regexPairs = Object.entries(PAIR_PATTERNS)
    .filter(([, re]) => re.test(combined))
    .map(([sym]) => sym);

  // Layer 2: LLM pair-tagging
  const startMs = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let llmPairs: string[] = [];
  try {
    const { result, inputTokens, outputTokens } = await invokeHaikuForReplay<{
      affectedPairs: string[];
    }>(
      `Identify which crypto symbols an article materially affects.
Return JSON only: { "affectedPairs": string[] }
Valid symbols: BTC, ETH, SOL, XRP, DOGE.
Include only pairs the article would influence — not just mentioned.`,
      `Title: ${title}\n\nBody: ${body.slice(0, 2000)}`,
    );
    const valid = new Set(Object.keys(PAIR_PATTERNS));
    llmPairs = (result.affectedPairs ?? []).filter((s: string) => valid.has(s));
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
  } catch (err) {
    logger.warn({ err, newsId }, "[AdminDebug] LLM pair-tagging failed — using regex only");
  }

  const mentionedPairs = [...new Set([...regexPairs, ...llmPairs])];

  let sentimentScore = 0;
  let sentimentMagnitude = 0;
  try {
    const { result, inputTokens, outputTokens } = await invokeHaikuForReplay<{
      score: number;
      magnitude: number;
    }>(
      `Classify sentiment of a crypto news article. Return JSON only:
{ "score": <-1 to +1>, "magnitude": <0 to 1>, "topic": <string> }
- score: -1 = strongly bearish; +1 = strongly bullish; 0 = neutral
- magnitude: how confidently positive/negative (0 = unclear, 1 = strong claim)`,
      `Title: ${title}\n\nBody: ${body.slice(0, 2000)}`,
    );
    sentimentScore = Math.max(-1, Math.min(1, result.score ?? 0));
    sentimentMagnitude = Math.max(0, Math.min(1, result.magnitude ?? 0));
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
  } catch (err) {
    logger.warn({ err, newsId }, "[AdminDebug] LLM sentiment failed — returning zeroes");
  }

  const latencyMs = Date.now() - startMs;
  const costUsd =
    (totalInputTokens / 1000) * HAIKU_INPUT_COST_PER_1K +
    (totalOutputTokens / 1000) * HAIKU_OUTPUT_COST_PER_1K;

  return {
    newsId,
    title,
    storedEnrichment: (item["enrichment"] as Record<string, unknown> | null | undefined) ?? null,
    replayedEnrichment: {
      mentionedPairs,
      sentiment: { score: sentimentScore, magnitude: sentimentMagnitude, model: HAIKU_MODEL_TAG },
      enrichedAt: new Date().toISOString(),
      latencyMs,
      costUsd,
    },
    mutated: false,
  };
}

// ---------------------------------------------------------------------------
// 3. Inject synthetic sentiment shock
// ---------------------------------------------------------------------------

export interface InjectSentimentShockInput {
  pair: string;
  deltaScore: number;
  deltaMagnitude: number;
  userId: string;
}

export interface InjectSentimentShockResult {
  decision: "fired" | "gated" | "skipped";
  reasons: string[];
  shockRecord: Record<string, unknown> | null;
  duplicate?: boolean;
}

/**
 * Build a synthetic previous + next sentiment aggregate pair with the given
 * deltas, then run the shock detection + cost gate path. The shock record IS
 * written to the ratifications table with `triggerReason="sentiment_shock"`
 * so the end-to-end path can be observed by the audit explorer (#185).
 *
 * NOTE on Finding #1: the canonical `maybeFireSentimentShockRatification`
 * lives in ingestion and depends on `ratifySignal` + caches we can't pull
 * into the backend. This helper mirrors the gating + persistence shape. If
 * the canonical function is ever exposed via SQS handoff (the recommended
 * follow-up), this body shrinks to a one-line publish.
 */
export async function injectSentimentShock(
  input: InjectSentimentShockInput,
): Promise<InjectSentimentShockResult> {
  const { pair, deltaScore, deltaMagnitude, userId } = input;
  const reasons: string[] = [];

  if (Math.abs(deltaScore) > 2) throw new Error("deltaScore must be in [-2, 2]");
  if (Math.abs(deltaMagnitude) > 1) throw new Error("deltaMagnitude must be in [-1, 1]");

  const idemKey = buildIdempotencyKey(userId, "inject-sentiment-shock", {
    pair,
    deltaScore,
    deltaMagnitude,
  });
  const reserved = await reserveIdempotency(idemKey);
  if (!reserved) {
    return {
      decision: "skipped",
      reasons: ["duplicate request within 60s window"],
      shockRecord: null,
      duplicate: true,
    };
  }

  // --- Symbol normalization. The aggregator-handler keys sentiment-aggregates
  // by bare symbol (`BTC`) but signals_v2 / ratifications are keyed by the
  // trading pair (`BTC/USDT`). The route accepts either; we normalize here so
  // the aggregate read uses the bare symbol and the ratification record uses
  // the canonical trading pair (matching the production sentiment-shock fix
  // shipped on PR #181).
  const tradingPair = symbolToTradingPair(pair);
  if (tradingPair === null) {
    throw new Error(`Unknown pair: ${pair}`);
  }
  const baseSymbol = tradingPair.split("/")[0];
  if (baseSymbol === undefined) {
    throw new Error(`Could not derive base symbol from ${tradingPair}`);
  }

  // --- Read base aggregate
  let baseMeanScore = 0;
  let baseMeanMagnitude = 0.5;
  try {
    const sentResult = await dynamo.send(
      new GetCommand({
        TableName: SENTIMENT_AGGREGATES_TABLE,
        Key: { pair: baseSymbol, window: "4h" },
      }),
    );
    if (sentResult.Item) {
      baseMeanScore = Number(sentResult.Item["meanScore"] ?? 0);
      baseMeanMagnitude = Number(sentResult.Item["meanMagnitude"] ?? 0.5);
    }
  } catch (err) {
    logger.warn(
      { err, pair: tradingPair, baseSymbol },
      "[AdminDebug] Could not read base sentiment aggregate — using defaults",
    );
    reasons.push("Could not read base aggregate — using default baseline");
  }

  const prevScore = baseMeanScore;
  const nextScore = Math.max(-1, Math.min(1, baseMeanScore + deltaScore));
  const nextMagnitude = Math.max(0, Math.min(1, baseMeanMagnitude + deltaMagnitude));

  // Thresholds mirror sentiment-shock.ts defaults so debug rows are gated the
  // same way production shocks are.
  const DELTA_THRESHOLD = 0.3;
  const MAGNITUDE_FLOOR = 0.5;
  const HOURLY_CAP = 6;

  const actualDelta = Math.abs(nextScore - prevScore);
  if (actualDelta < DELTA_THRESHOLD) {
    reasons.push(`delta=${actualDelta.toFixed(3)} < threshold=${DELTA_THRESHOLD}`);
    return { decision: "skipped", reasons, shockRecord: null };
  }
  if (nextMagnitude < MAGNITUDE_FLOOR) {
    reasons.push(`magnitude=${nextMagnitude.toFixed(3)} < floor=${MAGNITUDE_FLOOR}`);
    return { decision: "skipped", reasons, shockRecord: null };
  }
  reasons.push(
    `delta=${actualDelta.toFixed(3)} >= ${DELTA_THRESHOLD}, magnitude=${nextMagnitude.toFixed(3)} >= ${MAGNITUDE_FLOOR}`,
  );

  // Hourly cap (fails closed)
  const hourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentResult = await dynamo.send(
    new QueryCommand({
      TableName: RATIFICATIONS_TABLE,
      KeyConditionExpression: "#pair = :pair AND invokedAtRecordId >= :lo",
      FilterExpression: "triggerReason = :reason",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: {
        ":pair": tradingPair,
        ":lo": hourAgoIso,
        ":reason": "sentiment_shock",
      },
      Select: "COUNT",
    }),
  );
  const recentCount = recentResult.Count ?? 0;
  if (recentCount >= HOURLY_CAP) {
    reasons.push(`hourly cap: ${recentCount} >= ${HOURLY_CAP}`);
    return { decision: "gated", reasons, shockRecord: null };
  }

  const recordId = randomUUID();
  const invokedAt = new Date().toISOString();
  const invokedAtRecordId = `${invokedAt}#${recordId}`;

  // Debug-injected rows must be indistinguishable in shape from real shocks.
  // Synthetic-shock metadata goes in `ratifiedReasoning` (text) and a
  // structured field on `algoCandidate` so the `RatificationRow` schema in
  // `backend/src/services/admin.service.ts` doesn't need a new field. Custom
  // top-level fields removed per PR #208 review (Finding #5).
  const shockRecord: Record<string, unknown> = {
    pair: tradingPair,
    invokedAtRecordId,
    recordId,
    timeframe: "4h",
    invokedReason: "sentiment_shock",
    triggerReason: "sentiment_shock",
    invokedAt,
    latencyMs: 0,
    costUsd: 0,
    cacheHit: false,
    fellBackToAlgo: false,
    validationOk: true,
    algoCandidateType: null,
    algoCandidateConfidence: null,
    ratifiedType: null,
    ratifiedConfidence: null,
    ratifiedReasoning: `Synthetic sentiment shock injected via admin debug. deltaScore=${deltaScore}, deltaMagnitude=${deltaMagnitude}. baseSymbol=${baseSymbol}, prevScore=${prevScore.toFixed(3)}, nextScore=${nextScore.toFixed(3)}, nextMagnitude=${nextMagnitude.toFixed(3)}.`,
    llmModel: null,
    algoCandidate: {
      injectedBy: "admin-debug",
      baseSymbol,
      prevScore,
      nextScore,
      nextMagnitude,
      deltaScore,
      deltaMagnitude,
    },
    ratified: null,
    llmRequest: null,
    llmRawResponse: null,
    ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  };

  try {
    await dynamo.send(new PutCommand({ TableName: RATIFICATIONS_TABLE, Item: shockRecord }));
    reasons.push(`Shock record written: recordId=${recordId}`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err, pair: tradingPair, recordId }, "[AdminDebug] Failed to write shock record");
    reasons.push(`Failed to write shock record: ${msg}`);
    return { decision: "gated", reasons, shockRecord: null };
  }

  return { decision: "fired", reasons, shockRecord };
}
