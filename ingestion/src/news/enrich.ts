/**
 * Phase 5a news enrichment: pair-tagging, sentiment classification, embedding dedup.
 *
 * LLM calls (pair-tagging + sentiment) use Bedrock Haiku via the existing
 * @aws-sdk/client-bedrock-runtime (no new SDK dependency).
 *
 * Embedding dedup calls the OpenAI REST API directly via fetch (Node 24 built-in),
 * authenticated via an SSM-cached API key. The model is pinned to a single named
 * constant so that upgrades are search-replaceable.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** PINNED — changing this constant requires a migration job to re-embed cached vectors. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

const DEDUP_THRESHOLD = 0.85; // cosine similarity above this → duplicate
const DEDUP_WINDOW_HOURS = 24;

const HAIKU_MODEL_ID = "anthropic.claude-haiku-4-5";

// ---------------------------------------------------------------------------
// AWS clients (module-scope singletons)
// ---------------------------------------------------------------------------

const bedrock = new BedrockRuntimeClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";
const EMBEDDING_CACHE_TABLE =
  process.env.TABLE_EMBEDDING_CACHE ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}embedding-cache`;

// ---------------------------------------------------------------------------
// OpenAI API key (SSM-cached)
// ---------------------------------------------------------------------------

let _openAiKey: string | null = null;

async function getOpenAiKey(): Promise<string> {
  if (_openAiKey) return _openAiKey;
  if (process.env.OPENAI_API_KEY) {
    _openAiKey = process.env.OPENAI_API_KEY;
    return _openAiKey;
  }
  const param = await ssm.send(
    new GetParameterCommand({
      Name: `/quantara/${ENVIRONMENT}/openai-api-key`,
      WithDecryption: true,
    })
  );
  _openAiKey = param.Parameter?.Value ?? "";
  if (!_openAiKey) throw new Error("SSM /quantara/<env>/openai-api-key is empty");
  return _openAiKey;
}

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
    })
  );
  const body = JSON.parse(new TextDecoder().decode(response.body));
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
    `Title: ${title}\n\nBody: ${body.slice(0, 2000)}`
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
    `Title: ${title}\n\nBody: ${body.slice(0, 2000)}`
  );
  return {
    score: Math.max(-1, Math.min(1, result.score ?? 0)),
    magnitude: Math.max(0, Math.min(1, result.magnitude ?? 0)),
    model: HAIKU_MODEL_ID,
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
    })
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
    })
  );
  return (result.Items ?? []) as EmbeddingCacheItem[];
}

// ---------------------------------------------------------------------------
// Embedding (OpenAI REST via fetch — no openai package dependency)
// ---------------------------------------------------------------------------

async function fetchEmbedding(text: string): Promise<number[]> {
  const apiKey = await getOpenAiKey();
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embeddings API error ${res.status}: ${err}`);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0].embedding;
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
