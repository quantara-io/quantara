/**
 * pnl-simulation.service.ts
 *
 * Paper-trading PnL simulation from signal_outcomes data.
 *
 * For each resolved outcome record in the requested window, a trade is
 * synthesised using priceAtSignal as the entry price, priceAtResolution as
 * the exit price, and the signal type to determine direction (buy → long,
 * sell → short, hold → skipped).
 *
 * Assumptions (documented in the endpoint's caveat tooltip):
 *   - Signals are executed at emit-bar close price (priceAtSignal).
 *   - No slippage or order-book effects.
 *   - Fixed position size per trade (default $100).
 *   - Round-trip fee deducted from gross PnL (default 5 bps = 0.05%).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { PAIRS } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Table references
// ---------------------------------------------------------------------------

const SIGNAL_OUTCOMES_TABLE =
  process.env.TABLE_SIGNAL_OUTCOMES ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signal-outcomes`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EquityCurvePoint {
  /** ISO 8601 timestamp — the resolvedAt of the corresponding trade. */
  ts: string;
  /** Running cumulative PnL in USD at this point. */
  cumulativeUsd: number;
}

export interface DrawdownResult {
  /** Maximum drawdown in absolute USD terms (always >= 0). */
  maxUsd: number;
  /**
   * Maximum drawdown as a fraction of the peak equity reached before the
   * trough (0–1). Zero when there were no winning streaks at all.
   */
  maxPct: number;
  /**
   * Duration of the largest drawdown in fractional calendar days,
   * measured from the peak timestamp to the trough timestamp.
   * Zero when there was no drawdown.
   */
  durationDays: number;
}

export interface PerSliceStats {
  trades: number;
  pnlUsd: number;
  winRate: number | null;
}

export interface PnlSimulationResult {
  windowStart: string;
  windowEnd: string;
  trades: {
    count: number;
    wins: number;
    losses: number;
    neutral: number;
  };
  pnl: {
    totalUsd: number;
    avgPerTradeUsd: number;
    bestUsd: number;
    worstUsd: number;
  };
  equityCurve: EquityCurvePoint[];
  drawdown: DrawdownResult;
  perPair: Record<string, PerSliceStats>;
  perTimeframe: Record<string, PerSliceStats>;
}

export interface PnlSimulationParams {
  since?: string;
  pair?: string;
  timeframe?: string;
  /** Position size in USD per trade. Default: 100. */
  positionSizeUsd?: number;
  /** Round-trip fee in basis points. Default: 5. */
  feeBps?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface OutcomeItem {
  pair: string;
  signalId: string;
  /** "buy" | "sell" | "hold" */
  type: string;
  /** "correct" | "incorrect" | "neutral" */
  outcome: string;
  priceAtSignal: number;
  priceAtResolution: number;
  resolvedAt: string;
  emittingTimeframe: string;
  /** If true, this record was excluded from accuracy counts due to invalidation. */
  invalidatedExcluded?: boolean;
}

/**
 * Query all non-pending outcomes for the given pairs within the window.
 *
 * signal-outcomes table: PK=pair, SK=signalId.
 * We filter by resolvedAt to stay within the requested window and exclude
 * hold-type signals (they have no directional PnL contribution) and
 * invalidated-excluded rows.
 */
async function queryOutcomeItems(
  pairs: readonly string[],
  sinceIso: string,
  untilIso: string,
  pairFilter?: string,
  timeframeFilter?: string,
): Promise<OutcomeItem[]> {
  const targetPairs = pairFilter ? [pairFilter] : pairs;
  const results: OutcomeItem[] = [];

  await Promise.all(
    targetPairs.map(async (pair) => {
      let lastKey: Record<string, unknown> | undefined;
      do {
        const result = await client.send(
          new QueryCommand({
            TableName: SIGNAL_OUTCOMES_TABLE,
            KeyConditionExpression: "#pair = :pair",
            // Filter on resolvedAt to stay within the requested window.
            // Also exclude invalidated records, hold signals (no direction),
            // and pending outcomes (no priceAtResolution yet).
            FilterExpression:
              "#resolvedAt BETWEEN :since AND :until" +
              " AND #invalidatedExcluded <> :true_val" +
              " AND #type <> :hold",
            ExpressionAttributeNames: {
              "#pair": "pair",
              "#resolvedAt": "resolvedAt",
              "#invalidatedExcluded": "invalidatedExcluded",
              "#type": "type",
            },
            ExpressionAttributeValues: {
              ":pair": pair,
              ":since": sinceIso,
              ":until": untilIso,
              ":true_val": true,
              ":hold": "hold",
            },
            ExclusiveStartKey: lastKey,
          }),
        );
        for (const item of result.Items ?? []) {
          const row = item as OutcomeItem;
          // Apply optional timeframe filter post-query.
          if (timeframeFilter && row.emittingTimeframe !== timeframeFilter) continue;
          results.push(row);
        }
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey !== undefined);
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Pure math helpers (exported for testing)
// ---------------------------------------------------------------------------

export interface TradeResult {
  pnlUsd: number;
  grossPnlUsd: number;
  feeUsd: number;
  direction: "long" | "short";
}

/**
 * Compute the PnL for a single paper trade.
 *
 * Long (buy):  pnl = positionSize × (closePrice − openPrice) / openPrice − fee
 * Short (sell): pnl = positionSize × (openPrice − closePrice) / openPrice − fee
 * Fee is applied once as a round-trip: positionSize × (feeBps / 10000).
 */
export function computeTradePnl(
  type: "buy" | "sell",
  openPrice: number,
  closePrice: number,
  positionSizeUsd: number,
  feeBps: number,
): TradeResult {
  const priceMove = closePrice - openPrice;
  const direction = type === "buy" ? "long" : "short";
  const directedReturn = direction === "long" ? priceMove / openPrice : -priceMove / openPrice;
  const grossPnlUsd = positionSizeUsd * directedReturn;
  // Round-trip fee: bps is per-side, feeBps is round-trip total.
  const feeUsd = positionSizeUsd * (feeBps / 10_000);
  const pnlUsd = grossPnlUsd - feeUsd;
  return { pnlUsd, grossPnlUsd, feeUsd, direction };
}

/**
 * Build an equity curve from a time-ordered list of per-trade PnL values.
 *
 * Returns an array of { ts, cumulativeUsd } with monotonically increasing
 * timestamps (same as the input trade order). The curve includes one point
 * per trade, representing the running cumulative PnL after that trade closes.
 */
export function buildEquityCurve(
  trades: Array<{ ts: string; pnlUsd: number }>,
): EquityCurvePoint[] {
  let cumulative = 0;
  return trades.map(({ ts, pnlUsd }) => {
    cumulative += pnlUsd;
    return { ts, cumulativeUsd: cumulative };
  });
}

/**
 * Compute maximum drawdown from an equity curve.
 *
 * The drawdown at each point is measured from the running peak to the current
 * equity level. The maximum drawdown is the largest such dip.
 *
 * @param curve  Time-ordered equity curve (output of buildEquityCurve).
 * @returns      DrawdownResult with maxUsd, maxPct, and durationDays.
 */
export function computeDrawdown(curve: EquityCurvePoint[]): DrawdownResult {
  if (curve.length === 0) {
    return { maxUsd: 0, maxPct: 0, durationDays: 0 };
  }

  let peak = curve[0].cumulativeUsd;
  let peakTs = curve[0].ts;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let maxDrawdownDurationDays = 0;

  // Track the trough corresponding to the max-drawdown peak so we can
  // compute duration.
  let bestPeakTs = curve[0].ts;
  let bestTroughTs = curve[0].ts;

  for (const point of curve) {
    if (point.cumulativeUsd > peak) {
      peak = point.cumulativeUsd;
      peakTs = point.ts;
    }

    const drawdownUsd = peak - point.cumulativeUsd;
    const drawdownPct = peak > 0 ? drawdownUsd / peak : 0;

    if (drawdownUsd > maxDrawdownUsd) {
      maxDrawdownUsd = drawdownUsd;
      maxDrawdownPct = drawdownPct;
      bestPeakTs = peakTs;
      bestTroughTs = point.ts;
    }
  }

  const peakMs = new Date(bestPeakTs).getTime();
  const troughMs = new Date(bestTroughTs).getTime();
  maxDrawdownDurationDays = Math.max(0, (troughMs - peakMs) / (86_400_000));

  return {
    maxUsd: maxDrawdownUsd,
    maxPct: maxDrawdownPct,
    durationDays: maxDrawdownDurationDays,
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Run a paper-trading PnL simulation over signal-outcomes data.
 *
 * @param params  Simulation parameters (window, filters, position sizing, fees).
 */
export async function getPnlSimulation(params: PnlSimulationParams): Promise<PnlSimulationResult> {
  const windowEnd = new Date().toISOString();
  const windowStart =
    params.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const positionSizeUsd = params.positionSizeUsd ?? 100;
  const feeBps = params.feeBps ?? 5;

  // Fetch all directional resolved outcomes in the window.
  const items = await queryOutcomeItems(
    PAIRS,
    windowStart,
    windowEnd,
    params.pair,
    params.timeframe,
  );

  // Sort by resolvedAt (ascending) so the equity curve is time-ordered.
  items.sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt));

  // Compute per-trade PnL.
  const tradePnls: Array<{ ts: string; pnlUsd: number; isWin: boolean; isLoss: boolean; pair: string; timeframe: string }> = [];

  for (const item of items) {
    // Skip rows without valid prices (shouldn't happen but be defensive).
    if (
      typeof item.priceAtSignal !== "number" ||
      typeof item.priceAtResolution !== "number" ||
      item.priceAtSignal <= 0
    ) {
      continue;
    }

    const type = item.type as "buy" | "sell";
    if (type !== "buy" && type !== "sell") continue;

    const trade = computeTradePnl(type, item.priceAtSignal, item.priceAtResolution, positionSizeUsd, feeBps);
    tradePnls.push({
      ts: item.resolvedAt,
      pnlUsd: trade.pnlUsd,
      isWin: trade.pnlUsd > 0,
      isLoss: trade.pnlUsd < 0,
      pair: item.pair,
      timeframe: item.emittingTimeframe,
    });
  }

  // Build equity curve and drawdown.
  const equityCurve = buildEquityCurve(tradePnls.map(({ ts, pnlUsd }) => ({ ts, pnlUsd })));
  const drawdown = computeDrawdown(equityCurve);

  // Aggregate totals.
  const count = tradePnls.length;
  const wins = tradePnls.filter((t) => t.isWin).length;
  const losses = tradePnls.filter((t) => t.isLoss).length;
  // "neutral" in PnL simulation = net PnL exactly 0 after fees (edge case, but correct).
  const neutral = tradePnls.filter((t) => !t.isWin && !t.isLoss).length;

  const totalUsd = tradePnls.reduce((sum, t) => sum + t.pnlUsd, 0);
  const avgPerTradeUsd = count > 0 ? totalUsd / count : 0;
  const pnls = tradePnls.map((t) => t.pnlUsd);
  const bestUsd = pnls.length > 0 ? Math.max(...pnls) : 0;
  const worstUsd = pnls.length > 0 ? Math.min(...pnls) : 0;

  // Per-pair breakdown.
  const perPair: Record<string, PerSliceStats> = {};
  for (const trade of tradePnls) {
    if (!perPair[trade.pair]) {
      perPair[trade.pair] = { trades: 0, pnlUsd: 0, winRate: null };
    }
    perPair[trade.pair].trades++;
    perPair[trade.pair].pnlUsd += trade.pnlUsd;
  }
  for (const [pair, stats] of Object.entries(perPair)) {
    const pairTrades = tradePnls.filter((t) => t.pair === pair);
    const directional = pairTrades.filter((t) => t.isWin || t.isLoss);
    stats.winRate = directional.length > 0 ? directional.filter((t) => t.isWin).length / directional.length : null;
    perPair[pair] = stats;
  }

  // Per-timeframe breakdown.
  const perTimeframe: Record<string, PerSliceStats> = {};
  for (const trade of tradePnls) {
    if (!perTimeframe[trade.timeframe]) {
      perTimeframe[trade.timeframe] = { trades: 0, pnlUsd: 0, winRate: null };
    }
    perTimeframe[trade.timeframe].trades++;
    perTimeframe[trade.timeframe].pnlUsd += trade.pnlUsd;
  }
  for (const [tf, stats] of Object.entries(perTimeframe)) {
    const tfTrades = tradePnls.filter((t) => t.timeframe === tf);
    const directional = tfTrades.filter((t) => t.isWin || t.isLoss);
    stats.winRate = directional.length > 0 ? directional.filter((t) => t.isWin).length / directional.length : null;
    perTimeframe[tf] = stats;
  }

  return {
    windowStart,
    windowEnd,
    trades: { count, wins, losses, neutral },
    pnl: { totalUsd, avgPerTradeUsd, bestUsd, worstUsd },
    equityCurve,
    drawdown,
    perPair,
    perTimeframe,
  };
}
