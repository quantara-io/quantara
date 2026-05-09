/**
 * Phase 5a news enrichment: pair-tagging, sentiment classification, embedding dedup.
 *
 * All LLM calls use Bedrock via @aws-sdk/client-bedrock-runtime:
 *   - Pair-tagging + sentiment   → Anthropic Claude Haiku (cross-region inference profile)
 *   - Embedding dedup            → Amazon Titan Text Embeddings v2 (direct foundation model)
 *
 * Authentication is via the Lambda's IAM role (SigV4) — no API keys, no outbound
 * to non-AWS endpoints, no SSM-stored secrets. Both model IDs are pinned to named
 * constants so upgrades are search-replaceable.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { HAIKU_MODEL_TAG } from "@quantara/shared";

import { recordLlmUsage } from "../lib/metadata-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * PINNED — changing this constant requires a migration job to re-embed cached
 * vectors. The `model` field on every `EmbeddingCacheItem` records which model
 * produced the vector; cross-model comparisons are deliberately skipped at
 * dedup time (different geometries are not directly comparable).
 */
export const EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

/** Titan v2 supports 256 / 512 / 1024 dims; 1024 is highest quality. */
const EMBEDDING_DIMENSIONS = 1024;

const DEDUP_THRESHOLD = 0.85; // cosine similarity above this → duplicate
const DEDUP_WINDOW_HOURS = 24;

// Bedrock invocation ID — cross-region inference profile (us.* prefix).
// Required because all currently-active Anthropic models on Bedrock are
// profile-only; bare aliases return "Invocation … with on-demand throughput
// isn't supported." The org SCP permits `bedrock:InvokeModel*` cross-region.
const HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

// `HAIKU_MODEL_TAG` is the stable identifier stamped on `SentimentResult.model`
// and on the LLM-usage records this file writes via `recordLlmUsage`. It's
// imported from `@quantara/shared` so the backend's cost-calc reads the same
// constant rather than maintaining a parallel hard-coded copy. Bump only when
// the underlying model changes in a way that makes prior outputs incompatible
// (e.g. Haiku 4.5 → 5.x). Unrelated to the embedding cache, which keys on
// `EMBEDDING_MODEL` (Amazon Titan Text Embeddings v2) and never reads this tag.

// ---------------------------------------------------------------------------
// AWS clients (module-scope singletons)
// ---------------------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const EMBEDDING_CACHE_TABLE =
  process.env.TABLE_EMBEDDING_CACHE ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}embedding-cache`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first JSON object or array from a possibly-prose string.
 * Haiku JSON mode occasionally prepends a short intro sentence.
 */
export function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON found in: ${text}`);
  return text.slice(start, end + 1);
}

/**
 * Cosine similarity between two equal-length float vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Invoke Bedrock Haiku (claude-haiku-4-5) in JSON mode and return parsed object.
 * Records token usage best-effort. NOTE: Phase 5a's enrichArticle calls this
 * twice per article (pair-tag + sentiment), so we count the *call* but NOT
 * the article — countAsArticle is false here. The article boundary lives at
 * the per-article wrapper level if/when Phase 5a goes live as the active path.
 */
async function invokeHaiku<T>(systemPrompt: string, userContent: string): Promise<T> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: HAIKU_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  void recordLlmUsage({
    modelTag: HAIKU_MODEL_TAG,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    countAsArticle: false,
  });

  const text: string = body.content?.[0]?.text ?? "{}";
  return JSON.parse(extractJson(text)) as T;
}

// ---------------------------------------------------------------------------
// Pair-tagging
// ---------------------------------------------------------------------------

export const PAIR_PATTERNS: Record<string, RegExp> = {
  BTC: /\b(BTC|XBT|bitcoin)\b/i,
  ETH: /\b(ETH|ether|ethereum)\b/i,
  SOL: /\b(SOL|solana)\b/i,
  XRP: /\b(XRP|ripple)\b/i,
  DOGE: /\b(DOGE|dogecoin)\b/i,
};

/** Layer 1: fast regex scan for explicit mention. */
export function regexTags(text: string): string[] {
  return Object.entries(PAIR_PATTERNS)
    .filter(([, re]) => re.test(text))
    .map(([sym]) => sym);
}

/** Layer 2: LLM classifier for pairs that are affected but not directly named. */
export async function llmTags(title: string, body: string): Promise<string[]> {
  const result = await invokeHaiku<{ affectedPairs: string[] }>(
    `Identify which crypto symbols an article materially affects.
Return JSON only: { "affectedPairs": string[] }
Valid symbols: BTC, ETH, SOL, XRP, DOGE.
Include only pairs the article would influence — not just mentioned. Example:
"Coinbase delists ETH staking" affects ETH (Coinbase is the staking host) even
though "ETH" may not appear in the title.`,
    `Title: ${title}\n\nBody: ${body.slice(0, 2000)}`,
  );
  const valid = new Set(Object.keys(PAIR_PATTERNS));
  return (result.affectedPairs ?? []).filter((s: string) => valid.has(s));
}

/**
 * Final pair-tagging: union of regex layer and LLM layer, deduplicated.
 * Returns `mentionedPairs: string[]`.
 */
export async function tagPairs(title: string, body: string): Promise<string[]> {
  const combined = title + " " + body;
  const [regex, llm] = await Promise.all([
    Promise.resolve(regexTags(combined)),
    llmTags(title, body),
  ]);
  return [...new Set([...regex, ...llm])];
}

// ---------------------------------------------------------------------------
// Sentiment classifier
// ---------------------------------------------------------------------------

export interface SentimentResult {
  score: number;
  magnitude: number;
  model: string;
}

/** Returns a sentiment score (-1 to +1), magnitude (0 to 1), and model tag. */
export async function classifySentiment(title: string, body: string): Promise<SentimentResult> {
  const result = await invokeHaiku<{ score: number; magnitude: number; topic: string }>(
    `Classify sentiment of a crypto news article. Return JSON only:
{ "score": <-1 to +1>, "magnitude": <0 to 1>, "topic": <string> }
- score: -1 = strongly bearish; +1 = strongly bullish; 0 = neutral
- magnitude: how confidently positive/negative the article is (0 = unclear, 1 = strong claim)
- topic: 2-4 word category (e.g. "regulation", "ETF approval", "exchange hack")`,
    `Title: ${title}\n\nBody: ${body.slice(0, 2000)}`,
  );
  return {
    score: Math.max(-1, Math.min(1, result.score ?? 0)),
    magnitude: Math.max(0, Math.min(1, result.magnitude ?? 0)),
    model: HAIKU_MODEL_TAG,
  };
}

// ---------------------------------------------------------------------------
// Embedding cache DynamoDB helpers
// ---------------------------------------------------------------------------

interface EmbeddingCacheItem {
  articleId: string;
  vector: number[];
  model: string;
  dim: number;
  publishedAt: string;
  ttl: number;
}

async function putEmbeddingCache(item: EmbeddingCacheItem): Promise<void> {
  await dynamo.send(
    new PutCommand({
      TableName: EMBEDDING_CACHE_TABLE,
      Item: item,
    }),
  );
}

async function scanEmbeddingCache(sinceEpochSeconds: number): Promise<EmbeddingCacheItem[]> {
  // Scan the embedding-cache table for items published within the dedup window.
  // This table is intentionally small (TTL = 24h, ~50 articles/day) so a Scan is acceptable.
  const result = await dynamo.send(
    new ScanCommand({
      TableName: EMBEDDING_CACHE_TABLE,
      FilterExpression: "#ttl >= :since",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":since": sinceEpochSeconds },
    }),
  );
  return (result.Items ?? []) as EmbeddingCacheItem[];
}

// ---------------------------------------------------------------------------
// Embedding (Bedrock Titan v2 via InvokeModel)
// ---------------------------------------------------------------------------

async function fetchEmbedding(text: string): Promise<number[]> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions: EMBEDDING_DIMENSIONS,
        normalize: true,
      }),
    }),
  );
  const json = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding: number[];
    inputTextTokenCount?: number;
  };
  if (!Array.isArray(json.embedding)) {
    throw new Error(`Bedrock Titan response missing embedding array (input length ${text.length})`);
  }
  // Defense-in-depth: validate dimensions and finite-number contents before
  // handing off to cosineSimilarity, which would otherwise throw on a
  // mismatched length and bury the actual cause behind a generic math error.
  if (json.embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Bedrock Titan returned wrong-dim embedding: expected ${EMBEDDING_DIMENSIONS}, got ${json.embedding.length}`,
    );
  }
  if (!json.embedding.every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new Error(
      `Bedrock Titan returned non-finite values in embedding (model ${EMBEDDING_MODEL})`,
    );
  }
  return json.embedding;
}

// ---------------------------------------------------------------------------
// Embedding dedup
// ---------------------------------------------------------------------------

export interface DedupResult {
  duplicateOf: string | null;
  embeddingModel: string;
}

/**
 * Compute an embedding for the article, compare against the 24-hour window of
 * cached vectors, and return whether this article is a duplicate.
 *
 * Side effect: if not a duplicate, writes the vector to the embedding-cache table
 * so future articles can be compared against it.
 *
 * Safety: vectors from a different model version are skipped — never compare across models.
 */
export async function checkDedup(article: {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
}): Promise<DedupResult> {
  const text = (article.title + "\n" + article.body.slice(0, 200))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const newVec = await fetchEmbedding(text);
  const sinceEpochSeconds = Math.floor(Date.now() / 1000) - DEDUP_WINDOW_HOURS * 3600;
  const recentVecs = await scanEmbeddingCache(sinceEpochSeconds);

  for (const cached of recentVecs) {
    if (cached.model !== EMBEDDING_MODEL) continue; // safety: skip cross-model comparisons
    const sim = cosineSimilarity(newVec, cached.vector);
    if (sim > DEDUP_THRESHOLD) {
      return { duplicateOf: cached.articleId, embeddingModel: EMBEDDING_MODEL };
    }
  }

  // Not a duplicate — cache the vector for the next 24 hours
  await putEmbeddingCache({
    articleId: article.id,
    vector: newVec,
    model: EMBEDDING_MODEL,
    dim: newVec.length,
    publishedAt: article.publishedAt,
    ttl: Math.floor(Date.now() / 1000) + DEDUP_WINDOW_HOURS * 3600,
  });

  return { duplicateOf: null, embeddingModel: EMBEDDING_MODEL };
}

// ---------------------------------------------------------------------------
// Top-level enrichment: run all three enrichments for one article
// ---------------------------------------------------------------------------

export interface Phase5aEnrichment {
  mentionedPairs: string[];
  sentiment: { score: number; magnitude: number; model: string };
  duplicateOf: string | null;
  embeddingModel: string;
  enrichedAt: string;
}

/**
 * Run all Phase 5a enrichments (pair-tagging, sentiment, embedding dedup)
 * for a single news article. All three run concurrently.
 */
export async function enrichArticle(article: {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
}): Promise<Phase5aEnrichment> {
  const [mentionedPairs, sentiment, dedup] = await Promise.all([
    tagPairs(article.title, article.body),
    classifySentiment(article.title, article.body),
    checkDedup(article),
  ]);

  return {
    mentionedPairs,
    sentiment,
    duplicateOf: dedup.duplicateOf,
    embeddingModel: dedup.embeddingModel,
    enrichedAt: new Date().toISOString(),
  };
}
