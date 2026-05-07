import type { Candle, Timeframe } from "@quantara/shared";
import type { IndicatorState } from "@quantara/shared";

import { ema } from "./helpers.js";
import { rsi } from "./rsi.js";
import { macd } from "./macd.js";
import { atr } from "./atr.js";
import { bollinger } from "./bollinger.js";
import { realizedVol } from "./realized-vol.js";
import { obv } from "./obv.js";
import { vwap } from "./vwap.js";
import { volumeZscore } from "./volume-zscore.js";

export {
  rsi,
  rsiUpdate,
} from "./rsi.js";
export { macd, macdUpdate } from "./macd.js";
export { stochastic } from "./stochastic.js";
export { roc } from "./roc.js";
export { atr, atrUpdate } from "./atr.js";
export { bollinger } from "./bollinger.js";
export { realizedVol, BARS_PER_YEAR } from "./realized-vol.js";
export { obv, obvUpdate } from "./obv.js";
export { vwap } from "./vwap.js";
export { volumeZscore } from "./volume-zscore.js";
export {
  sma,
  ema,
  wilderSmooth,
  linearRegressionSlope,
} from "./helpers.js";

/** History ring buffer size — last N bars, most recent first. */
const HISTORY_SIZE = 5;

/**
 * Aggregator: run all indicators over the candle series and return the
 * fully-populated IndicatorState at the latest bar.
 *
 * @param candles - closed candles in chronological order (oldest first)
 * @param context - metadata carried through to IndicatorState
 */
export function buildIndicatorState(
  candles: Candle[],
  context: {
    pair: string;
    exchange: string;
    timeframe: Timeframe;
    fearGreed: number | null;
    dispersion: number | null;
  },
): IndicatorState {
  if (candles.length === 0) {
    throw new Error("buildIndicatorState: candles array is empty");
  }
  const len = candles.length;

  // Extract scalar series.
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const openTimes = candles.map((c) => c.openTime);

  // Compute all indicators.
  const rsiSeries = rsi(closes);
  const macdSeries = macd(closes);
  const ema20Series = ema(closes, 20);
  const ema50Series = ema(closes, 50);
  const ema200Series = ema(closes, 200);
  const atrSeries = atr(highs, lows, closes);
  const bbSeries = bollinger(closes);
  const obvSeries = obv(closes, volumes);
  const vwapSeries = vwap(highs, lows, closes, volumes, openTimes, context.timeframe);
  const volZSeries = volumeZscore(volumes);
  const rvSeries = realizedVol(closes, context.timeframe);

  // Latest index.
  const last = len - 1;

  // Helper: pick trailing HISTORY_SIZE values ending at `last`, most recent first.
  function trailNull(series: (number | null)[]): (number | null)[] {
    const out: (number | null)[] = [];
    for (let i = last; i >= 0 && out.length < HISTORY_SIZE; i--) {
      out.push(series[i]);
    }
    while (out.length < HISTORY_SIZE) out.push(null);
    return out;
  }

  function trailNum(series: number[]): (number | null)[] {
    const out: (number | null)[] = [];
    for (let i = last; i >= 0 && out.length < HISTORY_SIZE; i--) {
      out.push(series[i]);
    }
    // Pad with null (not 0) so callers can distinguish missing bars from real flat bars.
    while (out.length < HISTORY_SIZE) out.push(null);
    return out;
  }

  const asOf = candles[last]?.closeTime ?? 0;

  return {
    pair: context.pair,
    exchange: context.exchange,
    timeframe: context.timeframe,
    asOf,
    barsSinceStart: len,

    rsi14: rsiSeries[last],
    ema20: ema20Series[last],
    ema50: ema50Series[last],
    ema200: ema200Series[last],
    macdLine: macdSeries.line[last],
    macdSignal: macdSeries.signal[last],
    macdHist: macdSeries.hist[last],
    atr14: atrSeries[last],
    bbUpper: bbSeries.upper[last],
    bbMid: bbSeries.mid[last],
    bbLower: bbSeries.lower[last],
    bbWidth: bbSeries.bbWidth[last],
    obv: obvSeries.obv[last],
    obvSlope: obvSeries.obvSlope[last],
    vwap: vwapSeries[last],
    volZ: volZSeries[last],
    realizedVolAnnualized: rvSeries[last],
    fearGreed: context.fearGreed,
    dispersion: context.dispersion,

    history: {
      rsi14: trailNull(rsiSeries),
      macdHist: trailNull(macdSeries.hist),
      ema20: trailNull(ema20Series),
      ema50: trailNull(ema50Series),
      close: trailNum(closes),
      volume: trailNum(volumes),
    },
  };
}
