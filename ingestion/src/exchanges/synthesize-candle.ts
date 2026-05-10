import type { Candle, Timeframe } from "@quantara/shared";
import type { ExchangeId, TradingPair } from "./config.js";

/**
 * Build a zero-volume carry-forward candle for a 1m window where no trades
 * arrived from the exchange stream.
 *
 * Shape mirrors what Binance/Coinbase emit for silent-period minutes:
 *   open == high == low == close == prevClose
 *   volume == 0
 *   source == "live-synthesized"
 *
 * @param exchange   Exchange that should have emitted the candle.
 * @param symbol     ccxt symbol for this pair on this exchange (e.g. "XRP/USDT").
 * @param pair       Canonical trading pair (e.g. "XRP/USDT").
 * @param timeframe  Always "1m" for the live synthesis path.
 * @param openTime   Unix ms of the start of the missed 1m window.
 * @param prevClose  Close price from the most-recently-seen real candle.
 */
export function synthesizeCandle(
  exchange: ExchangeId,
  symbol: string,
  pair: TradingPair,
  timeframe: Timeframe,
  openTime: number,
  prevClose: number,
): Candle {
  const intervalMs = 60_000; // 1m in ms
  return {
    exchange,
    symbol,
    pair,
    timeframe,
    openTime,
    closeTime: openTime + intervalMs,
    open: prevClose,
    high: prevClose,
    low: prevClose,
    close: prevClose,
    volume: 0,
    isClosed: true,
    source: "live-synthesized",
  };
}
