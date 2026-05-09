import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

import type { NewsRecord } from "./types.js";

const BASE_URL = "https://data.alpaca.markets/v1beta1/news";

const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";
const ssm = new SSMClient({});

let credsPromise: Promise<{ keyId: string; secretKey: string }> | null = null;

function loadAlpacaCreds(): Promise<{ keyId: string; secretKey: string }> {
  if (credsPromise) return credsPromise;
  credsPromise = (async () => {
    const keyIdName = `/quantara/${ENVIRONMENT}/alpaca/key-id`;
    const secretName = `/quantara/${ENVIRONMENT}/alpaca/secret-key`;
    const result = await ssm.send(
      new GetParametersCommand({
        Names: [keyIdName, secretName],
        WithDecryption: true,
      }),
    );
    const byName = new Map((result.Parameters ?? []).map((p) => [p.Name, p.Value]));
    const keyId = byName.get(keyIdName);
    const secretKey = byName.get(secretName);
    if (!keyId || !secretKey) {
      credsPromise = null;
      throw new Error(`Missing Alpaca SSM parameters: ${keyIdName}, ${secretName}`);
    }
    return { keyId, secretKey };
  })();
  return credsPromise;
}

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

  const { keyId, secretKey } = await loadAlpacaCreds();
  const url = `${BASE_URL}?${params}`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": keyId,
      "APCA-API-SECRET-KEY": secretKey,
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
  const publishedAt = new Date(item.created_at).toISOString();
  return {
    newsId: `alpaca-${item.id}`,
    source: item.source,
    title: item.headline,
    url: item.url,
    publishedAt,
    publishedDay: publishedAt.slice(0, 10),
    currencies: item.symbols ?? [],
    rawSentiment: "neutral",
    status: "raw",
    ttl: Math.floor(Date.now() / 1000) + 86400 * NEWS_TTL_DAYS,
  };
}
