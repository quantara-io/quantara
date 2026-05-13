import type { Candle, Timeframe } from "@quantara/shared";

/**
 * Interface for fetching historical candles.
 * Phase 1: implemented by DdbCandleStore (production candles table).
 * Future phases: archive table (candles-archive) for longer windows.
 */
export interface HistoricalCandleStore {
  /**
   * Fetch candles for a single exchange in [from, to].
   * Used when the caller already knows which exchange it wants.
   */
  getCandles(
    pair: string,
    exchange: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Candle[]>;

  /**
   * Fetch candles for all production exchanges (binanceus, coinbase, kraken)
   * in [from, to]. Returns a map of exchange → chronologically-ordered candles
   * (oldest first). Exchanges that have no rows in the window are still present
   * in the result with an empty array.
   *
   * Phase 1 §1.canonicalize: required so the engine can mirror production's
   * canonicalizeCandle (median-across-exchanges) for priceAtSignal /
   * priceAtResolution.
   */
  getCandlesForAllExchanges(
    pair: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Record<string, Candle[]>>;
}
