import { getSentimentAggregate } from "../lib/sentiment-store.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { EnrichedNewsArticle } from "./aggregator.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;
const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

// ---------------------------------------------------------------------------
// Types — §6.8 shape
// ---------------------------------------------------------------------------

export interface SentimentWindow {
  score: number;
  magnitude: number;
  articleCount: number;
  sourceCounts: Record<string, number>;
  computedAt: string;
}

export interface ArticleSummary {
  title: string;
  sentiment: number;
  magnitude: number;
  source: string;
  publishedAt: string;
  url?: string;
}

export interface SentimentBundle {
  pair: string;
  windows: { "4h": SentimentWindow; "24h": SentimentWindow };
  recentArticles: ArticleSummary[];
  fearGreed: { value: number; trend24h: number };
}

// ---------------------------------------------------------------------------
// Fear & Greed helpers
// ---------------------------------------------------------------------------

export interface FearGreedMetadata {
  value: number;
  classification?: string;
  history?: Array<{ value: number; timestamp: number }>;
}

/**
 * Load the latest Fear & Greed index from ingestion-metadata.
 * Returns a zero-value placeholder when the record is not found.
 */
export async function getFearGreed(): Promise<FearGreedMetadata> {
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: "market:fear-greed" },
    })
  );

  if (!result.Item) {
    return { value: 50, history: [] }; // neutral fallback
  }

  return {
    value: (result.Item.value as number) ?? 50,
    classification: result.Item.classification as string | undefined,
    history: (result.Item.history as FearGreedMetadata["history"]) ?? [],
  };
}

/**
 * Compute a 24h trend from the Fear & Greed history.
 *
 * Compares the most recent value against the value ~24h ago (or the oldest
 * available entry if history is shorter than 24h). Returns 0 when there is
 * insufficient history.
 */
export function computeTrend24h(
  history: Array<{ value: number; timestamp: number }>
): number {
  if (!history || history.length < 2) return 0;

  const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
  const latest = sorted[0];
  const cutoff = latest.timestamp - 24 * 3600 * 1000;

  // Find the entry closest to 24h ago
  const old = sorted.find((h) => h.timestamp <= cutoff) ?? sorted[sorted.length - 1];
  return latest.value - old.value;
}

// ---------------------------------------------------------------------------
// Recent articles query
// ---------------------------------------------------------------------------

/**
 * Query recent enriched news events for a pair within a 24h window.
 * Deduped: articles with `duplicateOf` set are excluded.
 */
export async function queryRecentNewsEventsByPair(
  pair: string,
  options: { since: number; deduped?: boolean; limit?: number }
): Promise<EnrichedNewsArticle[]> {
  const cutoffIso = new Date(options.since).toISOString();

  const result = await client.send(
    new QueryCommand({
      TableName: NEWS_TABLE,
      IndexName: "currency-index",
      KeyConditionExpression: "#currency = :pair AND #publishedAt >= :cutoff",
      FilterExpression:
        "#status = :enriched" +
        (options.deduped
          ? " AND (attribute_not_exists(#duplicateOf) OR #duplicateOf = :null)"
          : ""),
      ExpressionAttributeNames: {
        "#currency": "currency",
        "#publishedAt": "publishedAt",
        "#status": "status",
        ...(options.deduped ? { "#duplicateOf": "duplicateOf" } : {}),
      },
      ExpressionAttributeValues: {
        ":pair": pair,
        ":cutoff": cutoffIso,
        ":enriched": "enriched",
        ...(options.deduped ? { ":null": null } : {}),
      },
      ScanIndexForward: false,
      Limit: options.limit ?? 50,
    })
  );

  return (result.Items ?? []) as EnrichedNewsArticle[];
}

// ---------------------------------------------------------------------------
// Zero-value aggregate helper
// ---------------------------------------------------------------------------

function zeroWindow(): SentimentWindow {
  return {
    score: 0,
    magnitude: 0,
    articleCount: 0,
    sourceCounts: {},
    computedAt: new Date().toISOString(),
  };
}

function toWindow(
  agg: Awaited<ReturnType<typeof getSentimentAggregate>>
): SentimentWindow {
  if (!agg) return zeroWindow();
  return {
    score: agg.score,
    magnitude: agg.magnitude,
    articleCount: agg.articleCount,
    sourceCounts: agg.sourceCounts,
    computedAt: agg.computedAt,
  };
}

// ---------------------------------------------------------------------------
// Bundle assembler — §6.8
// ---------------------------------------------------------------------------

/**
 * Build a SentimentBundle for the given pair.
 *
 * Loads the 4h and 24h aggregates, the 24h recent article list, and the
 * Fear & Greed index concurrently. Shapes the result for the §7 LLM
 * ratification layer (Phase 6).
 *
 * `recentArticles` is the top 5 most-recent deduplicated articles, sorted by
 * `publishedAt` descending. Duplicates (`duplicateOf !== null`) are excluded.
 */
export async function buildSentimentBundle(pair: string): Promise<SentimentBundle> {
  const [agg4h, agg24h, articles, fng] = await Promise.all([
    getSentimentAggregate(pair, "4h"),
    getSentimentAggregate(pair, "24h"),
    queryRecentNewsEventsByPair(pair, {
      since: Date.now() - 24 * 3600 * 1000,
      deduped: true,
      limit: 50,
    }),
    getFearGreed(),
  ]);

  // Top 5: sort by publishedAt descending, take 5
  const top5 = [...articles]
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 5);

  return {
    pair,
    windows: {
      "4h": toWindow(agg4h),
      "24h": toWindow(agg24h),
    },
    recentArticles: top5.map((a) => ({
      title: a.title,
      sentiment: a.sentiment.score,
      magnitude: a.sentiment.magnitude,
      source: a.source,
      publishedAt: a.publishedAt,
      url: a.url,
    })),
    fearGreed: {
      value: fng.value,
      trend24h: computeTrend24h(fng.history ?? []),
    },
  };
}
