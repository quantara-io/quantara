import type { Timeframe } from "@quantara/shared";

/** Annualizing factors by timeframe (bars per year). */
export const BARS_PER_YEAR: Record<Timeframe, number> = {
  "1m": 525600,
  "5m": 105120,
  "15m": 35040,
  "1h": 8760,
  "4h": 2190,
  "1d": 365,
};

/**
 * Annualized realized volatility.
 *
 * log_returns[t] = ln(close[t] / close[t-1])
 * stdev = population stdev of last N log returns
 * realizedVol = stdev * sqrt(barsPerYear[timeframe])
 *
 * Returns null for bars with insufficient data (< N valid log returns),
 * and skips bars where close is 0 or null.
 *
 * Warm-up: bars 0..N-1 are null (need N returns → N+1 closes).
 */
export function realizedVol(close: number[], timeframe: Timeframe, n = 20): (number | null)[] {
  const len = close.length;
  const result: (number | null)[] = new Array(len).fill(null);
  const annFactor = Math.sqrt(BARS_PER_YEAR[timeframe]);

  // Pre-compute log returns (null if close[i-1] or close[i] is 0).
  const logReturns: (number | null)[] = new Array(len).fill(null);
  for (let i = 1; i < len; i++) {
    const prev = close[i - 1];
    const curr = close[i];
    if (prev > 0 && curr > 0) {
      logReturns[i] = Math.log(curr / prev);
    }
  }

  // For each bar i >= n, compute realized vol over the last n log returns.
  // Log returns are at indices i-n+1 .. i (from index 1 onwards).
  for (let i = n; i < len; i++) {
    // Collect valid returns in window [i-n+1, i] (these are log returns indexed at i).
    const window: number[] = [];
    for (let j = i - n + 1; j <= i; j++) {
      const r = logReturns[j];
      if (r !== null) window.push(r);
    }
    if (window.length < n) continue;

    // Population stdev.
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    const stdev = Math.sqrt(variance);

    result[i] = stdev * annFactor;
  }

  return result;
}
