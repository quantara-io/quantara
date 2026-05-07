import { sma } from "./helpers.js";

export interface StochasticSeries {
  k: (number | null)[];
  d: (number | null)[];
}

/**
 * Stochastic(14, 3, 3)
 *
 * %K = 100 * (close - lowest_low_N) / (highest_high_N - lowest_low_N)
 * Guard: if highN == lowN, set %K = 50
 * %D = SMA(%K, 3)
 *
 * Warm-up: %K is null for bars 0..12 (needs 14 bars); %D is null for bars 0..14.
 */
export function stochastic(
  high: number[],
  low: number[],
  close: number[],
  kN = 14,
  dN = 3,
): StochasticSeries {
  const len = close.length;
  const k: (number | null)[] = new Array(len).fill(null);

  for (let i = kN - 1; i < len; i++) {
    let highN = -Infinity;
    let lowN = Infinity;
    for (let j = i - kN + 1; j <= i; j++) {
      if (high[j] > highN) highN = high[j];
      if (low[j] < lowN) lowN = low[j];
    }
    const range = highN - lowN;
    if (range === 0) {
      k[i] = 50;
    } else {
      k[i] = (100 * (close[i] - lowN)) / range;
    }
  }

  // %D = SMA(%K, dN) — computed on the non-null k values mapped back.
  // Extract k values starting from the first non-null index.
  const firstKIdx = kN - 1;
  const kCompact = k.slice(firstKIdx) as number[];
  const dCompact = sma(kCompact, dN);

  const d: (number | null)[] = new Array(len).fill(null);
  for (let i = 0; i < dCompact.length; i++) {
    d[firstKIdx + i] = dCompact[i];
  }

  return { k, d };
}
