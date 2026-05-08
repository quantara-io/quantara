import { linearRegressionSlope } from "./helpers.js";

export interface OBVSeries {
  obv: number[];
  obvSlope: (number | null)[];
}

/**
 * On-Balance Volume (OBV) with slope.
 *
 * OBV[0] = 0
 * OBV[t] = OBV[t-1] + sign(close[t] - close[t-1]) * volume[t]
 *   where sign: +1 if close up, -1 if close down, 0 if unchanged.
 *
 * obvSlope = linearRegressionSlope(obv, 10)
 *
 * obv is always fully populated (no warm-up nulls).
 * obvSlope has null for bars 0..8.
 */
export function obv(close: number[], volume: number[], slopePeriod = 10): OBVSeries {
  const len = close.length;
  const obvArr: number[] = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const delta = close[i] - close[i - 1];
    const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    obvArr[i] = obvArr[i - 1] + sign * volume[i];
  }

  const obvSlope = linearRegressionSlope(obvArr, slopePeriod);

  return { obv: obvArr, obvSlope };
}

/**
 * Incremental OBV update.
 * Returns the new OBV value.
 */
export function obvUpdate(
  prevObv: number,
  newClose: number,
  prevClose: number,
  newVolume: number,
): number {
  const delta = newClose - prevClose;
  const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
  return prevObv + sign * newVolume;
}
