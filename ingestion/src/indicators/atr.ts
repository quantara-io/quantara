import { wilderSmooth } from "./helpers.js";

/**
 * ATR(14) using Wilder's smoothing.
 *
 * TR[t] = max(high-low, |high-prevClose|, |low-prevClose|)
 * TR[0] = high[0] - low[0]  (no previous close)
 * ATR = wilderSmooth(TR, 14)
 *
 * Warm-up: bars 0..12 are null (needs 14 TR values to seed Wilder's RMA).
 */
export function atr(high: number[], low: number[], close: number[], n = 14): (number | null)[] {
  if (high.length === 0) {
    return [];
  }
  const len = close.length;
  const tr: number[] = new Array(len).fill(0);

  // Bar 0: no previous close.
  tr[0] = high[0] - low[0];

  for (let i = 1; i < len; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }

  return wilderSmooth(tr, n);
}

/**
 * Incremental ATR update.
 * Returns { atr, tr } for the new bar.
 */
export function atrUpdate(
  prevAtr: number,
  newHigh: number,
  newLow: number,
  prevClose: number,
  n = 14,
): { atr: number; tr: number } {
  const hl = newHigh - newLow;
  const hc = Math.abs(newHigh - prevClose);
  const lc = Math.abs(newLow - prevClose);
  const tr = Math.max(hl, hc, lc);
  const atrVal = (prevAtr * (n - 1) + tr) / n;
  return { atr: atrVal, tr };
}
