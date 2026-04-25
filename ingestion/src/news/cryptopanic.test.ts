import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CryptoPanicPost } from "./types.js";

const ssmSend = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  GetParameterCommand: vi.fn().mockImplementation((input) => ({ __cmd: "GetParameter", input })),
}));

beforeEach(() => {
  vi.resetModules();
  ssmSend.mockReset();
  delete process.env.CRYPTOPANIC_API_KEY;
  process.env.ENVIRONMENT = "dev";
});

function makePost(votes: Partial<CryptoPanicPost["votes"]>): CryptoPanicPost {
  return {
    id: 1,
    kind: "news",
    domain: "example.com",
    title: "t",
    published_at: new Date().toISOString(),
    url: "https://example.com",
    votes: { positive: 0, negative: 0, important: 0, liked: 0, disliked: 0, ...votes },
  };
}

describe("computeSentiment", () => {
  it("returns 'bullish' when positive > 2x negative", async () => {
    const { computeSentiment } = await import("./cryptopanic.js");
    expect(computeSentiment(makePost({ positive: 10, negative: 4 }))).toBe("bullish");
  });

  it("returns 'bearish' when negative > 2x positive", async () => {
    const { computeSentiment } = await import("./cryptopanic.js");
    expect(computeSentiment(makePost({ positive: 4, negative: 10 }))).toBe("bearish");
  });

  it("returns 'neutral' on a tie or modest skew", async () => {
    const { computeSentiment } = await import("./cryptopanic.js");
    expect(computeSentiment(makePost({ positive: 5, negative: 5 }))).toBe("neutral");
    expect(computeSentiment(makePost({ positive: 6, negative: 4 }))).toBe("neutral");
  });

  it("returns 'neutral' when both sides are zero (no votes yet)", async () => {
    const { computeSentiment } = await import("./cryptopanic.js");
    expect(computeSentiment(makePost({}))).toBe("neutral");
  });
});

describe("fetchNews", () => {
  it("uses CRYPTOPANIC_API_KEY env var when present (no SSM call)", async () => {
    process.env.CRYPTOPANIC_API_KEY = "env-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ next: null, results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchNews } = await import("./cryptopanic.js");
    const result = await fetchNews();

    expect(result).toEqual({ posts: [], nextCursor: null });
    expect(ssmSend).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("auth_token=env-key");
    vi.unstubAllGlobals();
  });

  it("falls back to SSM when the env var is unset and parses next-page cursor", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "ssm-key" } });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        next: "https://cryptopanic.com/api/free/v1/posts/?auth_token=x&page=3",
        results: [{ id: 1, title: "t" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchNews } = await import("./cryptopanic.js");
    const result = await fetchNews();
    expect(result.nextCursor).toBe("3");
    expect(result.posts).toHaveLength(1);
    expect(ssmSend).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("auth_token=ssm-key");
    vi.unstubAllGlobals();
  });

  it("forwards an explicit cursor as a page query param", async () => {
    process.env.CRYPTOPANIC_API_KEY = "env-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ next: null, results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchNews } = await import("./cryptopanic.js");
    await fetchNews("7");
    expect(fetchMock.mock.calls[0][0]).toContain("page=7");
    vi.unstubAllGlobals();
  });

  it("throws when the API responds non-2xx", async () => {
    process.env.CRYPTOPANIC_API_KEY = "env-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, statusText: "Bad Gateway" }));
    const { fetchNews } = await import("./cryptopanic.js");
    await expect(fetchNews()).rejects.toThrow(/CryptoPanic API error: 502/);
    vi.unstubAllGlobals();
  });

  it("throws when SSM returns an empty parameter", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "" } });
    const { fetchNews } = await import("./cryptopanic.js");
    await expect(fetchNews()).rejects.toThrow(/SSM parameter.*is empty/);
  });
});
