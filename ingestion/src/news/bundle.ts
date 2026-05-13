/**
 * bundle.ts — assemble a SentimentBundle for a given pair.
 *
 * A SentimentBundle combines:
 *   - Sentiment aggregates for 4h and 24h windows (from recomputeSentimentAggregate)
 *   - Current Fear & Greed index + history + 24h trend
 *
 * Used by Phase 6a (LLM ratification) to provide real sentiment context for a pair.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  recomputeSentimentAggregate,
  computeTrend24h,
  type SentimentAggregate,
  type AggregationWindow,
} from "./aggregator.js";
import type { FearGreedHistoryEntry } from "./fear-greed.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

export interface FearGreedBundle {
  value: number | null;
  classification: string | null;
  lastTimestamp: string | null;
  history: FearGreedHistoryEntry[];
  trend24h: number | null;
}

export interface SentimentBundle {
  pair: string;
  assembledAt: string;
  windows: Record<AggregationWindow, SentimentAggregate>;
  fearGreed: FearGreedBundle;
}

/**
 * Build and return a full SentimentBundle for the given pair.
 * Recomputes both windows from DynamoDB — callers that only need a cached view
 * can read directly from the sentiment-aggregates table instead.
 */
export async function buildSentimentBundle(pair: string): Promise<SentimentBundle> {
  // sentiment data is keyed by base asset (e.g., "BTC"), not trading pair
  // ("BTC/USDT") — news mentions coins, not pairs. The aggregator-handler's
  // canonical ALL_PAIRS list is bare-coin tickers.
  const baseCoin = pair.split("/")[0];
  const [result4h, result24h, fg] = await Promise.all([
    recomputeSentimentAggregate(baseCoin, "4h"),
    recomputeSentimentAggregate(baseCoin, "24h"),
    getFearGreed(),
  ]);

  return {
    pair,
    assembledAt: new Date().toISOString(),
    windows: {
      "4h": result4h.aggregate,
      "24h": result24h.aggregate,
    },
    fearGreed: fg,
  };
}

/**
 * Read the current Fear & Greed state (value, classification, history) from DynamoDB.
 * Returns nulls when the record doesn't exist yet.
 */
export async function getFearGreed(): Promise<FearGreedBundle> {
  try {
    const result = await client.send(
      new GetCommand({
        TableName: METADATA_TABLE,
        Key: { metaKey: "market:fear-greed" },
      }),
    );

    if (!result.Item) {
      return {
        value: null,
        classification: null,
        lastTimestamp: null,
        history: [],
        trend24h: null,
      };
    }

    const history = (result.Item.history as FearGreedHistoryEntry[] | undefined) ?? [];

    return {
      value: (result.Item.value as number | undefined) ?? null,
      classification: (result.Item.classification as string | undefined) ?? null,
      lastTimestamp: (result.Item.lastTimestamp as string | undefined) ?? null,
      history,
      trend24h: computeTrend24h(history),
    };
  } catch {
    return { value: null, classification: null, lastTimestamp: null, history: [], trend24h: null };
  }
}
