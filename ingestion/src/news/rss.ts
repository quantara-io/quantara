import { createHash } from "node:crypto";

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

        // Derive a publishedAt.  Prefer the item's pubDate; fall back to the
        // current poll time.  Now that dedup is keyed on newsId alone (not the
        // composite (newsId, publishedAt) primary key), a fresh timestamp on
        // each poll does not cause duplicate rows.
        let publishedAt: string;
        if (item.pubDate) {
          const parsed = new Date(item.pubDate);
          publishedAt = isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
        } else {
          publishedAt = new Date().toISOString();
        }

        records.push({
          newsId: `rss-${newsIdHash(item.guid)}`,
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

// Collision-resistant newsId: SHA-256 truncated to 16 hex chars (64-bit space).
// Birthday-bound 50%-collision thresholds (≈ 1.18·√N for hash-space N):
//   - 32-bit (≈4.3·10⁹): 50% collision at ~77K items. The prior `hashString`
//     was 32 bits and would silently lose articles long before that as the
//     news volume grew (already at risk during a heavy news day).
//   - 64-bit (≈1.8·10¹⁹): 50% collision at ~5·10⁹ items, well past any
//     plausible lifetime article count.
// Now that newsId is the sole dedup key, any collision = silent article drop,
// so 64 bits is the conservative choice — not 32, not 48.
function newsIdHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
