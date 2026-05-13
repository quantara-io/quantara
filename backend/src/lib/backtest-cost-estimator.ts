/**
 * backtest-cost-estimator.ts — Phase 4 follow-up.
 *
 * Thin wrapper around the shared pure cost-estimator math in
 * `quantara-backtest/cost/estimator-pure`. Both POST /admin/backtest (the
 * submission path) and POST /admin/backtest/estimate (the live preview the
 * admin UI calls) route through here so there is exactly ONE estimator
 * implementation in the backend.
 *
 * Resolves PR #376 review finding 2 (cost estimator duplicated, gate-rate
 * query and ×4 multi-TF multiplier dropped). This file now sources both
 * from the shared module instead of re-deriving them.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  computeEstimateMath,
  DEFAULT_GATE_RATE,
  GATE_RATE_FLOOR,
  GATE_RATE_CEILING,
  type RatificationCostEstimate,
  type RatificationModel,
} from "quantara-backtest/cost/estimator-pure";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const RATIFICATIONS_TABLE =
  process.env.TABLE_RATIFICATIONS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratifications`;

export interface EstimateBacktestInput {
  pair: string;
  timeframe: string;
  from: string; // ISO-8601
  to: string; // ISO-8601
  ratificationMode: "none" | "skip-bedrock" | "replay-bedrock";
  /** Strategy name — presence triggers the multi-TF × 4 multiplier. */
  strategy?: string;
  model?: RatificationModel;
}

/** Query the production ratifications table for the last 30 days, return the
 * observed validation.ok rate clamped to [GATE_RATE_FLOOR, GATE_RATE_CEILING].
 * Falls back to DEFAULT_GATE_RATE on empty or unreachable. */
export async function queryGateRate(pair: string, days = 30): Promise<number> {
  const cutoffISO = new Date(Date.now() - days * 86_400_000).toISOString();
  let gatedRate = DEFAULT_GATE_RATE;
  let okCount = 0;
  let totalCount = 0;
  let lastKey: Record<string, unknown> | undefined;

  try {
    do {
      const result = await ddb.send(
        new QueryCommand({
          TableName: RATIFICATIONS_TABLE,
          KeyConditionExpression: "#pair = :pair AND sk >= :skFrom",
          ExpressionAttributeNames: { "#pair": "pair" },
          ExpressionAttributeValues: { ":pair": pair, ":skFrom": cutoffISO },
          ScanIndexForward: false,
          Limit: 1000,
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of result.Items ?? []) {
        const validation = (item as { validation?: { ok?: unknown } }).validation;
        if (validation && typeof validation === "object") {
          totalCount += 1;
          if (validation.ok === true) okCount += 1;
        }
      }
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey !== undefined);

    if (totalCount > 0) {
      const rawRate = okCount / totalCount;
      gatedRate = Math.max(GATE_RATE_FLOOR, Math.min(GATE_RATE_CEILING, rawRate));
    }
  } catch (err) {
    console.warn(
      `[backtest-cost-estimator] ratifications table query failed — using DEFAULT_GATE_RATE: ${(err as Error).message}`,
    );
    return DEFAULT_GATE_RATE;
  }

  return gatedRate;
}

/**
 * Estimate the Bedrock ratification cost for a (possibly multi-pair × multi-TF)
 * backtest submission. The caller has already split the cross-product into
 * leaf runs; this function returns the cost of a single leaf. Sum across
 * leaves at the submission site for the displayed total.
 *
 * Skip / none modes always return $0.
 */
export async function estimateBacktestCost(
  input: EstimateBacktestInput,
): Promise<RatificationCostEstimate> {
  const model: RatificationModel = input.model ?? "haiku";

  if (input.ratificationMode !== "replay-bedrock") {
    return computeEstimateMath({
      fromMs: new Date(input.from).getTime(),
      toMs: new Date(input.to).getTime(),
      timeframe: input.timeframe,
      multiTf: input.strategy !== undefined,
      gatedRate: 0, // forces estimatedCalls = 0 and estimatedCostUsd = 0
      model,
    });
  }

  const gatedRate = await queryGateRate(input.pair);
  return computeEstimateMath({
    fromMs: new Date(input.from).getTime(),
    toMs: new Date(input.to).getTime(),
    timeframe: input.timeframe,
    multiTf: input.strategy !== undefined,
    gatedRate,
    model,
  });
}
