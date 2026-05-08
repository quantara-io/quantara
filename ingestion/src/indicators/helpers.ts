/**
 * Pure numeric helpers for the multi-horizon signal engine.
 *
 * All functions return aligned series (same length as input).
 * Warm-up positions (where fewer than n bars have been seen) are null.
 * Input arrays are never mutated.
 */

/**
 * Simple moving average.
 * Returns aligned series; warm-up bars (indices 0..n-2) are null.
 */
export function sma(values: number[], n: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) {
      sum += values[j];
    }
    result[i] = sum / n;
  }
  return result;
}

/**
 * Exponential moving average.
 * Seeded with SMA(values[0..n-1]) at index n-1, recursive from index n.
 * alpha = 2 / (n + 1). Warm-up bars are null.
 */
export function ema(values: number[], n: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return result;

  const alpha = 2 / (n + 1);

  // Seed with SMA of first n values.
  let prev = 0;
  for (let j = 0; j < n; j++) {
    prev += values[j];
  }
  prev /= n;
  result[n - 1] = prev;

  // Recurse from index n onward.
  for (let i = n; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    result[i] = prev;
  }
  return result;
}

/**
 * Wilder's smoothing (RMA). Used for RSI and ATR.
 * avg[t] = (avg[t-1] * (n - 1) + current[t]) / n.
 * Seeded with SMA(values[0..n-1]) at index n-1, recursive from n.
 * Warm-up bars are null.
 */
export function wilderSmooth(values: number[], n: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return result;

  // Seed with SMA of first n values.
  let prev = 0;
  for (let j = 0; j < n; j++) {
    prev += values[j];
  }
  prev /= n;
  result[n - 1] = prev;

  // Recurse from index n onward.
  for (let i = n; i < values.length; i++) {
    prev = (prev * (n - 1) + values[i]) / n;
    result[i] = prev;
  }
  return result;
}

/**
 * Slope of OLS linear regression on the trailing n values.
 * Returns aligned series; warm-up bars (indices 0..n-2) are null.
 *
 * Uses x = [0, 1, ..., n-1] as the independent variable so the slope
 * has units of (y-units per bar).
 */
export function linearRegressionSlope(values: number[], n: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);

  // Pre-compute x-mean and sum-of-squared deviations (constant for fixed n).
  const xMean = (n - 1) / 2;
  let sxx = 0;
  for (let x = 0; x < n; x++) {
    sxx += (x - xMean) * (x - xMean);
  }

  for (let i = n - 1; i < values.length; i++) {
    let sxy = 0;
    const start = i - n + 1;
    for (let x = 0; x < n; x++) {
      sxy += (x - xMean) * (values[start + x] - 0); // y-mean cancelled out in sxy below
    }
    // Full OLS: slope = Sxy / Sxx, but we need to use actual y-mean.
    // Recalculate properly: slope = sum((x - x̄)(y - ȳ)) / sum((x - x̄)²)
    // = (sum((x - x̄)*y) - ȳ * sum(x - x̄)) / Sxx
    // Since sum(x - x̄) = 0, slope = sum((x - x̄)*y) / Sxx  [sxy already computed above]
    result[i] = sxy / sxx;
  }
  return result;
}
