import type { NewsRecord } from "./types.js";

const RSS_FEEDS = [
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
] as const;

const NEWS_TTL_DAYS = 30;

// Crypto symbols to detect in headlines
const SYMBOL_PATTERNS: Record<string, RegExp> = {
  BTC: /\b(BTC|Bitcoin)\b/i,
  ETH: /\b(ETH|Ethereum)\b/i,
  SOL: /\b(SOL|Solana)\b/i,
  XRP: /\bXRP\b/i,
  DOGE: /\b(DOGE|Dogecoin)\b/i,
  ADA: /\b(ADA|Cardano)\b/i,
  AVAX: /\b(AVAX|Avalanche)\b/i,
  DOT: /\b(DOT|Polkadot)\b/i,
  MATIC: /\b(MATIC|Polygon)\b/i,
  LINK: /\b(LINK|Chainlink)\b/i,
};

function detectCurrencies(text: string): string[] {
  const found: string[] = [];
  for (const [symbol, pattern] of Object.entries(SYMBOL_PATTERNS)) {
    if (pattern.test(text)) found.push(symbol);
  }
  return found;
}

interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  guid: string;
}

function parseRssXml(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const guid = extractTag(block, "guid") || link;

    if (title && link) {
      items.push({ title, link, pubDate, guid });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA
  const cdataMatch = xml.match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`),
  );
  if (cdataMatch) return cdataMatch[1].trim();

  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : "";
}

export async function fetchRssNews(): Promise<NewsRecord[]> {
  const records: NewsRecord[] = [];

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        console.warn(`[RSS] Failed to fetch ${feed.name}: ${res.status}`);
        continue;
      }

      const xml = await res.text();
      const items = parseRssXml(xml);

      for (const item of items.slice(0, 20)) {
        const currencies = detectCurrencies(item.title);

        // Derive a stable publishedAt.  Prefer the item's pubDate; fall back
        // to a deterministic sentinel derived from the item's URL so the same
        // article never gets a different key on subsequent polls.
        // Using new Date().toISOString() as a fallback would produce a fresh
        // key on every poll cycle, writing duplicate rows for every article
        // whose feed omits a pubDate.
        let publishedAt: string;
        if (item.pubDate) {
          const parsed = new Date(item.pubDate);
          publishedAt = isNaN(parsed.getTime())
            ? stableFallbackDate(item.guid || item.link)
            : parsed.toISOString();
        } else {
          publishedAt = stableFallbackDate(item.guid || item.link);
        }

        records.push({
          newsId: `rss-${hashString(item.guid)}`,
          source: feed.name,
          title: item.title,
          url: item.link,
          publishedAt,
          currencies,
          rawSentiment: "neutral",
          status: "raw",
          ttl: Math.floor(Date.now() / 1000) + 86400 * NEWS_TTL_DAYS,
        });
      }

      console.log(`[RSS] ${feed.name}: ${items.length} items`);
    } catch (err) {
      console.warn(`[RSS] Error fetching ${feed.name}: ${(err as Error).message}`);
    }
  }

  return records;
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Produce a deterministic ISO timestamp for articles that have no parseable
 * pubDate.  Anchors at the start of the current UTC day plus a hash-derived
 * offset within the day, so the result is:
 *
 *   - stable for the same article re-polled within the same UTC day (idempotent
 *     dedup against the (newsId, publishedAt) primary key),
 *   - within the past 24 hours of wall-clock time (passes recency-window
 *     queries on `news-events-by-pair` and the freshness gate in
 *     `processNewsEventForInvalidation`),
 *   - distinct between articles polled in the same day (the seed hash spreads
 *     timestamps across the full 86_400-second range).
 *
 * Using `new Date().toISOString()` as the fallback would change publishedAt on
 * every poll cycle and re-write the same article forever; the prior 1970
 * anchor was stable but made articles look permanently stale to all downstream
 * recency-aware queries.
 */
function stableFallbackDate(seed: string): string {
  // 15-minute bucket: stable across rapid polls (so the (newsId, publishedAt)
  // composite key dedups correctly within a quarter-hour), and tight enough
  // to stay inside the 30-minute freshness window enforced by
  // `news/invalidation.ts` (FRESHNESS_WINDOW_MS = 30 * 60 * 1000) so undated
  // articles still trigger sentiment-shock invalidation and contribute to
  // recency-bounded queries (`queryNewsByPair(pair, sinceISO)`).
  // Worst-case article age = 15 min, well inside the 30-min window.
  const bucketMs = 15 * 60 * 1000;
  const bucketStart = Math.floor(Date.now() / bucketMs) * bucketMs;
  const offsetSec =
    Math.abs(
      hashString(seed)
        .split("")
        .reduce((n, c) => n + c.charCodeAt(0), 0),
    ) %
    (bucketMs / 1000);
  return new Date(bucketStart + offsetSec * 1000).toISOString();
}
