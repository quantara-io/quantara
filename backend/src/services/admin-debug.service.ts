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
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID, createHash } from "crypto";

import { PAIRS } from "@quantara/shared";

import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// AWS clients (module-scope singletons)
// ---------------------------------------------------------------------------

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});
const lambdaClient = new LambdaClient({});

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

const CANDLES_TABLE =
  process.env.TABLE_CANDLES ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}candles`;

// ---------------------------------------------------------------------------
// Production model — kept in sync with `ingestion/src/llm/ratify.ts:
// RATIFICATION_MODEL`. If you change it there, change it here too.
// Sonnet 4.6 input/output pricing as of 2026-Q1: $3 / $15 per 1M tokens.
// ---------------------------------------------------------------------------

// Bedrock cross-region inference profile id for the ratification model.
// Default = Sonnet 4.6 (production behavior). Dev overrides via the
// `RATIFICATION_MODEL_ID` env var to use Haiku 4.5 (~12x cheaper) so
// debug iteration doesn't burn the Sonnet budget.
//
// Bedrock requires the inference-profile id, not the bare foundation-model
// id, for on-demand invocation of newer Anthropic models — a foundation-model
// id like `anthropic.claude-sonnet-4-6` resolves in the catalog but returns:
//
//   ValidationException: Invocation of model ID anthropic.claude-sonnet-4-6
//     with on-demand throughput isn't supported. Retry your request with
//     the ID or ARN of an inference profile that contains this model.
const DEFAULT_RATIFICATION_MODEL_ID = "us.anthropic.claude-sonnet-4-6";
const RATIFICATION_MODEL_ID = process.env.RATIFICATION_MODEL_ID ?? DEFAULT_RATIFICATION_MODEL_ID;

// Per-1K-token pricing keyed off the model family so cost accounting stays
// correct regardless of dev/prod override.
//   Sonnet 4.x: $3 in  / $15 out  per 1M tokens
//   Haiku 4.5:  $0.25 in / $1.25 out per 1M tokens (~12x cheaper)
const IS_HAIKU_MODEL = RATIFICATION_MODEL_ID.includes("haiku");
const RATIFICATION_INPUT_COST_PER_1K = IS_HAIKU_MODEL ? 0.00025 : 0.003;
const RATIFICATION_OUTPUT_COST_PER_1K = IS_HAIKU_MODEL ? 0.00125 : 0.015;

// Daily cap on debug-driven LLM calls — applied PER-PAIR (the cap query
// uses pair as the partition key). With 5 trading pairs this is up to 1000
// calls/day total, but each pair has its own 200-call ceiling so a noisy
// pair can't starve the others. Mirrors the per-pair daily cap pattern in
// `ingestion/src/llm/gating.ts`.
const DAILY_DEBUG_CAP = 200;

// Idempotency window — duplicate (user, endpoint, body) requests within this
// many seconds collapse to a single LLM/DDB call.
const IDEMPOTENCY_TTL_SECONDS = 60;

// Ratification record TTL. Aligned with ingestion/src/lib/ratification-store.ts
// so debug-injected rows expire on the same schedule as production rows.
const RATIFICATION_TTL_SECONDS = 30 * 24 * 60 * 60;

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
    (inputTokens / 1000) * RATIFICATION_INPUT_COST_PER_1K +
    (outputTokens / 1000) * RATIFICATION_OUTPUT_COST_PER_1K;

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
          // Canonical schema (matches ingestion/src/lib/ratification-store.ts).
          // toRatificationRow() in admin.service.ts reads `validation.ok` —
          // a top-level `validationOk` is invisible to it.
          validation:
            verdictKind === "fallback" ? { ok: false, reason: "bedrock_fallback" } : { ok: true },
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
          // Production convention: only real verdicts (ratify/downgrade/reject)
          // get a non-null `ratified`. Fallback rows have `ratified: null`,
          // `validation.ok: false`, `fellBackToAlgo: true` so downstream
          // consumers can't mistake a Bedrock failure for a successful verdict.
          ratified:
            verdictKind === "ratify" || verdictKind === "downgrade" || verdictKind === "reject"
              ? { type: algoSignalType, confidence: ratifiedConfidence, reasoning, verdictKind }
              : null,
          llmRequest: {
            model: RATIFICATION_MODEL_ID,
            systemHash: createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16),
            userJsonHash: createHash("sha256").update(userContent).digest("hex").slice(0, 16),
          },
          llmRawResponse: rawResponse,
          ttl: Math.floor(Date.now() / 1000) + RATIFICATION_TTL_SECONDS,
        },
      }),
    );
  } catch (err) {
    // Persistence is part of the contract — the admin UI surfaces `recordId`
    // as a clickable audit link, so silently logging+returning success would
    // hand the caller a recordId that doesn't exist in DDB. Re-throw so the
    // route returns 500 and the UI shows an explicit failure.
    logger.error(
      { err, pair, timeframe, recordId },
      "[AdminDebug] Failed to write ratification record",
    );
    throw err;
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
// 2. Preview news enrichment (read-only diff tool)
// ---------------------------------------------------------------------------

export interface PreviewNewsEnrichmentInput {
  newsId: string;
  userId: string;
}

export interface PreviewNewsEnrichmentResult {
  newsId: string;
  title: string;
  storedEnrichment: Record<string, unknown> | null;
  previewedEnrichment: {
    mentionedPairs: string[];
    sentiment: { score: number; magnitude: number; model: string };
    enrichedAt: string;
    latencyMs: number;
    costUsd: number;
  };
  mutated: false;
  duplicate?: boolean;
}

// ---------------------------------------------------------------------------
// Backwards-compat aliases (keep the old export names so existing callers and
// tests compile without changes — remove in a follow-up once all call-sites
// are updated).
// ---------------------------------------------------------------------------
/** @deprecated Use PreviewNewsEnrichmentInput */
export type ReplayNewsEnrichmentInput = PreviewNewsEnrichmentInput;
/** @deprecated Use PreviewNewsEnrichmentResult */
export type ReplayNewsEnrichmentResult = PreviewNewsEnrichmentResult;

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
 * Preview Phase 5a enrichment (pair-tagging + sentiment) for a single news
 * article by newsId. Read-only — does NOT mutate the stored row. Returns the
 * recomputed enrichment alongside the stored enrichment so the caller can diff
 * them in-place.
 */
export async function previewNewsEnrichment(
  input: PreviewNewsEnrichmentInput,
): Promise<PreviewNewsEnrichmentResult> {
  const { newsId, userId } = input;

  const idemKey = buildIdempotencyKey(userId, "preview-news-enrichment", { newsId });
  const reserved = await reserveIdempotency(idemKey);
  if (!reserved) {
    return {
      newsId,
      title: "",
      storedEnrichment: null,
      previewedEnrichment: {
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
      // news_events composite key is (newsId, publishedAt). When a single
      // newsId has multiple SK rows (rare but possible — e.g. an article
      // re-fetched before #180's stable-newsId fix landed), we want the
      // newest one. ScanIndexForward: false sorts SK descending.
      ScanIndexForward: false,
      // Strongly-consistent so a debug "replay-now" call sees a record
      // that was just stored by the news poller seconds ago.
      ConsistentRead: true,
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
    previewedEnrichment: {
      mentionedPairs,
      sentiment: { score: sentimentScore, magnitude: sentimentMagnitude, model: HAIKU_MODEL_TAG },
      enrichedAt: new Date().toISOString(),
      latencyMs,
      costUsd,
    },
    mutated: false,
  };
}

/** @deprecated Use previewNewsEnrichment — kept for backwards compatibility with existing callers */
export async function replayNewsEnrichment(
  input: ReplayNewsEnrichmentInput,
): Promise<ReplayNewsEnrichmentResult> {
  return previewNewsEnrichment(input);
}

// ---------------------------------------------------------------------------
// 3a. Re-enrich news (writes back to stored row)
// ---------------------------------------------------------------------------

export interface ReenrichNewsInput {
  newsId: string;
  publishedAt: string;
  userId: string;
}

export interface ReenrichNewsResult {
  newsId: string;
  messageId: string;
  hint: string;
  duplicate?: boolean;
}

/**
 * Reset the news_events row's status to "raw" so the enrichment Lambda's
 * early-return guard (`if (status === "enriched") continue;`) doesn't skip it,
 * then publish a message to the enrichment SQS queue to trigger re-enrichment.
 *
 * Idempotent within a 60-second window keyed on (userId, "reenrich-news",
 * newsId) — a second call within that window returns 409.
 *
 * IAM requirements (not yet wired — see tracking issue):
 *   - dynamodb:UpdateItem on news_events table
 *   - sqs:SendMessage on the enrichment queue
 */
export async function reenrichNews(input: ReenrichNewsInput): Promise<ReenrichNewsResult> {
  const { newsId, publishedAt, userId } = input;

  const idemKey = buildIdempotencyKey(userId, "reenrich-news", { newsId });
  const reserved = await reserveIdempotency(idemKey);
  if (!reserved) {
    return {
      newsId,
      messageId: "",
      hint: "",
      duplicate: true,
    };
  }

  // Reset status to "raw" so the enrichment Lambda's early-return guard
  // (`if (status === "enriched") continue;`) doesn't skip this article.
  // ConditionExpression: "attribute_exists(newsId)" prevents DDB's default
  // "create if missing" behavior from writing a phantom row when the caller
  // passes a typo'd newsId/publishedAt — the enrichment Lambda would then
  // dequeue an incomplete row and fail on missing fields. Surface the bad
  // input as a ConditionalCheckFailedException instead of corrupting state.
  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: NEWS_TABLE,
        Key: { newsId, publishedAt },
        UpdateExpression: "SET #status = :raw",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":raw": "raw" },
        ConditionExpression: "attribute_exists(newsId)",
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      throw new Error(
        `News article not found: newsId=${newsId} publishedAt=${publishedAt}. ` +
          `Verify both fields match an existing row.`,
      );
    }
    throw err;
  }

  // Send the article to the enrichment SQS queue.
  const ENRICHMENT_QUEUE_URL =
    process.env.ENRICHMENT_QUEUE_URL ??
    (() => {
      const prefix = (process.env.TABLE_PREFIX ?? "quantara-dev-").replace(/-$/, "");
      const region = process.env.AWS_REGION ?? "us-west-2";
      const accountId = process.env.AWS_ACCOUNT_ID ?? "";
      return `https://sqs.${region}.amazonaws.com/${accountId}/${prefix}-enrichment`;
    })();

  const sqsClient = new SQSClient({});
  const sqsResult = await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: ENRICHMENT_QUEUE_URL,
      MessageBody: JSON.stringify({
        type: "enrich_news",
        data: { newsId, publishedAt },
        timestamp: new Date().toISOString(),
      }),
    }),
  );

  const messageId = sqsResult.MessageId ?? "";
  logger.info({ newsId, messageId }, "[AdminDebug] reenrich-news: SQS message sent");

  return {
    newsId,
    messageId,
    hint: "Re-enrichment queued. Typically completes within seconds as the enrichment Lambda picks up the message.",
  };
}

// ---------------------------------------------------------------------------
// 3b. Inject synthetic sentiment shock
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
  // trading pair (`BTC/USDT`). The route validates the input against `PAIRS`
  // (trading pairs only — see `backend/src/routes/admin.ts`); we normalize
  // here defensively in case a caller bypasses the route or for tests, and
  // also derive the base symbol for the aggregate read (matching the
  // production sentiment-shock fix shipped on PR #181).
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
    // Canonical schema (matches ingestion/src/lib/ratification-store.ts) so
    // toRatificationRow() in admin.service.ts surfaces these correctly.
    validation: { ok: true },
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
    // 30-day TTL aligned with production ratifications table convention so
    // debug-injected rows don't expire earlier than real ratifications.
    ttl: Math.floor(Date.now() / 1000) + RATIFICATION_TTL_SECONDS,
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

// ---------------------------------------------------------------------------
// 4. Force indicators — recompute IndicatorState via Lambda invoke
//
// Triggers the indicator-handler Lambda with a synthetic DynamoDBStreamEvent
// so it refreshes IndicatorState without waiting for the next live bar close.
// This is the only viable path across the monorepo boundary (issue #209):
// the backend Lambda cannot import ingestion modules directly.
//
// For the synthetic record to pass the handler's source filter
// (`source === "live" || source === "live-synthesized"`), NewImage.source
// is set to "live". The quorum check in the handler (Step 2) will see the
// close-quorum entry from when the real candle landed — if quorum was never
// reached (e.g. a fresh backfill on a new pair) the handler will stop there.
// That is acceptable: we primarily need the IndicatorState row refreshed,
// which happens in Step 4 AFTER quorum. For the majority of backfill cases
// the quorum table will still have valid entries from the last live close.
// ---------------------------------------------------------------------------

// Signal timeframes supported by the indicator-handler (matches its filter).
export const FORCE_INDICATORS_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
export type ForceIndicatorsTimeframe = (typeof FORCE_INDICATORS_TIMEFRAMES)[number];

// Supported exchanges (mirrors ingestion/src/exchanges/config.ts).
export const FORCE_INDICATORS_EXCHANGES = ["binanceus", "coinbase", "kraken"] as const;
export type ForceIndicatorsExchange = (typeof FORCE_INDICATORS_EXCHANGES)[number];

export interface ForceIndicatorsTargetedInput {
  pair: string;
  exchange: ForceIndicatorsExchange;
  timeframe: ForceIndicatorsTimeframe;
}

export type ForceIndicatorsInput = ForceIndicatorsTargetedInput | { all: true };

export interface ForceIndicatorsResultItem {
  pair: string;
  exchange: string;
  timeframe: string;
  ok: boolean;
  error?: string;
}

export interface ForceIndicatorsResult {
  results: ForceIndicatorsResultItem[];
}

/**
 * Build the list of (pair, exchange, timeframe) tuples to invoke.
 * Targeted mode: single tuple. Bulk mode: cartesian product of all
 * PAIRS × EXCHANGES × TIMEFRAMES (~5 × 3 × 4 = 60 invocations).
 */
function buildTuples(
  input: ForceIndicatorsInput,
): Array<{ pair: string; exchange: string; timeframe: string }> {
  if ("all" in input && input.all) {
    const tuples: Array<{ pair: string; exchange: string; timeframe: string }> = [];
    for (const pair of PAIRS) {
      for (const exchange of FORCE_INDICATORS_EXCHANGES) {
        for (const timeframe of FORCE_INDICATORS_TIMEFRAMES) {
          tuples.push({ pair, exchange, timeframe });
        }
      }
    }
    return tuples;
  }

  return [
    {
      pair: (input as ForceIndicatorsTargetedInput).pair,
      exchange: (input as ForceIndicatorsTargetedInput).exchange,
      timeframe: (input as ForceIndicatorsTargetedInput).timeframe,
    },
  ];
}

/**
 * Build a synthetic DynamoDBStreamEvent that will pass the indicator-handler's
 * source + timeframe filters. The handler reads these fields from NewImage:
 *   pair, exchange, timeframe, closeTime, openTime, open, high, low, close,
 *   volume, symbol, source, force
 *
 * `closeTime` is the real closeTime from the most-recent candle for this
 * (pair, exchange, timeframe) — passed in from invokeIndicatorHandler after
 * a DDB Query. This ensures the handler's `computeBlendedSignal` finds an
 * exact-match candle in the 250-bar window (within ±1ms tolerance).
 *
 * `force: true` instructs the handler to skip the close-quorum ADD/check
 * (Step 1) and the signals-v2 dedup gate (Step 3) so IndicatorState is
 * actually refreshed on every call, regardless of existing quorum state.
 */
function buildSyntheticEvent(
  pair: string,
  exchange: string,
  timeframe: string,
  closeTime: number,
): string {
  const event = {
    Records: [
      {
        eventName: "INSERT",
        dynamodb: {
          Keys: {
            pair: { S: pair },
            sk: { S: `${timeframe}#${closeTime}` },
          },
          NewImage: {
            pair: { S: pair },
            exchange: { S: exchange },
            timeframe: { S: timeframe },
            closeTime: { N: String(closeTime) },
            openTime: { N: String(closeTime - 60_000) },
            open: { N: "0" },
            high: { N: "0" },
            low: { N: "0" },
            close: { N: "0" },
            volume: { N: "0" },
            symbol: { S: pair },
            source: { S: "live" },
            force: { BOOL: true },
          },
        },
      },
    ],
  };
  return JSON.stringify(event);
}

/**
 * Invoke the indicator-handler Lambda once for a single (pair, exchange, tf) tuple.
 *
 * Steps:
 *   1. Query the candles table for the most recent live candle for this
 *      (pair, exchange, timeframe). SK prefix = `exchange#timeframe#`, sorted
 *      descending, Limit=1. If no candle exists, return {ok: false, error: ...}
 *      without invoking the Lambda — we have nothing meaningful to compute on.
 *   2. Build the synthetic DDB Streams event with the real closeTime + force=true.
 *   3. Invoke the handler synchronously (RequestResponse) so the caller gets
 *      per-tuple ok/error in the response.
 */
async function invokeIndicatorHandler(
  pair: string,
  exchange: string,
  timeframe: string,
): Promise<ForceIndicatorsResultItem> {
  const fnName = process.env.INDICATOR_HANDLER_FUNCTION_NAME;
  if (!fnName) {
    return {
      pair,
      exchange,
      timeframe,
      ok: false,
      error: "INDICATOR_HANDLER_FUNCTION_NAME env var not set",
    };
  }

  // Query the latest candle so the synthetic event carries a real closeTime.
  // SK format: `exchange#timeframe#<iso-openTime>` (newest first with ScanIndexForward=false).
  let closeTime: number;
  try {
    const prefix = `${exchange}#${timeframe}#`;
    const candleResult = await dynamo.send(
      new QueryCommand({
        TableName: CANDLES_TABLE,
        KeyConditionExpression: "#pair = :pair AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
        ExpressionAttributeValues: { ":pair": pair, ":prefix": prefix },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    const latestCandle = candleResult.Items?.[0] as
      | { closeTime?: number; closeTime_n?: number }
      | undefined;
    if (!latestCandle || typeof latestCandle.closeTime !== "number") {
      return { pair, exchange, timeframe, ok: false, error: "no live candles found" };
    }
    closeTime = latestCandle.closeTime;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn(
      { err, pair, exchange, timeframe },
      "[AdminDebug] force-indicators candle query failed",
    );
    return { pair, exchange, timeframe, ok: false, error: `candle query failed: ${message}` };
  }

  const payload = buildSyntheticEvent(pair, exchange, timeframe, closeTime);

  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: fnName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(payload),
      }),
    );

    // FunctionError is set when the Lambda itself threw (unhandled exception).
    if (response.FunctionError) {
      const errorBody = response.Payload
        ? new TextDecoder().decode(response.Payload)
        : "no payload";
      return { pair, exchange, timeframe, ok: false, error: `Lambda error: ${errorBody}` };
    }

    return { pair, exchange, timeframe, ok: true };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn({ err, pair, exchange, timeframe }, "[AdminDebug] force-indicators invoke failed");
    return { pair, exchange, timeframe, ok: false, error: message };
  }
}

// Concurrency cap for bulk mode: at most this many Lambda invocations in
// flight simultaneously. Keeps the API Lambda's open connection count bounded
// and avoids a 60-concurrent-invoke burst that could spike DDB reads.
const BULK_CONCURRENCY = 5;

/**
 * Force an immediate recompute of IndicatorState for one or more
 * (pair, exchange, timeframe) tuples by invoking the indicator-handler Lambda
 * with a synthetic DynamoDBStreamEvent.
 *
 * Targeted: `{ pair, exchange, timeframe }` → 1 invocation.
 * Bulk:     `{ all: true }` → up to 60 invocations (5 pairs × 3 exchanges × 4 TFs),
 *           run with a concurrency cap of BULK_CONCURRENCY to avoid connection storms.
 *
 * Results include per-tuple ok/error.
 */
export async function forceIndicators(input: ForceIndicatorsInput): Promise<ForceIndicatorsResult> {
  const tuples = buildTuples(input);

  // For targeted mode (single tuple), skip the semaphore overhead.
  if (tuples.length === 1) {
    const { pair, exchange, timeframe } = tuples[0]!;
    const result = await invokeIndicatorHandler(pair, exchange, timeframe);
    return { results: [result] };
  }

  // Bulk mode: run with a semaphore to cap concurrency at BULK_CONCURRENCY.
  const results: ForceIndicatorsResultItem[] = [];
  const queue = [...tuples];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const tuple = queue.shift();
      if (!tuple) break;
      const result = await invokeIndicatorHandler(tuple.pair, tuple.exchange, tuple.timeframe);
      results.push(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BULK_CONCURRENCY, tuples.length) }, () => worker()),
  );

  return { results };
}
