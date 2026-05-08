import { publish } from "../lib/sqs-publisher.js";

import { fetchAlpacaNews, alpacaToNewsRecord } from "./alpaca.js";
import { fetchRssNews } from "./rss.js";
import { fetchFearGreedIndex } from "./fear-greed.js";
import { storeNewsRecords } from "./news-store.js";

const POLL_INTERVAL_MS = 2 * 60_000; // 2 minutes
const FEAR_GREED_INTERVAL_MS = 60 * 60_000; // 1 hour (updates daily, no need to poll fast)
const ENRICHMENT_QUEUE = process.env.ENRICHMENT_QUEUE_URL;

export class NewsPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fgTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollAt = 0;
  private totalPolled = 0;
  private lastFearGreed: { value: number; classification: string } | null = null;

  getStatus(): Record<string, unknown> {
    return {
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      totalPolled: this.totalPolled,
      intervalMs: POLL_INTERVAL_MS,
      sources: ["alpaca", "rss-cointelegraph", "rss-decrypt", "rss-coindesk"],
      fearGreed: this.lastFearGreed,
    };
  }

  start(): void {
    console.log(`[NewsPoller] Starting with ${POLL_INTERVAL_MS / 1000}s interval (3 sources)`);

    // Initial polls
    this.poll().catch((err) =>
      console.error(`[NewsPoller] Initial poll error: ${(err as Error).message}`)
    );
    this.pollFearGreed().catch((err) =>
      console.error(`[NewsPoller] Initial F&G error: ${(err as Error).message}`)
    );

    // Recurring polls
    this.timer = setInterval(() => {
      this.poll().catch((err) =>
        console.error(`[NewsPoller] Poll error: ${(err as Error).message}`)
      );
    }, POLL_INTERVAL_MS);

    this.fgTimer = setInterval(() => {
      this.pollFearGreed().catch((err) =>
        console.error(`[NewsPoller] F&G error: ${(err as Error).message}`)
      );
    }, FEAR_GREED_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.fgTimer) {
      clearInterval(this.fgTimer);
      this.fgTimer = null;
    }
    console.log("[NewsPoller] Stopped.");
  }

  private async poll(): Promise<void> {
    console.log("[NewsPoller] Polling Alpaca + RSS...");

    // Fetch from both sources in parallel
    const [alpacaResult, rssRecords] = await Promise.all([
      fetchAlpacaNews({ symbols: "BTC,ETH,SOL,XRP,DOGE", limit: 50 }).catch((err) => {
        console.error(`[NewsPoller] Alpaca error: ${(err as Error).message}`);
        return { articles: [], nextPageToken: null };
      }),
      fetchRssNews().catch((err) => {
        console.error(`[NewsPoller] RSS error: ${(err as Error).message}`);
        return [];
      }),
    ]);

    // Convert Alpaca articles to NewsRecords
    const alpacaRecords = alpacaResult.articles.map(alpacaToNewsRecord);

    // Combine all records
    const allRecords = [...alpacaRecords, ...rssRecords];

    if (allRecords.length === 0) {
      console.log("[NewsPoller] No new articles from any source");
      return;
    }

    const stored = await storeNewsRecords(allRecords);
    this.totalPolled += stored;
    this.lastPollAt = Date.now();

    // Send new articles to enrichment queue
    if (ENRICHMENT_QUEUE && stored > 0) {
      for (const record of allRecords.slice(0, stored)) {
        await publish(ENRICHMENT_QUEUE, "enrich_news", {
          newsId: record.newsId,
          publishedAt: record.publishedAt,
        });
      }
    }

    console.log(
      `[NewsPoller] Stored ${stored} new articles (${alpacaRecords.length} Alpaca, ${rssRecords.length} RSS)`
    );
  }

  private async pollFearGreed(): Promise<void> {
    const data = await fetchFearGreedIndex();
    if (data) {
      this.lastFearGreed = { value: data.value, classification: data.classification };
    }
  }
}
