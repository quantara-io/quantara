import type { NewsRecord } from "./types.js";

const BASE_URL = "https://data.alpaca.markets/v1beta1/news";

const ALPACA_KEY_ID = process.env.ALPACA_KEY_ID ?? "";
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY ?? "";

interface AlpacaNewsItem {
  id: number;
  headline: string;
  author: string;
  created_at: string;
  updated_at: string;
  summary: string;
  content: string;
  url: string;
  images: Array<{ size: string; url: string }>;
  symbols: string[];
  source: string;
}

interface AlpacaNewsResponse {
  news: AlpacaNewsItem[];
  next_page_token: string | null;
}

export async function fetchAlpacaNews(options?: {
  symbols?: string;
  limit?: number;
  pageToken?: string;
  start?: string;
}): Promise<{ articles: AlpacaNewsItem[]; nextPageToken: string | null }> {
  const params = new URLSearchParams();
  if (options?.symbols) params.set("symbols", options.symbols);
  params.set("limit", String(options?.limit ?? 50));
  params.set("include_content", "true");
  if (options?.pageToken) params.set("page_token", options.pageToken);
  if (options?.start) params.set("start", options.start);
  params.set("sort", "desc");

  const url = `${BASE_URL}?${params}`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY_ID,
      "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
    },
  });

  if (!res.ok) {
    throw new Error(`Alpaca News API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as AlpacaNewsResponse;
  return { articles: data.news, nextPageToken: data.next_page_token };
}

const NEWS_TTL_DAYS = 30;

export function alpacaToNewsRecord(item: AlpacaNewsItem): NewsRecord {
  return {
    newsId: `alpaca-${item.id}`,
    source: item.source,
    title: item.headline,
    url: item.url,
    publishedAt: new Date(item.created_at).toISOString(),
    currencies: item.symbols ?? [],
    rawSentiment: "neutral",
    status: "raw",
    ttl: Math.floor(Date.now() / 1000) + 86400 * NEWS_TTL_DAYS,
  };
}
