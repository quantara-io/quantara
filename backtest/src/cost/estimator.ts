/**
 * Cost estimator — Phase 2.
 *
 * Estimates Bedrock ratification cost for a backtest run before it starts.
 * Uses production token cost constants and historical gate-rate from the
 * ratifications table to produce a pre-run cost estimate.
 *
 * Design: Phase 2 issue #369 §4.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { BacktestInput } from "../engine.js";
import type { HistoricalCandleStore } from "../store/candle-store.js";

// ---------------------------------------------------------------------------
// Pricing constants (from admin-debug.service.ts — keep in sync)
// Source: Anthropic Bedrock pricing as of 2026-Q1.
// ---------------------------------------------------------------------------

/** Haiku 4.5 input price per 1M tokens, USD. */
export const HAIKU_INPUT_PRICE_PER_M = 0.25;
/** Haiku 4.5 output price per 1M tokens, USD. */
export const HAIKU_OUTPUT_PRICE_PER_M = 1.25;
/** Sonnet 4.6 input price per 1M tokens, USD. */
export const SONNET_INPUT_PRICE_PER_M = 3.0;
/** Sonnet 4.6 output price per 1M tokens, USD. */
export const SONNET_OUTPUT_PRICE_PER_M = 15.0;

/** Estimated tokens per ratification call (from observed force-ratification call shape). */
export const EST_INPUT_TOKENS_PER_CALL = 700;
export const EST_OUTPUT_TOKENS_PER_CALL = 150;

/** Estimated Bedrock invocation latency per call (ms). */
const EST_LATENCY_MS_PER_CALL = 3_000;

/** Default gate rate when the ratifications table is empty or unreachable. */
export const DEFAULT_GATE_RATE = 0.004; // 0.4%

/** Sanity bounds for gated rate [floor, ceiling]. */
export const GATE_RATE_FLOOR = 0.001;
export const GATE_RATE_CEILING = 0.5;

/** Milliseconds per bar for each signal TF. */
const TF_MS: Record<string, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

// Number of signal TFs run in multi-TF blend mode.
const SIGNAL_TF_COUNT = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RatificationModel = "haiku" | "sonnet";

export interface RatificationCostEstimate {
  /** Number of candle closes in the eval window (across all signal TFs). */
  closes: number;
  /** Fraction of closes that are expected to reach the LLM gate. */
  gatedRate: number;
  /** Estimated number of Bedrock invocations. */
  estimatedCalls: number;
  estimatedTokens: { input: number; output: number };
  /** Estimated total cost in USD. */
  estimatedCostUsd: number;
  /** Estimated total latency in ms (sum of serial call latencies). */
  estimatedLatencyMs: number;
  model: RatificationModel;
  /**
   * Source of pricing constants.
   * Will always be "code-comment-as-of-2026-Q1" until constants are moved to a config file.
   */
  pricingSource: string;
}

// ---------------------------------------------------------------------------
// RatificationsStore interface (subset — only what estimator needs)
// ---------------------------------------------------------------------------

export interface RatificationsStore {
  /**
   * Query the ratifications table for records in the last N days.
   * Returns an array of objects with at least a `validation` field.
   */
  queryRecent(
    pair: string,
    days: number,
  ): Promise<Array<{ validation: { ok: boolean; reason?: string } }>>;
}

// ---------------------------------------------------------------------------
// DDB-backed RatificationsStore
// ---------------------------------------------------------------------------

export class DdbRatificationsStore implements RatificationsStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string) {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this.tableName =
      tableName ??
      process.env.TABLE_RATIFICATIONS ??
      `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratifications`;
  }

  async queryRecent(
    pair: string,
    days: number,
  ): Promise<Array<{ validation: { ok: boolean; reason?: string } }>> {
    const cutoffMs = Date.now() - days * 86_400_000;
    const cutoffISO = new Date(cutoffMs).toISOString();

    const items: Array<{ validation: { ok: boolean; reason?: string } }> = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "#pair = :pair AND sk >= :skFrom",
          ExpressionAttributeNames: { "#pair": "pair" },
          ExpressionAttributeValues: { ":pair": pair, ":skFrom": cutoffISO },
          ScanIndexForward: false,
          Limit: 1000,
          ExclusiveStartKey: lastKey,
        }),
      );

      if (result.Items) {
        for (const item of result.Items) {
          if (item["validation"]) {
            items.push(item as { validation: { ok: boolean } });
          }
        }
      }
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey !== undefined);

    return items;
  }
}

// ---------------------------------------------------------------------------
// estimateRatificationCost
// ---------------------------------------------------------------------------

/**
 * Estimate the Bedrock ratification cost for a backtest run.
 *
 * `gatedRate` derivation:
 *   1. Query the production ratifications table for the last 30 days.
 *   2. Compute count(validation.ok === true) / count(*).
 *   3. Fallback to DEFAULT_GATE_RATE (0.4%) if the table is empty.
 *   4. Clamp to [GATE_RATE_FLOOR, GATE_RATE_CEILING] for sanity.
 *
 * Estimated closes = barCount(period, "15m") × SIGNAL_TF_COUNT
 * (because multi-TF blend runs all 4 TFs for every 15m boundary).
 */
export async function estimateRatificationCost(
  input: BacktestInput,
  model: RatificationModel,
  _candleStore: HistoricalCandleStore,
  ratificationsStore: RatificationsStore,
): Promise<RatificationCostEstimate> {
  const periodMs = input.to.getTime() - input.from.getTime();

  // Sanity: zero or negative period → zero cost.
  if (periodMs <= 0) {
    return zeroEstimate(model);
  }

  // Count 15m bars in the period (emitting TF is always 15m in multi-TF mode).
  const tfMs15m = TF_MS["15m"] ?? 900_000;
  const bars15m = Math.floor(periodMs / tfMs15m);

  // Total signal evaluations = 15m bars × 4 signal TFs.
  const closes = bars15m * SIGNAL_TF_COUNT;

  // Query gate rate from production ratifications table.
  let gatedRate = DEFAULT_GATE_RATE;
  let usedFallback = false;

  try {
    const records = await ratificationsStore.queryRecent(input.pair, 30);
    if (records.length > 0) {
      const okCount = records.filter((r) => r.validation.ok === true).length;
      const rawRate = okCount / records.length;
      // Clamp to sanity bounds.
      gatedRate = Math.max(GATE_RATE_FLOOR, Math.min(GATE_RATE_CEILING, rawRate));
    } else {
      usedFallback = true;
    }
  } catch {
    usedFallback = true;
    console.warn(
      "[backtest/estimator] Ratifications table unreachable — using default gate rate of " +
        `${(DEFAULT_GATE_RATE * 100).toFixed(2)}%`,
    );
  }

  if (usedFallback) {
    console.warn(
      "[backtest/estimator] No ratification history found — using default gate rate of " +
        `${(DEFAULT_GATE_RATE * 100).toFixed(2)}%`,
    );
  }

  const estimatedCalls = Math.round(closes * gatedRate);

  const inputTokens = estimatedCalls * EST_INPUT_TOKENS_PER_CALL;
  const outputTokens = estimatedCalls * EST_OUTPUT_TOKENS_PER_CALL;

  const inputPricePerM = model === "haiku" ? HAIKU_INPUT_PRICE_PER_M : SONNET_INPUT_PRICE_PER_M;
  const outputPricePerM = model === "haiku" ? HAIKU_OUTPUT_PRICE_PER_M : SONNET_OUTPUT_PRICE_PER_M;

  const estimatedCostUsd =
    (inputTokens / 1_000_000) * inputPricePerM + (outputTokens / 1_000_000) * outputPricePerM;

  const estimatedLatencyMs = estimatedCalls * EST_LATENCY_MS_PER_CALL;

  return {
    closes,
    gatedRate,
    estimatedCalls,
    estimatedTokens: { input: inputTokens, output: outputTokens },
    estimatedCostUsd,
    estimatedLatencyMs,
    model,
    pricingSource: "code-comment-as-of-2026-Q1",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroEstimate(model: RatificationModel): RatificationCostEstimate {
  return {
    closes: 0,
    gatedRate: DEFAULT_GATE_RATE,
    estimatedCalls: 0,
    estimatedTokens: { input: 0, output: 0 },
    estimatedCostUsd: 0,
    estimatedLatencyMs: 0,
    model,
    pricingSource: "code-comment-as-of-2026-Q1",
  };
}
