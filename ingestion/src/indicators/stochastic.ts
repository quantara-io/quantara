import { sma } from "./helpers.js";

export interface StochasticSeries {
  k: (number | null)[];
  d: (number | null)[];
}

/**
 * Stochastic(14, 3, 3) — TradingView "Stoch (14, 3, 3)" convention.
 *
 * raw-K[t] = 100 * (close[t] - lowest_low_N) / (highest_high_N - lowest_low_N)
 *            Guard: if highN == lowN, set raw-K = 50
 * slow-K   = SMA(raw-K, smoothK)   — the "k" value returned
 * %D       = SMA(slow-K, smoothD)
 *
 * Warm-up:
 *   raw-K is null for bars 0..kN-2  (needs kN bars)
 *   slow-K (%K) is null for bars 0..kN+smoothK-3  (kN-1 + smoothK-1)
 *   %D is null for bars 0..kN+smoothK+smoothD-4
 *
 * For the default (14, 3, 3):
 *   slow-K first non-null at bar 15  (0-indexed)
 *   %D     first non-null at bar 17
 */
export function stochastic(
  high: number[],
  low: number[],
  close: number[],
  kN = 14,
  smoothK = 3,
  smoothD = 3,
): StochasticSeries {
  const len = close.length;
  const rawK: (number | null)[] = new Array(len).fill(null);

  // Compute raw-%K over the kN-bar lookback window.
  for (let i = kN - 1; i < len; i++) {
    let highN = -Infinity;
    let lowN = Infinity;
    for (let j = i - kN + 1; j <= i; j++) {
      if (high[j] > highN) highN = high[j];
      if (low[j] < lowN) lowN = low[j];
    }
    const range = highN - lowN;
    rawK[i] = range === 0 ? 50 : (100 * (close[i] - lowN)) / range;
  }

  // slow-K = SMA(raw-K, smoothK).
  // Extract the non-null raw-K segment, apply SMA, then map back.
  const firstRawKIdx = kN - 1;
  const rawKCompact = rawK.slice(firstRawKIdx) as number[];
  const slowKCompact = sma(rawKCompact, smoothK);

  const k: (number | null)[] = new Array(len).fill(null);
  for (let i = 0; i < slowKCompact.length; i++) {
    k[firstRawKIdx + i] = slowKCompact[i];
  }

  // %D = SMA(slow-K, smoothD).
  const firstSlowKIdx = firstRawKIdx + smoothK - 1;
  const slowKForD = k.slice(firstSlowKIdx) as number[];
  const dCompact = sma(slowKForD, smoothD);

  const d: (number | null)[] = new Array(len).fill(null);
  for (let i = 0; i < dCompact.length; i++) {
    d[firstSlowKIdx + i] = dCompact[i];
  }

  return { k, d };
}
