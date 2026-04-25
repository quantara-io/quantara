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

    const before = Date.now();
    const records = await fetchRssNews();
    const after = Date.now();

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
    // Empty pubDate falls back to "now" (ISO at fetch time).
    const solTs = Date.parse(sol!.publishedAt);
    expect(solTs).toBeGreaterThanOrEqual(before);
    expect(solTs).toBeLessThanOrEqual(after + 1000);
  });

  it("returns [] when every feed errors out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const records = await fetchRssNews();
    expect(records).toEqual([]);
  });

  it("derives stable newsIds from the same guid (same hash on re-parse)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => SAMPLE_FEED });
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchRssNews();
    const second = await fetchRssNews();

    const firstByTitle = new Map(first.map((r) => [r.title, r.newsId]));
    for (const r of second) {
      expect(firstByTitle.get(r.title)).toBe(r.newsId);
    }
  });
});
