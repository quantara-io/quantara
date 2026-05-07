import { sma } from "./helpers.js";

/**
 * Volume Z-Score
 *
 * z = (volume[t] - SMA(volume, 20)) / stdev(volume, 20)
 * stdev uses population variance (divides by N).
 * Guard: if stdev == 0, return 0.
 *
 * Warm-up: bars 0..18 are null.
 */
export function volumeZscore(volume: number[], n = 20): (number | null)[] {
  const len = volume.length;
  const result: (number | null)[] = new Array(len).fill(null);

  const avgSeries = sma(volume, n);

  for (let i = n - 1; i < len; i++) {
    const avg = avgSeries[i];
    if (avg === null) continue;

    // Population stdev.
    let sumSq = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const diff = volume[j] - avg;
      sumSq += diff * diff;
    }
    const stdev = Math.sqrt(sumSq / n);

    if (stdev === 0) {
      result[i] = 0;
    } else {
      result[i] = (volume[i] - avg) / stdev;
    }
  }

  return result;
}
