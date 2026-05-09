import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchRssNews } from "./rss.js";

beforeEach(() => {
  vi.unstubAllGlobals();
});

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss>
  <channel>
    <item>
      <title><![CDATA[Bitcoin breaks new high]]></title>
      <link>https://example.com/a</link>
      <pubDate>Sat, 25 Apr 2026 10:00:00 GMT</pubDate>
      <guid>guid-1</guid>
    </item>
    <item>
      <title>Ethereum update has no CDATA</title>
      <link>https://example.com/b</link>
      <pubDate>Sat, 25 Apr 2026 11:00:00 GMT</pubDate>
      <guid isPermaLink="false">guid-2</guid>
    </item>
    <item>
      <title>SOL and DOGE pump</title>
      <link>https://example.com/c</link>
      <pubDate></pubDate>
    </item>
    <item>
      <title>Item without link is skipped</title>
    </item>
  </channel>
</rss>`;

describe("fetchRssNews", () => {
  it("parses items, detects currencies, and falls back to current time when pubDate is empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_FEED })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);

    const records = await fetchRssNews();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // First feed produced 3 valid items (the 4th has no link).
    expect(records).toHaveLength(3);

    const btc = records.find((r) => r.title.includes("Bitcoin"));
    expect(btc?.currencies).toEqual(["BTC"]);
    expect(btc?.publishedAt).toBe("2026-04-25T10:00:00.000Z");
    expect(btc?.source).toBe("CoinTelegraph");
    expect(btc?.newsId).toMatch(/^rss-/);

    const eth = records.find((r) => r.title.includes("Ethereum"));
    expect(eth?.currencies).toEqual(["ETH"]);

    const sol = records.find((r) => r.title.includes("SOL and DOGE"));
    expect(sol?.currencies.sort()).toEqual(["DOGE", "SOL"]);
    // Empty pubDate falls back to a stable synthetic date derived from the
    // item's link (stableFallbackDate). Verify it parsed as a valid ISO and
    // landed within the past 24h (anchored at start of UTC day plus
    // hash-derived offset within the day). Cross-poll stability is asserted
    // separately below.
    const solTs = Date.parse(sol!.publishedAt);
    expect(Number.isNaN(solTs)).toBe(false);
    const now = Date.now();
    expect(solTs).toBeGreaterThanOrEqual(now - 86_400_000);
    expect(solTs).toBeLessThanOrEqual(now + 86_400_000);
  });

  it("returns [] when every feed errors out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const records = await fetchRssNews();
    expect(records).toEqual([]);
  });

  it("derives stable newsIds from the same guid (same hash on re-parse)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_FEED });
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchRssNews();
    const second = await fetchRssNews();

    const firstByTitle = new Map(first.map((r) => [r.title, r.newsId]));
    for (const r of second) {
      expect(firstByTitle.get(r.title)).toBe(r.newsId);
    }
  });

  it("produces a stable publishedAt for items without a pubDate across two polls", async () => {
    // This is the dedup-correctness property: an article with no pubDate must
    // get the same (newsId, publishedAt) key on every poll, so storeNewsRecords
    // can deduplicate it correctly without re-writing a duplicate row.
    //
    // `stableFallbackDate` buckets time at 15-minute boundaries, so two
    // wall-clock-driven polls that straddle a bucket boundary would
    // legitimately produce different timestamps. Freeze time so the test
    // exercises the stability promise within a single bucket.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T12:07:30Z"));
    try {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_FEED });
      vi.stubGlobal("fetch", fetchMock);

      const first = await fetchRssNews();
      const second = await fetchRssNews();

      // The SOL item has an empty pubDate in SAMPLE_FEED.
      const firstSol = first.find((r) => r.title.includes("SOL and DOGE"))!;
      const secondSol = second.find((r) => r.title.includes("SOL and DOGE"))!;

      expect(firstSol.publishedAt).toBe(secondSol.publishedAt);
      expect(firstSol.newsId).toBe(secondSol.newsId);
    } finally {
      vi.useRealTimers();
    }
  });
});
