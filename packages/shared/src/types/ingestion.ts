export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface Candle {
  exchange: string;
  symbol: string;
  pair: string;
  timeframe: Timeframe;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
  /** Origin of this candle — mandatory from v6 onwards.
   *  - "live"            = real-time trade-derived candle from an exchange stream
   *  - "live-synthesized" = zero-volume carry-forward synthesized locally when no
   *                         trades arrived within a 1m window (Kraken USDT-quoted
   *                         pairs during quiet hours). Close-price is carried from
   *                         the previous real candle. Downstream indicators treat
   *                         this identically to "live" for continuity.
   *  - "backfill"        = historical fetch.
   *  Used by DDB Streams FilterCriteria so the IndicatorLambda only fires on live closes. */
  source: "live" | "live-synthesized" | "backfill";
  /** Set when this candle was synthesized by aggregating finer-grained source candles
   *  rather than fetched directly from the exchange (e.g. "1h×4" for a 4h candle
   *  built from four 1h candles). Informational — does not affect indicator logic. */
  aggregatedFrom?: string;
}

export interface RawNewsEvent {
  newsId: string;
  source: string;
  title: string;
  url?: string;
  publishedAt: number;
  currencies?: string[];
}

export interface NewsEnrichment {
  sentiment: "bullish" | "bearish" | "neutral";
  confidence: number;
  events: string[];
  relevance: Record<string, number>;
  timeHorizon?: "very_short" | "short_term" | "medium_term" | "long_term";
  summary: string;
}

export interface EnrichedNewsEvent extends RawNewsEvent {
  enrichment: NewsEnrichment;
  enrichedAt: string;
}

export type IngestionEventType = "candle_close" | "ticker_update" | "enriched_news";

export interface IngestionEvent<T = unknown> {
  type: IngestionEventType;
  data: T;
  timestamp: string;
}
