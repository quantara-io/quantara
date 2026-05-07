import type { Timeframe } from "./ingestion.js";

export interface IndicatorState {
  pair: string;
  exchange: string; // or "consensus" for cross-exchange canonicalized
  timeframe: Timeframe;
  asOf: number; // unix ms of latest closed candle
  barsSinceStart: number; // warm-up gating

  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  atr14: number | null;
  bbUpper: number | null;
  bbMid: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  obv: number | null;
  obvSlope: number | null;
  vwap: number | null; // null on TFs other than 15m / 1h
  volZ: number | null;
  realizedVolAnnualized: number | null;
  fearGreed: number | null;
  dispersion: number | null; // cross-exchange spread / median

  history: IndicatorStateHistory;
}

export interface IndicatorStateHistory {
  rsi14: (number | null)[];
  macdHist: (number | null)[];
  ema20: (number | null)[];
  ema50: (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
}
