import { describe, it, expect, vi, beforeEach } from "vitest";

const ssmSend = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  GetParametersCommand: vi.fn().mockImplementation((input) => ({ __cmd: "GetParameters", input })),
}));

beforeEach(() => {
  vi.resetModules();
  ssmSend.mockReset();
  vi.unstubAllGlobals();
  process.env.ENVIRONMENT = "dev";
});

function mockCreds() {
  ssmSend.mockResolvedValue({
    Parameters: [
      { Name: "/quantara/dev/alpaca/key-id", Value: "key-id" },
      { Name: "/quantara/dev/alpaca/secret-key", Value: "secret-key" },
    ],
  });
}

describe("alpacaToNewsRecord", () => {
  it("maps an Alpaca news item to a NewsRecord with the alpaca-prefixed id", async () => {
    const { alpacaToNewsRecord } = await import("./alpaca.js");
    const item = {
      id: 42,
      headline: "BTC ETF approved",
      author: "Reporter",
      created_at: "2026-04-25T10:00:00Z",
      updated_at: "2026-04-25T10:05:00Z",
      summary: "...",
      content: "...",
      url: "https://example.com/a",
      images: [],
      symbols: ["BTC", "ETH"],
      source: "benzinga",
    };
    const record = alpacaToNewsRecord(item);
    expect(record.newsId).toBe("alpaca-42");
    expect(record.source).toBe("benzinga");
    expect(record.title).toBe("BTC ETF approved");
    expect(record.url).toBe("https://example.com/a");
    expect(record.publishedAt).toBe("2026-04-25T10:00:00.000Z");
    expect(record.currencies).toEqual(["BTC", "ETH"]);
    expect(record.rawSentiment).toBe("neutral");
    expect(record.status).toBe("raw");
    expect(record.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("defaults currencies to [] when the upstream item omits symbols", async () => {
    const { alpacaToNewsRecord } = await import("./alpaca.js");
    const record = alpacaToNewsRecord({
      id: 1,
      headline: "h",
      author: "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      summary: "",
      content: "",
      url: "",
      images: [],
      symbols: undefined as unknown as string[],
      source: "rss",
    });
    expect(record.currencies).toEqual([]);
  });

  it("sets ttl ~30 days in the future", async () => {
    const { alpacaToNewsRecord } = await import("./alpaca.js");
    const before = Math.floor(Date.now() / 1000);
    const record = alpacaToNewsRecord({
      id: 1,
      headline: "h",
      author: "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      summary: "",
      content: "",
      url: "",
      images: [],
      symbols: [],
      source: "x",
    });
    const thirtyDays = 86400 * 30;
    expect(record.ttl).toBeGreaterThanOrEqual(before + thirtyDays - 5);
    expect(record.ttl).toBeLessThanOrEqual(before + thirtyDays + 5);
  });
});

describe("fetchAlpacaNews", () => {
  it("loads creds from SSM, sends APCA auth headers, and parses news + next_page_token", async () => {
    mockCreds();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        news: [
          {
            id: 1,
            headline: "h",
            author: "",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "",
            summary: "",
            content: "",
            url: "",
            images: [],
            symbols: [],
            source: "",
          },
        ],
        next_page_token: "abc",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchAlpacaNews } = await import("./alpaca.js");
    const result = await fetchAlpacaNews({
      symbols: "BTC",
      limit: 25,
      pageToken: "prev",
      start: "2026-04-01T00:00:00Z",
    });
    expect(result.articles).toHaveLength(1);
    expect(result.nextPageToken).toBe("abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("symbols=BTC");
    expect(url).toContain("limit=25");
    expect(url).toContain("page_token=prev");
    expect(url).toContain("start=2026-04-01");
    expect(url).toContain("sort=desc");
    expect(init.headers["APCA-API-KEY-ID"]).toBe("key-id");
    expect(init.headers["APCA-API-SECRET-KEY"]).toBe("secret-key");
  });

  it("uses a default limit of 50 when not specified", async () => {
    mockCreds();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ news: [], next_page_token: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchAlpacaNews } = await import("./alpaca.js");
    await fetchAlpacaNews();
    expect(fetchMock.mock.calls[0][0]).toContain("limit=50");
  });

  it("throws on non-2xx responses", async () => {
    mockCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }),
    );
    const { fetchAlpacaNews } = await import("./alpaca.js");
    await expect(fetchAlpacaNews()).rejects.toThrow(/Alpaca News API error: 401/);
  });

  it("throws when SSM is missing one of the parameters", async () => {
    ssmSend.mockResolvedValue({
      Parameters: [{ Name: "/quantara/dev/alpaca/key-id", Value: "key-id" }],
    });
    const { fetchAlpacaNews } = await import("./alpaca.js");
    await expect(fetchAlpacaNews()).rejects.toThrow(/Missing Alpaca SSM parameters/);
  });

  it("caches the SSM call across multiple fetches in a single module instance", async () => {
    mockCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ news: [], next_page_token: null }),
      }),
    );
    const { fetchAlpacaNews } = await import("./alpaca.js");
    await fetchAlpacaNews();
    await fetchAlpacaNews();
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });
});
