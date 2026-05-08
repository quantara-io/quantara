/**
 * aggregator-handler.ts — SQS-driven sentiment aggregation Lambda.
 *
 * Two trigger paths:
 *
 * 1. SQS (enriched_news queue): for each enriched article, recompute aggregates
 *    for every (pair, window) combination. Duplicates are skipped early.
 *
 * 2. EventBridge 5-minute schedule: event.Records is empty (scheduled event is
 *    not an SQS record). Fall back to recomputing all known pairs × windows so
 *    that aggregates stay fresh even when no news lands.
 */

import type { SQSEvent, ScheduledEvent, Context } from "aws-lambda";
import { recomputeSentimentAggregate, type AggregationWindow } from "./news/aggregator.js";

const WINDOWS: AggregationWindow[] = ["4h", "24h"];

/** Pairs that always get refreshed on the fallback schedule. */
const ALL_PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE"];

export async function handler(event: SQSEvent | ScheduledEvent, _context: Context): Promise<void> {
  const sqsEvent = event as SQSEvent;

  // Scheduled EventBridge event has no Records array.
  if (!sqsEvent.Records || sqsEvent.Records.length === 0) {
    console.log("[AggregatorHandler] Scheduled fallback — recomputing all pairs");
    await recomputeAll(ALL_PAIRS);
    return;
  }

  // SQS path: process each enriched news message.
  for (const record of sqsEvent.Records) {
    let enrichedArticle: {
      newsId?: string;
      mentionedPairs?: string[];
      duplicateOf?: string | null;
    };

    try {
      const message = JSON.parse(record.body) as {
        type: string;
        data: typeof enrichedArticle;
      };
      enrichedArticle = message.data ?? {};
    } catch (err) {
      console.error(`[AggregatorHandler] Failed to parse SQS record: ${(err as Error).message}`);
      continue;
    }

    // Skip duplicates — they don't carry novel sentiment.
    if (enrichedArticle.duplicateOf) {
      console.log(`[AggregatorHandler] Skipping duplicate article: ${enrichedArticle.newsId}`);
      continue;
    }

    const pairs = enrichedArticle.mentionedPairs ?? [];
    if (pairs.length === 0) {
      console.log(`[AggregatorHandler] No mentionedPairs for article: ${enrichedArticle.newsId}`);
      continue;
    }

    await recomputeAll(pairs);
  }
}

async function recomputeAll(pairs: string[]): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  for (const pair of pairs) {
    for (const window of WINDOWS) {
      tasks.push(
        recomputeSentimentAggregate(pair, window).catch((err: Error) => {
          console.error(
            `[AggregatorHandler] recompute failed for ${pair}/${window}: ${err.message}`,
          );
        }),
      );
    }
  }
  await Promise.all(tasks);
}
