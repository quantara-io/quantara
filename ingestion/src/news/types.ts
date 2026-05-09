export interface CryptoPanicPost {
  id: number;
  kind: "news" | "media";
  domain: string;
  title: string;
  published_at: string;
  url: string;
  currencies?: Array<{ code: string; title: string }>;
  votes: {
    negative: number;
    positive: number;
    important: number;
    liked: number;
    disliked: number;
  };
}

export interface CryptoPanicResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: CryptoPanicPost[];
}

export interface NewsRecord {
  newsId: string;
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  /** GSI partition key for the `published-day-index` GSI: ISO date (YYYY-MM-DD). */
  publishedDay: string;
  currencies: string[];
  rawSentiment: string;
  status: "raw" | "enriched" | "failed";
  enrichment?: Record<string, unknown>;
  enrichedAt?: string;
  ttl: number;
}
