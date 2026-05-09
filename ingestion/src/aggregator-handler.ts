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
import {
  recomputeSentimentAggregate,
  type AggregationWindow,
  type SentimentAggregate,
} from "./news/aggregator.js";
import { getFearGreed, type SentimentBundle } from "./news/bundle.js";
import { maybeFireSentimentShockRatification } from "./news/sentiment-shock.js";

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
  // Per pair, recompute both windows in parallel, build the sentiment bundle
  // once from those results, then run shock detection on each window with the
  // shared bundle. This avoids `buildSentimentBundle` re-running
  // `recomputeSentimentAggregate` (which the shock module used to do — a
  // double DDB hit on the hot path).
  await Promise.all(pairs.map((pair) => recomputePair(pair)));
}

async function recomputePair(pair: string): Promise<void> {
  // Step 1: recompute every window. Each result independently catches errors
  // so a single window failure doesn't poison the bundle for siblings.
  const windowResults = await Promise.all(
    WINDOWS.map(async (window) => {
      try {
        const result = await recomputeSentimentAggregate(pair, window);
        return { window, result, error: null as Error | null };
      } catch (err) {
        console.error(
          `[AggregatorHandler] recompute failed for ${pair}/${window}: ${(err as Error).message}`,
        );
        return { window, result: null, error: err as Error };
      }
    }),
  );

  // If any window failed, bail before shock detection — the bundle would be
  // incomplete and shock comparisons unreliable.
  const successful = windowResults.filter((r) => r.result !== null);
  if (successful.length !== windowResults.length) return;

  // Step 2: assemble a SentimentBundle from the freshly-written aggregates.
  // Read F&G state once (the recompute loop's `getFearGreedContext` only
  // captures the trend slice; the bundle needs the full record).
  let fearGreed;
  try {
    fearGreed = await getFearGreed();
  } catch (err) {
    console.error(
      `[AggregatorHandler] fearGreed lookup failed for ${pair}: ${(err as Error).message}`,
    );
    return;
  }

  const windowsByName: Record<AggregationWindow, SentimentAggregate> = {} as Record<
    AggregationWindow,
    SentimentAggregate
  >;
  for (const r of successful) {
    windowsByName[r.window] = r.result!.aggregate;
  }

  const bundle: SentimentBundle = {
    pair,
    assembledAt: new Date().toISOString(),
    windows: windowsByName,
    fearGreed,
  };

  // Step 3: per-window shock detection. The .catch is scoped to *this* call
  // so its error log is correctly attributed (was previously misreported as
  // "recompute failed" because the wider try/catch wrapped both phases).
  await Promise.all(
    successful.map(async ({ window, result }) => {
      try {
        await maybeFireSentimentShockRatification(
          result!.previousAggregate,
          result!.aggregate,
          bundle,
        );
      } catch (err) {
        console.error(
          `[AggregatorHandler] sentiment-shock check failed for ${pair}/${window}: ${(err as Error).message}`,
        );
      }
    }),
  );
}
