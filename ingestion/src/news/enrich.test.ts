/**
 * Unit tests for Phase 5a news enrichment:
 * - regexTags (all 5 pairs + edge cases)
 * - llmTags (mocked Bedrock Haiku)
 * - tagPairs (union + dedup)
 * - classifySentiment (mocked Bedrock, score/magnitude bounds)
 * - checkDedup (mocked OpenAI fetch + mocked DynamoDB embedding-cache)
 * - extractJson / cosineSimilarity helpers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-bedrock-runtime
// ---------------------------------------------------------------------------

const bedrockSendMock = vi.fn();
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: bedrockSendMock })),
  InvokeModelCommand: vi.fn().mockImplementation((input) => ({ __cmd: "InvokeModel", input })),
}));

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-dynamodb + @aws-sdk/lib-dynamodb
// ---------------------------------------------------------------------------

const dynamoSendMock = vi.fn();
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: dynamoSendMock }) },
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  PutCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Put", input })),
  ScanCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Scan", input })),
}));

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-ssm
// ---------------------------------------------------------------------------

const ssmSendMock = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input) => ({ __cmd: "GetParameter", input })),
}));

// ---------------------------------------------------------------------------
// Helper to encode a Bedrock Haiku JSON response
// ---------------------------------------------------------------------------

function bedrockJsonResponse(payload: unknown): { body: Uint8Array } {
  const text = JSON.stringify(payload);
  const wrapped = JSON.stringify({ content: [{ text }] });
  return { body: new TextEncoder().encode(wrapped) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  bedrockSendMock.mockReset();
  dynamoSendMock.mockReset();
  ssmSendMock.mockReset();
  // Suppress OpenAI key SSM lookup in tests that use embeddings
  process.env.OPENAI_API_KEY = "test-key";
  process.env.TABLE_EMBEDDING_CACHE = "test-embedding-cache";
});

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

describe("extractJson", () => {
  it("extracts JSON from a clean string", async () => {
    const { extractJson } = await import("./enrich.js");
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("extracts JSON preceded by prose", async () => {
    const { extractJson } = await import("./enrich.js");
    const result = extractJson('Sure, here you go: {"score":0.5}');
    expect(result).toBe('{"score":0.5}');
    expect(JSON.parse(result)).toEqual({ score: 0.5 });
  });

  it("throws when there is no JSON", async () => {
    const { extractJson } = await import("./enrich.js");
    expect(() => extractJson("no json here")).toThrow("No JSON found");
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1 for identical non-zero vectors", async () => {
    const { cosineSimilarity } = await import("./enrich.js");
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", async () => {
    const { cosineSimilarity } = await import("./enrich.js");
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", async () => {
    const { cosineSimilarity } = await import("./enrich.js");
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for zero vector", async () => {
    const { cosineSimilarity } = await import("./enrich.js");
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("throws for length mismatch", async () => {
    const { cosineSimilarity } = await import("./enrich.js");
    expect(() => cosineSimilarity([1], [1, 2])).toThrow("Vector length mismatch");
  });
});

// ---------------------------------------------------------------------------
// regexTags — all five pairs + edge cases
// ---------------------------------------------------------------------------

describe("regexTags", () => {
  it("matches BTC via the symbol", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("BTC price surges")).toContain("BTC");
  });

  it("matches BTC via 'bitcoin'", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("Bitcoin hits new ATH")).toContain("BTC");
  });

  it("matches BTC via 'XBT'", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("XBT futures open interest")).toContain("BTC");
  });

  it("matches ETH via 'ether'", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("Ether staking yields increase")).toContain("ETH");
  });

  it("matches ETH via 'ethereum'", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("Ethereum upgrade approved")).toContain("ETH");
  });

  it("matches SOL via 'solana'", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("Solana network outage")).toContain("SOL");
  });

  it("matches SOL via the symbol", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("SOL drops 10%")).toContain("SOL");
  });

  it("matches XRP via 'ripple'", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("Ripple wins court case")).toContain("XRP");
  });

  it("matches XRP via the symbol", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("XRP hits $1")).toContain("XRP");
  });

  it("matches DOGE via 'dogecoin'", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("Dogecoin surges after tweet")).toContain("DOGE");
  });

  it("matches DOGE via the symbol", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("DOGE community rally")).toContain("DOGE");
  });

  it("returns multiple pairs for a multi-coin article", async () => {
    const { regexTags } = await import("./enrich.js");
    const tags = regexTags("BTC and ETH correlation study");
    expect(tags).toContain("BTC");
    expect(tags).toContain("ETH");
    expect(tags).toHaveLength(2);
  });

  it("returns empty array when no known pairs appear", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("General market commentary")).toEqual([]);
  });

  it("is case-insensitive (lowercase 'btc' should NOT match — boundary only)", async () => {
    // The regex is /\b(BTC|XBT|bitcoin)\b/i — so lowercase 'btc' matches because of /i
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("btc price")).toContain("BTC");
  });

  it("does not match 'xbtc' as BTC (word boundary)", async () => {
    const { regexTags } = await import("./enrich.js");
    expect(regexTags("xbtc token")).not.toContain("BTC");
  });
});

// ---------------------------------------------------------------------------
// llmTags — mocked Bedrock Haiku
// ---------------------------------------------------------------------------

describe("llmTags", () => {
  it("returns pairs from Haiku JSON response", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ affectedPairs: ["ETH", "BTC"] })
    );
    const { llmTags } = await import("./enrich.js");
    const tags = await llmTags("Coinbase halts ETH staking", "");
    expect(tags).toContain("ETH");
    expect(tags).toContain("BTC");
  });

  it("filters out invalid symbols from LLM response", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ affectedPairs: ["ETH", "SHIB", "PEPE"] })
    );
    const { llmTags } = await import("./enrich.js");
    const tags = await llmTags("Some article", "");
    expect(tags).toEqual(["ETH"]);
  });

  it("returns empty array when affectedPairs is empty", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ affectedPairs: [] })
    );
    const { llmTags } = await import("./enrich.js");
    const tags = await llmTags("Unrelated market news", "");
    expect(tags).toEqual([]);
  });

  it("handles missing affectedPairs key gracefully", async () => {
    bedrockSendMock.mockResolvedValue(bedrockJsonResponse({}));
    const { llmTags } = await import("./enrich.js");
    const tags = await llmTags("News article", "");
    expect(tags).toEqual([]);
  });

  it("truncates body to 2000 chars in the Bedrock request", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ affectedPairs: ["SOL"] })
    );
    const { llmTags } = await import("./enrich.js");
    const longBody = "x".repeat(5000);
    await llmTags("Title", longBody);
    const callBody = JSON.parse(bedrockSendMock.mock.calls[0][0].input.body);
    expect(callBody.messages[0].content).toContain("x".repeat(2000));
    expect(callBody.messages[0].content).not.toContain("x".repeat(2001));
  });
});

// ---------------------------------------------------------------------------
// tagPairs — union of regex + LLM, deduplicated
// ---------------------------------------------------------------------------

describe("tagPairs", () => {
  it("deduplicates overlapping regex and LLM results", async () => {
    // Regex will match BTC; LLM returns BTC and ETH
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ affectedPairs: ["BTC", "ETH"] })
    );
    const { tagPairs } = await import("./enrich.js");
    const pairs = await tagPairs("BTC market update", "");
    expect(pairs).toContain("BTC");
    expect(pairs).toContain("ETH");
    // BTC must appear only once
    expect(pairs.filter((p) => p === "BTC")).toHaveLength(1);
  });

  it("returns regex-only results when LLM returns empty", async () => {
    bedrockSendMock.mockResolvedValue(bedrockJsonResponse({ affectedPairs: [] }));
    const { tagPairs } = await import("./enrich.js");
    const pairs = await tagPairs("Solana NFT marketplace", "");
    expect(pairs).toContain("SOL");
  });
});

// ---------------------------------------------------------------------------
// classifySentiment — mocked Bedrock, score/magnitude bounds
// ---------------------------------------------------------------------------

describe("classifySentiment", () => {
  it("returns score and magnitude from Haiku JSON response", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ score: 0.8, magnitude: 0.9, topic: "ETF approval" })
    );
    const { classifySentiment } = await import("./enrich.js");
    const result = await classifySentiment("Bitcoin ETF approved", "");
    expect(result.score).toBeCloseTo(0.8);
    expect(result.magnitude).toBeCloseTo(0.9);
    expect(result.model).toBe("anthropic.claude-haiku-4-5");
  });

  it("clamps score above +1 to +1", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ score: 2.5, magnitude: 0.5, topic: "test" })
    );
    const { classifySentiment } = await import("./enrich.js");
    const result = await classifySentiment("Article", "");
    expect(result.score).toBe(1);
  });

  it("clamps score below -1 to -1", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ score: -3, magnitude: 0.5, topic: "test" })
    );
    const { classifySentiment } = await import("./enrich.js");
    const result = await classifySentiment("Article", "");
    expect(result.score).toBe(-1);
  });

  it("clamps magnitude above 1 to 1", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ score: 0, magnitude: 5, topic: "test" })
    );
    const { classifySentiment } = await import("./enrich.js");
    const result = await classifySentiment("Article", "");
    expect(result.magnitude).toBe(1);
  });

  it("clamps magnitude below 0 to 0", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ score: 0, magnitude: -0.5, topic: "test" })
    );
    const { classifySentiment } = await import("./enrich.js");
    const result = await classifySentiment("Article", "");
    expect(result.magnitude).toBe(0);
  });

  it("falls back to score=0 when key is missing", async () => {
    bedrockSendMock.mockResolvedValue(bedrockJsonResponse({ magnitude: 0.3, topic: "test" }));
    const { classifySentiment } = await import("./enrich.js");
    const result = await classifySentiment("Article", "");
    expect(result.score).toBe(0);
  });

  it("model tag is always claude-haiku-4-5", async () => {
    bedrockSendMock.mockResolvedValue(
      bedrockJsonResponse({ score: 0, magnitude: 0, topic: "test" })
    );
    const { classifySentiment } = await import("./enrich.js");
    const result = await classifySentiment("Article", "");
    expect(result.model).toBe("anthropic.claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// checkDedup — mocked fetch (OpenAI embeddings) + mocked DynamoDB
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = 4; // tiny vectors for tests
function makeVec(val: number): number[] {
  return [val, 0, 0, 0];
}

describe("checkDedup", () => {
  beforeEach(() => {
    // Mock global fetch for OpenAI embeddings API
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockEmbeddingResponse(vector: number[]) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: vector }] }),
    });
  }

  it("returns duplicateOf=null and caches the vector when no cached items", async () => {
    mockEmbeddingResponse(makeVec(1));
    // Scan returns empty
    dynamoSendMock.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Scan") return { Items: [] };
      return {};
    });

    const { checkDedup } = await import("./enrich.js");
    const result = await checkDedup({
      id: "art-1",
      title: "BTC surge",
      body: "Bitcoin rises sharply",
      publishedAt: "2026-05-07T00:00:00Z",
    });

    expect(result.duplicateOf).toBeNull();
    expect(result.embeddingModel).toBe("text-embedding-3-small");
    // Verify PutCommand was called to cache the vector
    const puts = dynamoSendMock.mock.calls.filter((c) => c[0].__cmd === "Put");
    expect(puts).toHaveLength(1);
    expect(puts[0][0].input.Item.articleId).toBe("art-1");
    expect(puts[0][0].input.Item.model).toBe("text-embedding-3-small");
  });

  it("detects a duplicate when cosine similarity exceeds threshold", async () => {
    // New article and cached article have identical vectors → sim = 1.0 > 0.85
    mockEmbeddingResponse(makeVec(1));
    dynamoSendMock.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Scan") {
        return {
          Items: [
            {
              articleId: "art-original",
              vector: makeVec(1), // identical → cosine sim = 1
              model: "text-embedding-3-small",
              dim: EMBEDDING_DIM,
              publishedAt: "2026-05-07T00:00:00Z",
              ttl: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        };
      }
      return {};
    });

    const { checkDedup } = await import("./enrich.js");
    const result = await checkDedup({
      id: "art-dup",
      title: "BTC surge",
      body: "Bitcoin rises sharply",
      publishedAt: "2026-05-07T01:00:00Z",
    });

    expect(result.duplicateOf).toBe("art-original");
    // Should NOT have cached (it's a duplicate)
    const puts = dynamoSendMock.mock.calls.filter((c) => c[0].__cmd === "Put");
    expect(puts).toHaveLength(0);
  });

  it("does not match when cached vector is from a different model", async () => {
    mockEmbeddingResponse(makeVec(1));
    dynamoSendMock.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Scan") {
        return {
          Items: [
            {
              articleId: "art-old-model",
              vector: makeVec(1),
              model: "text-embedding-ada-002", // different model — must skip
              dim: EMBEDDING_DIM,
              publishedAt: "2026-05-07T00:00:00Z",
              ttl: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        };
      }
      return {};
    });

    const { checkDedup } = await import("./enrich.js");
    const result = await checkDedup({
      id: "art-2",
      title: "BTC surge",
      body: "Bitcoin rises sharply",
      publishedAt: "2026-05-07T01:00:00Z",
    });

    expect(result.duplicateOf).toBeNull(); // skipped — different model
    // Should have cached
    const puts = dynamoSendMock.mock.calls.filter((c) => c[0].__cmd === "Put");
    expect(puts).toHaveLength(1);
  });

  it("does not flag as duplicate when similarity is below threshold", async () => {
    // Orthogonal vectors: cosine sim = 0 < 0.85
    mockEmbeddingResponse([1, 0, 0, 0]);
    dynamoSendMock.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Scan") {
        return {
          Items: [
            {
              articleId: "art-different",
              vector: [0, 1, 0, 0], // orthogonal → cosine sim = 0
              model: "text-embedding-3-small",
              dim: EMBEDDING_DIM,
              publishedAt: "2026-05-07T00:00:00Z",
              ttl: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        };
      }
      return {};
    });

    const { checkDedup } = await import("./enrich.js");
    const result = await checkDedup({
      id: "art-unique",
      title: "XRP ruling",
      body: "Ripple wins",
      publishedAt: "2026-05-07T01:00:00Z",
    });

    expect(result.duplicateOf).toBeNull();
  });

  it("uses the OPENAI_API_KEY env var and sends the correct model", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    mockEmbeddingResponse(makeVec(0.5));
    dynamoSendMock.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Scan") return { Items: [] };
      return {};
    });

    const { checkDedup, EMBEDDING_MODEL } = await import("./enrich.js");
    await checkDedup({ id: "x", title: "t", body: "b", publishedAt: "2026-05-07T00:00:00Z" });

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.headers.Authorization).toBe("Bearer sk-test-123");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(EMBEDDING_MODEL);
    expect(EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });
});
