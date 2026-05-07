import type { Timeframe } from "@quantara/shared";

/**
 * VWAP — only valid for 15m and 1h timeframes.
 *
 * Resets at 00:00 UTC daily.
 * typical_price = (high + low + close) / 3
 * vwap = sum(typical_price * volume) / sum(volume)  since session start
 *
 * Returns null for any timeframe other than "15m" or "1h".
 * Returns null for bars before the first accumulated volume > 0.
 */
export function vwap(
  high: number[],
  low: number[],
  close: number[],
  volume: number[],
  openTime: number[], // unix ms for each bar
  timeframe: Timeframe,
): (number | null)[] {
  const len = close.length;
  const result: (number | null)[] = new Array(len).fill(null);

  if (timeframe !== "15m" && timeframe !== "1h") return result;

  let cumTP = 0;
  let cumVol = 0;
  let prevDayUTC = -1;

  for (let i = 0; i < len; i++) {
    // Determine which UTC day this bar belongs to.
    const dayUTC = Math.floor(openTime[i] / 86400000); // days since epoch

    if (dayUTC !== prevDayUTC) {
      // New UTC day — reset accumulators.
      cumTP = 0;
      cumVol = 0;
      prevDayUTC = dayUTC;
    }

    const tp = (high[i] + low[i] + close[i]) / 3;
    cumTP += tp * volume[i];
    cumVol += volume[i];

    if (cumVol > 0) {
      result[i] = cumTP / cumVol;
    }
  }

  return result;
}
