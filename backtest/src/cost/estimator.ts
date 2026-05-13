/**
 * Cost estimator — Phase 2.
 *
 * Estimates Bedrock ratification cost for a backtest run before it starts.
 * Uses production token cost constants and historical gate-rate from the
 * ratifications table to produce a pre-run cost estimate.
 *
 * Design: Phase 2 issue #369 §4.
 *
 * Phase 4 follow-up: the pure pricing/math constants moved to
 * `./estimator-pure.ts` so the backend admin route can share the SAME
 * estimator without pulling in BacktestInput / ingestion deps.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { BacktestInput } from "../engine.js";
import type { HistoricalCandleStore } from "../store/candle-store.js";
import {
  DEFAULT_GATE_RATE,
  GATE_RATE_FLOOR,
  GATE_RATE_CEILING,
  computeEstimateMath,
  zeroEstimate,
  type RatificationCostEstimate,
  type RatificationModel,
} from "./estimator-pure.js";

// Re-exports — keep the surface the existing imports rely on.
export {
  HAIKU_INPUT_PRICE_PER_M,
  HAIKU_OUTPUT_PRICE_PER_M,
  SONNET_INPUT_PRICE_PER_M,
  SONNET_OUTPUT_PRICE_PER_M,
  EST_INPUT_TOKENS_PER_CALL,
  EST_OUTPUT_TOKENS_PER_CALL,
  DEFAULT_GATE_RATE,
  GATE_RATE_FLOOR,
  GATE_RATE_CEILING,
  computeEstimateMath,
} from "./estimator-pure.js";

export type { RatificationCostEstimate, RatificationModel } from "./estimator-pure.js";

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
// Gate-rate helper — DDB query + clamp + DEFAULT fallback.
// Exposed so the backend admin route can share the SAME derivation path
// instead of re-implementing the fallback / clamp logic.
// ---------------------------------------------------------------------------

/**
 * Resolve the gate rate for a given pair against the ratifications DDB table.
 * Clamps to [GATE_RATE_FLOOR, GATE_RATE_CEILING] and falls back to
 * DEFAULT_GATE_RATE when the table is empty or unreachable.
 */
export async function resolveGateRate(
  ratificationsStore: RatificationsStore,
  pair: string,
  days = 30,
): Promise<number> {
  let gatedRate = DEFAULT_GATE_RATE;
  let fallbackReason: "empty" | "unreachable" | null = null;

  try {
    const records = await ratificationsStore.queryRecent(pair, days);
    if (records.length > 0) {
      const okCount = records.filter((r) => r.validation.ok === true).length;
      const rawRate = okCount / records.length;
      gatedRate = Math.max(GATE_RATE_FLOOR, Math.min(GATE_RATE_CEILING, rawRate));
    } else {
      fallbackReason = "empty";
    }
  } catch {
    fallbackReason = "unreachable";
  }

  if (fallbackReason !== null) {
    const why = fallbackReason === "unreachable" ? "table unreachable" : "no history found";
    console.warn(
      `[backtest/estimator] Ratifications ${why} — using default gate rate of ` +
        `${(DEFAULT_GATE_RATE * 100).toFixed(2)}%`,
    );
  }

  return gatedRate;
}

// ---------------------------------------------------------------------------
// estimateRatificationCost — engine-side entry point.
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
 * Estimated closes:
 *   - Multi-TF blend (`input.strategy` provided): barCount(period, "15m") × 4
 *     (all 4 signal TFs re-scored at every emitting-TF boundary).
 *   - Single-TF (no strategy): barCount(period, input.timeframe) × 1.
 */
export async function estimateRatificationCost(
  input: BacktestInput,
  model: RatificationModel,
  _candleStore: HistoricalCandleStore,
  ratificationsStore: RatificationsStore,
): Promise<RatificationCostEstimate> {
  const periodMs = input.to.getTime() - input.from.getTime();
  if (periodMs <= 0) return zeroEstimate(model);

  const multiTf = input.strategy !== undefined;
  const gatedRate = await resolveGateRate(ratificationsStore, input.pair, 30);

  return computeEstimateMath({
    fromMs: input.from.getTime(),
    toMs: input.to.getTime(),
    timeframe: input.timeframe,
    multiTf,
    gatedRate,
    model,
  });
}
