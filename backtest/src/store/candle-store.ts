import type { Candle, Timeframe } from "@quantara/shared";

/**
 * Interface for fetching historical candles.
 * Phase 1: implemented by DdbCandleStore (production candles table).
 * Future phases: archive table (candles-archive) for longer windows.
 */
export interface HistoricalCandleStore {
  getCandles(
    pair: string,
    exchange: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Candle[]>;
}
