import { wilderSmooth } from "./helpers.js";

/**
 * RSI(14) using Wilder's RMA.
 *
 * Returns aligned series (same length as input); first 14 bars are null.
 * Formula: RSI = 100 - 100 / (1 + RS)
 * where RS = wilderSmooth(gains, 14) / wilderSmooth(losses, 14).
 */
export function rsi(close: number[], n = 14): (number | null)[] {
  const len = close.length;
  const result: (number | null)[] = new Array(len).fill(null);

  if (len < n + 1) return result;

  // Build raw gain/loss series (length = len, index 0 is always null because no prior bar).
  const gains: number[] = new Array(len).fill(0);
  const losses: number[] = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const delta = close[i] - close[i - 1];
    gains[i] = delta > 0 ? delta : 0;
    losses[i] = delta < 0 ? -delta : 0;
  }

  // wilderSmooth needs the full array including the placeholder 0 at index 0.
  // We start the smoothing from index 1 to give it n=14 real values.
  // However, wilderSmooth seeds from the SMA of the first n values.
  // We pass gains[1..len-1] for the smoothing, then shift results back.
  const smoothedGains = wilderSmooth(gains.slice(1), n);
  const smoothedLosses = wilderSmooth(losses.slice(1), n);

  // Smoothed series is indexed 0..len-2 (relative to gains[1..]).
  // First non-null smoothed value is at index n-1 (relative), which corresponds
  // to bar index n in the original close array.
  for (let i = n - 1; i < len - 1; i++) {
    const avgGain = smoothedGains[i];
    const avgLoss = smoothedLosses[i];
    if (avgGain === null || avgLoss === null) continue;
    if (avgLoss === 0) {
      // Flat window: no losses. Return 100 only when there are actual gains;
      // if avgGain is also 0 (identical closes), return 50 (neutral).
      result[i + 1] = avgGain > 0 ? 100 : 50;
    } else {
      const rs = avgGain / avgLoss;
      result[i + 1] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}

/**
 * Incremental RSI update.
 * Given the current smoothed avgGain and avgLoss, and the new close delta,
 * returns the new { rsi, avgGain, avgLoss }.
 */
export function rsiUpdate(
  prevAvgGain: number,
  prevAvgLoss: number,
  newClose: number,
  prevClose: number,
  n = 14,
): { rsi: number; avgGain: number; avgLoss: number } {
  const delta = newClose - prevClose;
  const gain = delta > 0 ? delta : 0;
  const loss = delta < 0 ? -delta : 0;
  const avgGain = (prevAvgGain * (n - 1) + gain) / n;
  const avgLoss = (prevAvgLoss * (n - 1) + loss) / n;
  // Flat window guard: if no losses, return 100 only when there are gains;
  // if both are 0 (identical closes), return 50 (neutral).
  const rsiVal =
    avgLoss === 0
      ? avgGain > 0
        ? 100
        : 50
      : 100 - 100 / (1 + avgGain / avgLoss);
  return { rsi: rsiVal, avgGain, avgLoss };
}
