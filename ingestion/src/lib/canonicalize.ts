/**
 * Cross-exchange canonicalization — Phase 4b.
 *
 * Combines candles from multiple exchanges into a single "consensus" candle
 * per pair × timeframe using the §2 algorithm.
 *
 * Algorithm:
 *   1. Filter out exchanges with `stale: true` in the staleness map.
 *   2. Filter out exchanges that provided null (no candle for this slot).
 *   3. If fewer than 2 non-stale candles remain, return null (no consensus).
 *   4. Take the median of (open, high, low, close, volume) across non-stale candles.
 *   5. Compute dispersion = (max − min) / median of the close values.
 *   6. Return the consensus candle and the dispersion metric.
 */

import type { Candle } from "@quantara/shared";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface CanonicalizeResult {
  consensus: Candle;
  dispersion: number;
}

/**
 * Combine candles from multiple exchanges into a single "consensus" candle
 * per pair × timeframe.
 *
 * @param perExchangeCandles  Map of exchange → most-recent Candle (null if exchange
 *   has no candle for this slot).
 * @param exchangeStaleness   Map of exchange → stale flag. Stale exchanges are excluded
 *   from the consensus calculation.
 *
 * Returns null when fewer than 2 non-stale candles are available (≥2/3 stale).
 */
export function canonicalizeCandle(
  perExchangeCandles: Record<string, Candle | null>,
  exchangeStaleness: Record<string, boolean>,
): CanonicalizeResult | null {
  // Step 1+2: Collect non-stale, non-null candles.
  const eligible: Candle[] = [];
  for (const [exchange, candle] of Object.entries(perExchangeCandles)) {
    if (exchangeStaleness[exchange]) continue; // stale — skip
    if (candle === null) continue; // no candle for this slot — skip
    eligible.push(candle);
  }

  // Step 3: Need at least 2 eligible sources for a consensus.
  if (eligible.length < 2) return null;

  // Step 4: Compute per-field medians.
  const opens = eligible.map((c) => c.open);
  const highs = eligible.map((c) => c.high);
  const lows = eligible.map((c) => c.low);
  const closes = eligible.map((c) => c.close);
  const volumes = eligible.map((c) => c.volume);

  const medianClose = median(closes);
  const medianOpen = median(opens);
  const medianHigh = median(highs);
  const medianLow = median(lows);
  const medianVolume = median(volumes);

  // Step 5: Dispersion = (max − min) / median of close prices.
  const maxClose = Math.max(...closes);
  const minClose = Math.min(...closes);
  const dispersion = medianClose > 0 ? (maxClose - minClose) / medianClose : 0;

  // Step 6: Assemble the consensus candle using metadata from the first eligible candle.
  // The "consensus" exchange label makes it clear this is not a per-exchange state.
  const reference = eligible[0]!;
  const consensus: Candle = {
    exchange: "consensus",
    symbol: reference.symbol,
    pair: reference.pair,
    timeframe: reference.timeframe,
    openTime: reference.openTime,
    closeTime: reference.closeTime,
    open: medianOpen,
    high: medianHigh,
    low: medianLow,
    close: medianClose,
    volume: medianVolume,
    isClosed: reference.isClosed,
  };

  return { consensus, dispersion };
}
