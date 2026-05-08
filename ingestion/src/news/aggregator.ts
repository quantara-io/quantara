import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { putSentimentAggregate } from "../lib/sentiment-store.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichedNewsArticle {
  newsId: string;
  title: string;
  source: string;
  publishedAt: string;
  url?: string;
  sentiment: { score: number; magnitude: number; model?: string };
  duplicateOf: string | null;
  mentionedPairs: string[];
}

// ---------------------------------------------------------------------------
// DynamoDB query helpers
// ---------------------------------------------------------------------------

/**
 * Query news events for a specific pair within a time window.
 *
 * Uses the `currency-index` GSI (hash = currency, range = publishedAt) to
 * retrieve articles mentioning the given pair. When `deduped` is true, only
 * articles with `duplicateOf = null` are returned.
 *
 * Note: the GSI is keyed on the `currency` attribute which must match the pair
 * symbol (e.g. "BTC"). Articles written by the Phase 5a enrichment handler
 * that have the `mentionedPairs` list populated and `status = "enriched"` are
 * the target population.
 */
export async function queryNewsEventsByPair(
  pair: string,
  options: { since: number; deduped?: boolean }
): Promise<EnrichedNewsArticle[]> {
  const cutoffIso = new Date(options.since).toISOString();

  const result = await client.send(
    new QueryCommand({
      TableName: NEWS_TABLE,
      IndexName: "currency-index",
      KeyConditionExpression: "#currency = :pair AND #publishedAt >= :cutoff",
      FilterExpression:
        "#status = :enriched" +
        (options.deduped ? " AND (attribute_not_exists(#duplicateOf) OR #duplicateOf = :null)" : ""),
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
    })
  );

  return (result.Items ?? []) as EnrichedNewsArticle[];
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Recompute the sentiment aggregate for a pair over a time window (4h or 24h).
 *
 * - Equal-weight mean of score and magnitude per §6.5.
 * - Empty window writes a zeroed entry so consumers never get null.
 * - Writes the result to the `sentiment-aggregates` DynamoDB table (TTL +1h).
 *
 * Trigger: call after Phase 5a enrichment for every pair in `mentionedPairs[]`,
 * and from a 5-minute scheduled fallback for all known pairs.
 */
export async function recomputeSentimentAggregate(
  pair: string,
  window: "4h" | "24h"
): Promise<void> {
  const cutoff =
    window === "4h"
      ? Date.now() - 4 * 3600 * 1000
      : Date.now() - 24 * 3600 * 1000;

  const articles = await queryNewsEventsByPair(pair, { since: cutoff, deduped: true });

  const computedAt = new Date().toISOString();

  if (articles.length === 0) {
    // Empty window — write a zeroed entry so the consumer doesn't get null
    await putSentimentAggregate({
      pair,
      window,
      score: 0,
      magnitude: 0,
      articleCount: 0,
      sourceCounts: {},
      computedAt,
    });
    console.log(`[Aggregator] ${pair}/${window}: 0 articles — wrote zeroed entry`);
    return;
  }

  // Equal-weight mean per §6.5
  const score =
    articles.reduce((s, a) => s + a.sentiment.score, 0) / articles.length;
  const magnitude =
    articles.reduce((s, a) => s + a.sentiment.magnitude, 0) / articles.length;
  const sourceCounts = articles.reduce(
    (acc, a) => ({ ...acc, [a.source]: (acc[a.source] ?? 0) + 1 }),
    {} as Record<string, number>
  );

  await putSentimentAggregate({
    pair,
    window,
    score,
    magnitude,
    articleCount: articles.length,
    sourceCounts,
    computedAt,
  });

  console.log(
    `[Aggregator] ${pair}/${window}: ${articles.length} articles → score=${score.toFixed(3)}, magnitude=${magnitude.toFixed(3)}`
  );
}
