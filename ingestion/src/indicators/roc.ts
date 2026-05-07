/**
 * Rate of Change (ROC)
 *
 * ROC = (close[t] - close[t-N]) / close[t-N]
 * Returns proportion (e.g. 0.05 for 5%), not percentage.
 * Warm-up: bars 0..N-1 are null.
 */
export function roc(close: number[], n: number): (number | null)[] {
  const len = close.length;
  const result: (number | null)[] = new Array(len).fill(null);

  for (let i = n; i < len; i++) {
    const prev = close[i - n];
    if (prev === 0) {
      result[i] = null;
    } else {
      result[i] = (close[i] - prev) / prev;
    }
  }

  return result;
}
