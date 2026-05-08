import type { Context } from "aws-lambda";

import { fetchAlpacaNews, alpacaToNewsRecord } from "./news/alpaca.js";
import { storeNewsRecords } from "./news/news-store.js";
import { saveCursor, getCursor } from "./lib/metadata-store.js";

const META_KEY = "news:alpaca:backfill";

interface BackfillEvent {
  maxPages?: number;
  symbols?: string;
  daysBack?: number;
}

export async function handler(event: BackfillEvent, context: Context): Promise<{ totalStored: number; pages: number }> {
  const maxPages = event.maxPages ?? 20;
  const symbols = event.symbols ?? "BTC,ETH,SOL,XRP,DOGE";
  const daysBack = event.daysBack ?? 90;
  let totalStored = 0;
  let pages = 0;

  // Resume from cursor if available
  const cursor = await getCursor(META_KEY);
  let pageToken: string | undefined = cursor?.metadata?.nextPageToken as string | undefined;

  const startDate = new Date(Date.now() - daysBack * 86400 * 1000).toISOString();

  console.log(`[NewsBackfill] Starting, maxPages=${maxPages}, symbols=${symbols}, start=${startDate}`);

  while (pages < maxPages) {
    const { articles, nextPageToken } = await fetchAlpacaNews({
      symbols,
      limit: 50,
      pageToken,
      start: startDate,
    });

    if (articles.length === 0) {
      console.log("[NewsBackfill] No more articles");
      break;
    }

    const records = articles.map(alpacaToNewsRecord);
    const stored = await storeNewsRecords(records);
    totalStored += stored;
    pages++;

    await saveCursor({
      metaKey: META_KEY,
      lastTimestamp: new Date().toISOString(),
      status: "in_progress",
      updatedAt: new Date().toISOString(),
      metadata: { nextPageToken, pagesProcessed: pages, totalStored },
    });

    console.log(`[NewsBackfill] Page ${pages}: ${stored} new, ${articles.length} fetched`);

    if (!nextPageToken) {
      console.log("[NewsBackfill] No more pages");
      break;
    }

    pageToken = nextPageToken;

    // Check remaining Lambda time
    const remainingMs = context.getRemainingTimeInMillis();
    if (remainingMs < 30_000) {
      console.log(`[NewsBackfill] Stopping early — ${remainingMs}ms remaining`);
      break;
    }
  }

  await saveCursor({
    metaKey: META_KEY,
    lastTimestamp: new Date().toISOString(),
    status: "complete",
    updatedAt: new Date().toISOString(),
    metadata: { pagesProcessed: pages, totalStored },
  });

  console.log(`[NewsBackfill] Complete: ${totalStored} articles across ${pages} pages`);
  return { totalStored, pages };
}
