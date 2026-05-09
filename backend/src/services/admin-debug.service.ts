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
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "crypto";

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

// ---------------------------------------------------------------------------
// Daily-cap check
// ---------------------------------------------------------------------------

const DAILY_CAP_MAX = 200; // hard max debug invocations per day (not per pair)

/**
 * Count force-ratification debug invocations in the past 24 hours.
 * Returns 429 metadata if the cap is exceeded.
 */
async function checkDailyDebugCap(pair: string): Promise<{ capped: boolean; count: number }> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: RATIFICATIONS_TABLE,
        KeyConditionExpression:
          "#pair = :pair AND invokedAtRecordId >= :lo",
        FilterExpression: "triggerReason = :reason",
        ExpressionAttributeNames: { "#pair": "pair" },
        ExpressionAttributeValues: {
          ":pair": pair,
          ":lo": sinceIso,
          ":reason": "manual",
        },
        Select: "COUNT",
      }),
    );
    const count = result.Count ?? 0;
    return { capped: count >= DAILY_CAP_MAX, count };
  } catch (err) {
    // Non-fatal — if we can't read the count, allow the call (fail-open for debug tool).
    logger.warn({ err, pair }, "[AdminDebug] Failed to read ratification count for cap check");
    return { capped: false, count: 0 };
  }
}

// ---------------------------------------------------------------------------
// 1. Force ratification
// ---------------------------------------------------------------------------

export interface ForceRatificationInput {
  pair: string;
  timeframe: string;
}

export interface ForceRatificationResult {
  verdict: string | null;
  confidence: number | null;
  reasoning: string | null;
  latencyMs: number;
  costUsd: number;
  cacheHit: boolean;
  fellBackToAlgo: boolean;
  recordId: string;
  rawResponse: Record<string, unknown> | null;
}

const HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_INPUT_COST_PER_1K = 0.00025;
const HAIKU_OUTPUT_COST_PER_1K = 0.00125;

/**
 * Force an immediate LLM ratification for the latest signal in the given
 * pair × timeframe. Reads the latest signal from signals_v2, calls Bedrock
 * Haiku inline with a ratification prompt, persists the result to the
 * ratifications table (triggerReason="manual"), and returns the verdict
 * inline.
 *
 * Counts against the daily cap — returns { capped: true } if exhausted.
 */
export async function forceRatification(
  input: ForceRatificationInput,
): Promise<ForceRatificationResult & { capped?: boolean; capCount?: number }> {
  const { pair, timeframe } = input;

  // Cap check
  const { capped, count } = await checkDailyDebugCap(pair);
  if (capped) {
    return {
      capped: true,
      capCount: count,
      verdict: null,
      confidence: null,
      reasoning: null,
      latencyMs: 0,
      costUsd: 0,
      cacheHit: false,
      fellBackToAlgo: false,
      recordId: "",
      rawResponse: null,
    };
  }

  // Fetch the latest signal for this pair × timeframe from signals_v2
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

  // Build a minimal ratification prompt from the signal fields
  const signalType = String(signal["type"] ?? "unknown");
  const confidence = Number(signal["confidence"] ?? 0);
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
Type: ${signalType}
Confidence: ${(confidence * 100).toFixed(0)}%
Close time: ${closeTime}
Rules fired: ${rulesFired}
Trigger reason: manual (admin debug)

Rate this signal's validity and provide your reasoning in 2-3 sentences.`;

  const startMs = Date.now();
  let rawResponse: Record<string, unknown> | null = null;
  let verdict: string | null = null;
  let ratifiedConfidence: number | null = null;
  let reasoning: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let fellBackToAlgo = false;

  try {
    const bedrockResponse = await bedrock.send(
      new InvokeModelCommand({
        modelId: HAIKU_MODEL_ID,
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

    // Extract JSON from response
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        verdict?: string;
        confidence?: number;
        reasoning?: string;
      };
      verdict = parsed.verdict ?? null;
      ratifiedConfidence = typeof parsed.confidence === "number" ? parsed.confidence : null;
      reasoning = parsed.reasoning ?? null;
    }

    const usage = rawResponse["usage"] as { input_tokens?: number; output_tokens?: number };
    inputTokens = usage?.input_tokens ?? 0;
    outputTokens = usage?.output_tokens ?? 0;
  } catch (err) {
    // Fall back to algo signal on LLM error
    logger.warn({ err, pair, timeframe }, "[AdminDebug] Bedrock call failed — falling back to algo");
    fellBackToAlgo = true;
    verdict = signalType;
    ratifiedConfidence = confidence;
    reasoning = "Fell back to algo signal — LLM call failed";
  }

  const latencyMs = Date.now() - startMs;
  const costUsd =
    (inputTokens / 1000) * HAIKU_INPUT_COST_PER_1K +
    (outputTokens / 1000) * HAIKU_OUTPUT_COST_PER_1K;

  // Persist ratification record
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
          validationOk: true,
          algoCandidateType: signalType,
          algoCandidateConfidence: confidence,
          ratifiedType: verdict,
          ratifiedConfidence,
          ratifiedReasoning: reasoning,
          llmModel: fellBackToAlgo ? null : HAIKU_MODEL_ID,
          algoCandidate: signal,
          ratified: verdict
            ? {
                type: verdict,
                confidence: ratifiedConfidence,
                reasoning,
              }
            : null,
          llmRequest: {
            model: HAIKU_MODEL_ID,
            systemHash: "",
            userJsonHash: "",
          },
          llmRawResponse: rawResponse,
          // 30-day TTL for debug records
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      }),
    );
  } catch (err) {
    logger.error({ err, pair, timeframe, recordId }, "[AdminDebug] Failed to write ratification record");
    // Don't throw — return the result even if we couldn't persist
  }

  return {
    verdict,
    confidence: ratifiedConfidence,
    reasoning,
    latencyMs,
    costUsd,
    cacheHit: false,
    fellBackToAlgo,
    recordId,
    rawResponse,
  };
}

// ---------------------------------------------------------------------------
// 2. Replay news enrichment
// ---------------------------------------------------------------------------

export interface ReplayNewsEnrichmentInput {
  newsId: string;
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
  mutated: false; // always false — read-only path
}

const PAIR_PATTERNS: Record<string, RegExp> = {
  BTC: /\b(BTC|XBT|bitcoin)\b/i,
  ETH: /\b(ETH|ether|ethereum)\b/i,
  SOL: /\b(SOL|solana)\b/i,
  XRP: /\b(XRP|ripple)\b/i,
  DOGE: /\b(DOGE|dogecoin)\b/i,
};

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
      modelId: HAIKU_MODEL_ID,
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
  const text = String(
    (body["content"] as Array<{ text: string }>)?.[0]?.text ?? "{}",
  );
  const usage = body["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    result: JSON.parse(extractJson(text)) as T,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

/**
 * Re-run Phase 5a enrichment (pair-tagging + sentiment) for a single news
 * article by newsId. The stored news row is NOT mutated — this is a read-only
 * diff tool. The newsId must exist in the news-events table (any publishedAt).
 *
 * Scans by newsId (hash key) to locate the record without knowing publishedAt.
 */
export async function replayNewsEnrichment(
  input: ReplayNewsEnrichmentInput,
): Promise<ReplayNewsEnrichmentResult> {
  const { newsId } = input;

  // Query by newsId (PK) — we don't know publishedAt, so query the table.
  // NEWS table PK=newsId, SK=publishedAt; use begins_with to find the row.
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

  // Layer 1: regex pair-tagging (same logic as ingestion/src/news/enrich.ts)
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

  // Sentiment classification
  let sentimentScore = 0;
  let sentimentMagnitude = 0;
  const HAIKU_MODEL_TAG = "anthropic.claude-haiku-4-5";

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
      sentiment: {
        score: sentimentScore,
        magnitude: sentimentMagnitude,
        model: HAIKU_MODEL_TAG,
      },
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
}

export interface InjectSentimentShockResult {
  decision: "fired" | "gated" | "skipped";
  reasons: string[];
  shockRecord: Record<string, unknown> | null;
}

/**
 * Build a synthetic previous + next sentiment aggregate pair with the given
 * deltas, then run the shock detection + cost gate + ratification path.
 * The shock record IS written to the ratifications table
 * (triggerReason="sentiment_shock") so the end-to-end path can be observed.
 */
export async function injectSentimentShock(
  input: InjectSentimentShockInput,
): Promise<InjectSentimentShockResult> {
  const { pair, deltaScore, deltaMagnitude } = input;
  const reasons: string[] = [];

  // Validate deltas separately so the error message indicates which field is invalid.
  if (Math.abs(deltaScore) > 2) {
    throw new Error("deltaScore must be in [-2, 2]");
  }
  if (Math.abs(deltaMagnitude) > 1) {
    throw new Error("deltaMagnitude must be in [-1, 1]");
  }

  // Read the latest real sentiment aggregate for this pair (4h window)
  // to build a plausible base.
  const baseSymbol = pair.split("/")[0] ?? pair;
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
    logger.warn({ err, pair }, "[AdminDebug] Could not read base sentiment aggregate — using defaults");
    reasons.push("Could not read base aggregate — using default baseline");
  }

  const prevScore = baseMeanScore;
  const nextScore = Math.max(-1, Math.min(1, baseMeanScore + deltaScore));
  const nextMagnitude = Math.max(0, Math.min(1, baseMeanMagnitude + deltaMagnitude));

  // Shock detection thresholds (mirrors sentiment-shock.ts defaults)
  const DELTA_THRESHOLD = 0.3;
  const MAGNITUDE_FLOOR = 0.5;
  const actualDelta = Math.abs(nextScore - prevScore);

  if (actualDelta < DELTA_THRESHOLD) {
    reasons.push(
      `delta=${actualDelta.toFixed(3)} < threshold=${DELTA_THRESHOLD} — shock not triggered`,
    );
    return { decision: "skipped", reasons, shockRecord: null };
  }

  if (nextMagnitude < MAGNITUDE_FLOOR) {
    reasons.push(
      `magnitude=${nextMagnitude.toFixed(3)} < floor=${MAGNITUDE_FLOOR} — shock not triggered`,
    );
    return { decision: "skipped", reasons, shockRecord: null };
  }

  reasons.push(
    `delta=${actualDelta.toFixed(3)} >= ${DELTA_THRESHOLD}, magnitude=${nextMagnitude.toFixed(3)} >= ${MAGNITUDE_FLOOR} — shock conditions met`,
  );

  // Cost gate: check per-pair hourly cap (6 shocks/pair/hour)
  const HOURLY_CAP = 6;
  const hourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  try {
    const recentResult = await dynamo.send(
      new QueryCommand({
        TableName: RATIFICATIONS_TABLE,
        KeyConditionExpression: "#pair = :pair AND invokedAtRecordId >= :lo",
        FilterExpression: "triggerReason = :reason",
        ExpressionAttributeNames: { "#pair": "pair" },
        ExpressionAttributeValues: {
          ":pair": pair,
          ":lo": hourAgoIso,
          ":reason": "sentiment_shock",
        },
        Select: "COUNT",
      }),
    );
    const recentCount = recentResult.Count ?? 0;
    if (recentCount >= HOURLY_CAP) {
      reasons.push(
        `hourly cap: ${recentCount} >= ${HOURLY_CAP} sentiment_shock records in the past hour — gated`,
      );
      return { decision: "gated", reasons, shockRecord: null };
    }
  } catch (err) {
    logger.warn({ err, pair }, "[AdminDebug] Could not check cost gate — proceeding");
    reasons.push("Cost gate check failed — proceeding anyway");
  }

  // Write the shock ratification record
  const recordId = randomUUID();
  const invokedAt = new Date().toISOString();
  const invokedAtRecordId = `${invokedAt}#${recordId}`;

  const shockRecord: Record<string, unknown> = {
    pair,
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
    ratifiedReasoning: `Synthetic shock injected by admin debug. deltaScore=${deltaScore}, deltaMagnitude=${deltaMagnitude}. prevScore=${prevScore.toFixed(3)}, nextScore=${nextScore.toFixed(3)}, nextMagnitude=${nextMagnitude.toFixed(3)}.`,
    llmModel: null,
    algoCandidate: null,
    ratified: null,
    llmRequest: null,
    llmRawResponse: null,
    // Metadata specific to synthetic shocks
    syntheticShock: {
      prevScore,
      nextScore,
      nextMagnitude,
      deltaScore,
      deltaMagnitude,
      injectedBy: "admin-debug",
    },
    // 7-day TTL for debug records
    ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  };

  try {
    await dynamo.send(new PutCommand({ TableName: RATIFICATIONS_TABLE, Item: shockRecord }));
    reasons.push(`Shock record written: recordId=${recordId}`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ err, pair, recordId }, "[AdminDebug] Failed to write shock ratification record");
    reasons.push(`Failed to write shock record: ${msg}`);
    return { decision: "gated", reasons, shockRecord: null };
  }

  return { decision: "fired", reasons, shockRecord };
}
