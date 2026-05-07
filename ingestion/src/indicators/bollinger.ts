import { sma } from "./helpers.js";

export interface BollingerSeries {
  upper: (number | null)[];
  mid: (number | null)[];
  lower: (number | null)[];
  bbWidth: (number | null)[];
}

/**
 * Bollinger Bands(20, 2σ)
 *
 * mid = SMA(close, 20)
 * stdev = population stdev (divides by N, not N-1) — matches TradingView default.
 * upper = mid + 2 * stdev
 * lower = mid - 2 * stdev
 * bbWidth = (upper - lower) / mid
 *
 * Warm-up: bars 0..18 are null.
 */
export function bollinger(close: number[], n = 20, mult = 2): BollingerSeries {
  const len = close.length;
  const upper: (number | null)[] = new Array(len).fill(null);
  const mid: (number | null)[] = new Array(len).fill(null);
  const lower: (number | null)[] = new Array(len).fill(null);
  const bbWidth: (number | null)[] = new Array(len).fill(null);

  const midSeries = sma(close, n);

  for (let i = n - 1; i < len; i++) {
    const m = midSeries[i];
    if (m === null) continue;

    // Population stdev over window.
    let sumSq = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const diff = close[j] - m;
      sumSq += diff * diff;
    }
    const stdev = Math.sqrt(sumSq / n);

    mid[i] = m;
    upper[i] = m + mult * stdev;
    lower[i] = m - mult * stdev;

    if (m !== 0) {
      bbWidth[i] = (upper[i]! - lower[i]!) / m;
    } else {
      bbWidth[i] = 0;
    }
  }

  return { upper, mid, lower, bbWidth };
}
