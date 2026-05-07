import { ema } from "./helpers.js";

export interface MacdSeries {
  line: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
}

/**
 * MACD(12, 26, 9)
 *
 * macdLine = EMA(close, 12) - EMA(close, 26)
 * signal   = EMA(macdLine, 9)
 * histogram = macdLine - signal
 *
 * Warm-up: macdLine is null for bars 0..24 (needs 26-bar EMA).
 *          signal is null for an additional 8 bars after macdLine starts.
 * All series are aligned to close length.
 */
export function macd(
  close: number[],
  fastN = 12,
  slowN = 26,
  signalN = 9,
): MacdSeries {
  const len = close.length;
  const line: (number | null)[] = new Array(len).fill(null);
  const signal: (number | null)[] = new Array(len).fill(null);
  const hist: (number | null)[] = new Array(len).fill(null);

  const emaFast = ema(close, fastN);
  const emaSlow = ema(close, slowN);

  // Build the MACD line where both EMAs are non-null.
  const macdValues: (number | null)[] = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f !== null && s !== null) {
      macdValues[i] = f - s;
      line[i] = f - s;
    }
  }

  // Compute signal as EMA(9) of the MACD line values.
  // Extract non-null MACD values with their original indices.
  const firstMacdIdx = macdValues.findIndex((v) => v !== null);
  if (firstMacdIdx === -1) return { line, signal, hist };

  // Build a compact array of MACD values starting from firstMacdIdx.
  const macdCompact = macdValues.slice(firstMacdIdx) as number[];
  // There should be no nulls after firstMacdIdx if EMA(26) is seeded correctly.
  const signalCompact = ema(macdCompact, signalN);

  // Map back to the full-length array.
  for (let i = 0; i < signalCompact.length; i++) {
    const sv = signalCompact[i];
    const lv = line[firstMacdIdx + i];
    signal[firstMacdIdx + i] = sv;
    if (sv !== null && lv !== null) {
      hist[firstMacdIdx + i] = lv - sv;
    }
  }

  return { line, signal, hist };
}

/**
 * Incremental MACD update.
 * Returns updated { emaFast, emaSlow, macdLine, signalEma, hist }.
 */
export function macdUpdate(
  prevEmaFast: number,
  prevEmaSlow: number,
  prevSignalEma: number | null,
  newClose: number,
  fastN = 12,
  slowN = 26,
  signalN = 9,
): {
  emaFast: number;
  emaSlow: number;
  macdLine: number;
  signalEma: number | null;
  hist: number | null;
} {
  const alphaFast = 2 / (fastN + 1);
  const alphaSlow = 2 / (slowN + 1);
  const alphaSignal = 2 / (signalN + 1);

  const emaFastNew = alphaFast * newClose + (1 - alphaFast) * prevEmaFast;
  const emaSlowNew = alphaSlow * newClose + (1 - alphaSlow) * prevEmaSlow;
  const macdLine = emaFastNew - emaSlowNew;

  let signalEma: number | null = null;
  let histVal: number | null = null;

  if (prevSignalEma !== null) {
    signalEma = alphaSignal * macdLine + (1 - alphaSignal) * prevSignalEma;
    histVal = macdLine - signalEma;
  }

  return {
    emaFast: emaFastNew,
    emaSlow: emaSlowNew,
    macdLine,
    signalEma,
    hist: histVal,
  };
}
