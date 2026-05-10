import { describe, it, expect, vi, beforeEach } from "vitest";

const dynamoSend = vi.fn();
const dynamoRawSend = vi.fn();
const ecsSend = vi.fn();
const sqsSend = vi.fn();
const cwLogsSend = vi.fn();
const lambdaSend = vi.fn();
const ssmSend = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: dynamoRawSend })),
  DescribeTableCommand: vi.fn().mockImplementation((input) => ({ __cmd: "DescribeTable", input })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: dynamoSend }) },
  ScanCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Scan", input })),
  GetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Get", input })),
  QueryCommand: vi.fn().mockImplementation((input) => ({ __cmd: "Query", input })),
  BatchGetCommand: vi.fn().mockImplementation((input) => ({ __cmd: "BatchGet", input })),
}));

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSend })),
  DescribeServicesCommand: vi
    .fn()
    .mockImplementation((input) => ({ __cmd: "DescribeServices", input })),
  ListTasksCommand: vi.fn().mockImplementation((input) => ({ __cmd: "ListTasks", input })),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({ send: sqsSend })),
  GetQueueAttributesCommand: vi
    .fn()
    .mockImplementation((input) => ({ __cmd: "GetQueueAttributes", input })),
}));

vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: vi.fn().mockImplementation(() => ({ send: cwLogsSend })),
  GetLogEventsCommand: vi.fn().mockImplementation((input) => ({ __cmd: "GetLogEvents", input })),
  DescribeLogStreamsCommand: vi
    .fn()
    .mockImplementation((input) => ({ __cmd: "DescribeLogStreams", input })),
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSend })),
  GetFunctionCommand: vi.fn().mockImplementation((input) => ({ __cmd: "GetFunction", input })),
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  GetParameterCommand: vi.fn().mockImplementation((input) => ({ __cmd: "GetParameter", input })),
  PutParameterCommand: vi.fn().mockImplementation((input) => ({ __cmd: "PutParameter", input })),
}));

beforeEach(() => {
  vi.resetModules();
  for (const m of [dynamoSend, dynamoRawSend, ecsSend, sqsSend, cwLogsSend, lambdaSend, ssmSend]) {
    m.mockReset();
  }
  process.env.TABLE_PREFIX = "quantara-dev-";
  process.env.AWS_ACCOUNT_ID = "111122223333";
  process.env.AWS_REGION = "us-west-2";
  process.env.ENVIRONMENT = "dev";
});

async function importService() {
  return import("./admin.service.js");
}

describe("getWhitelist", () => {
  it("parses a comma-separated SSM value into an ips array", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "1.2.3.4,5.6.7.0/24, 9.9.9.9" } });
    const { getWhitelist } = await importService();
    const result = await getWhitelist();
    expect(result).toEqual({ ips: ["1.2.3.4", "5.6.7.0/24", "9.9.9.9"] });
  });

  it("returns an empty list when the parameter is missing", async () => {
    const err = Object.assign(new Error("not found"), { name: "ParameterNotFound" });
    ssmSend.mockRejectedValue(err);
    const { getWhitelist } = await importService();
    expect(await getWhitelist()).toEqual({ ips: [] });
  });

  it("rethrows non-ParameterNotFound errors", async () => {
    ssmSend.mockRejectedValue(new Error("AccessDenied"));
    const { getWhitelist } = await importService();
    await expect(getWhitelist()).rejects.toThrow("AccessDenied");
  });

  it("returns an empty list when the parameter exists but is empty", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "" } });
    const { getWhitelist } = await importService();
    expect(await getWhitelist()).toEqual({ ips: [] });
  });
});

describe("setWhitelist", () => {
  it("joins ips with commas and calls PutParameter with Overwrite=true", async () => {
    ssmSend.mockResolvedValue({});
    const { setWhitelist } = await importService();
    const result = await setWhitelist(["1.1.1.1", "2.2.2.0/24"]);
    expect(result).toEqual({ ips: ["1.1.1.1", "2.2.2.0/24"] });
    expect(ssmSend).toHaveBeenCalledTimes(1);
    const cmd = ssmSend.mock.calls[0][0];
    expect(cmd.__cmd).toBe("PutParameter");
    expect(cmd.input).toEqual({
      Name: "/quantara/dev/docs-allowed-ips",
      Value: "1.1.1.1,2.2.2.0/24",
      Type: "String",
      Overwrite: true,
    });
  });

  it("propagates SSM errors", async () => {
    ssmSend.mockRejectedValue(new Error("kms denied"));
    const { setWhitelist } = await importService();
    await expect(setWhitelist(["1.1.1.1"])).rejects.toThrow("kms denied");
  });
});

describe("encodeNewsCursor / decodeNewsCursor", () => {
  it("round-trips a cursor with only a day", async () => {
    const { encodeNewsCursor, decodeNewsCursor } = await importService();
    const cursor = { day: "2026-05-09" };
    expect(decodeNewsCursor(encodeNewsCursor(cursor))).toEqual(cursor);
  });

  it("round-trips a cursor with a day and lastEvaluatedKey", async () => {
    const { encodeNewsCursor, decodeNewsCursor } = await importService();
    const cursor = {
      day: "2026-05-08",
      lastEvaluatedKey: {
        newsId: "abc",
        publishedAt: "2026-05-08T10:00:00Z",
        publishedDay: "2026-05-08",
      },
    };
    expect(decodeNewsCursor(encodeNewsCursor(cursor))).toEqual(cursor);
  });

  it("returns null for invalid base64", async () => {
    const { decodeNewsCursor } = await importService();
    expect(decodeNewsCursor("not-valid-base64!!!")).toBeNull();
  });

  it("returns null for valid base64 but wrong shape (missing day)", async () => {
    const { decodeNewsCursor } = await importService();
    const bad = Buffer.from(JSON.stringify({ notDay: "foo" })).toString("base64url");
    expect(decodeNewsCursor(bad)).toBeNull();
  });

  it("drops a malformed lastEvaluatedKey but keeps the day", async () => {
    // Regression: previously, decodeNewsCursor accepted any lastEvaluatedKey
    // shape and passed it straight to ExclusiveStartKey, where DynamoDB would
    // throw and the endpoint would return an empty page. Now an invalid
    // lastEvaluatedKey is silently dropped so the caller falls back to a
    // day-only resume.
    const { decodeNewsCursor } = await importService();
    const malformed = Buffer.from(
      JSON.stringify({
        day: "2026-05-08",
        lastEvaluatedKey: { nested: { bad: "shape" } }, // nested object — invalid for DDB key
      }),
    ).toString("base64url");
    expect(decodeNewsCursor(malformed)).toEqual({ day: "2026-05-08" });
  });

  it("rejects lastEvaluatedKey containing arrays or null values", async () => {
    // JSON.stringify drops `undefined` values, so the only round-trippable
    // invalid LEK shapes are arrays-as-values, null-as-value, and nested
    // objects (covered above).
    const { decodeNewsCursor } = await importService();
    for (const lek of [
      { ok: "yes", arr: [1, 2] },
      { ok: "yes", nullVal: null },
    ]) {
      const enc = Buffer.from(
        JSON.stringify({ day: "2026-05-08", lastEvaluatedKey: lek }),
      ).toString("base64url");
      expect(decodeNewsCursor(enc)).toEqual({ day: "2026-05-08" });
    }
  });
});

describe("getNews", () => {
  it("queries the GSI by publishedDay and returns items newest-first", async () => {
    const mockItems = [
      {
        newsId: "b",
        publishedAt: "2026-05-09T12:00:00Z",
        publishedDay: "2026-05-09",
        title: "new",
      },
      {
        newsId: "a",
        publishedAt: "2026-05-09T08:00:00Z",
        publishedDay: "2026-05-09",
        title: "old",
      },
    ];
    dynamoSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Query") return { Items: mockItems };
      if (cmd.__cmd === "Get") return { Item: { value: 55, classification: "Greed" } };
      return {};
    });

    const { getNews } = await importService();
    const result = await getNews(2);
    expect(result.news).toHaveLength(2);
    expect(result.news[0].title).toBe("new");
    expect(result.news[1].title).toBe("old");
    expect(result.fearGreed).toEqual({ value: 55, classification: "Greed" });
  });

  it("walks back to the previous day when current day has fewer rows than limit", async () => {
    // Today returns 1 item; yesterday returns 2 more.
    const todayItem = {
      newsId: "t1",
      publishedAt: "2026-05-09T10:00:00Z",
      publishedDay: "2026-05-09",
    };
    const yesterdayItems = [
      { newsId: "y1", publishedAt: "2026-05-08T23:00:00Z", publishedDay: "2026-05-08" },
      { newsId: "y2", publishedAt: "2026-05-08T12:00:00Z", publishedDay: "2026-05-08" },
    ];
    let callCount = 0;
    dynamoSend.mockImplementation(
      async (cmd: {
        __cmd: string;
        input?: { ExpressionAttributeValues?: Record<string, unknown> };
      }) => {
        if (cmd.__cmd === "Get") return { Item: null };
        if (cmd.__cmd === "Query") {
          callCount++;
          const day = cmd.input?.ExpressionAttributeValues?.[":day"] as string | undefined;
          if (day === "2026-05-09") return { Items: [todayItem] };
          if (day === "2026-05-08") return { Items: yesterdayItems };
          return { Items: [] };
        }
        return {};
      },
    );

    // Freeze "today" to 2026-05-09 so todayUtc() returns "2026-05-09".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T15:00:00Z"));

    const { getNews } = await importService();
    const result = await getNews(3);
    expect(result.news).toHaveLength(3);
    expect(result.news[0].newsId).toBe("t1");
    expect(result.news[1].newsId).toBe("y1");
    expect(result.news[2].newsId).toBe("y2");
    expect(callCount).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });

  it("stops walking at the lookback limit even if fewer than limit rows found", async () => {
    // Every day returns 0 items — should stop after NEWS_LOOKBACK_DAYS days.
    dynamoSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") return { Item: null };
      if (cmd.__cmd === "Query") return { Items: [] };
      return {};
    });

    const { getNews } = await importService();
    const result = await getNews(50);
    // Should return empty, not hang.
    expect(result.news).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("emits nextCursor pointing at the next calendar day when the page fills exactly on day-exhaustion", async () => {
    // Mock the system clock so `todayUtc()` resolves to 2026-05-09.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T18:00:00Z"));

    const items = Array.from({ length: 2 }, (_, i) => ({
      newsId: `n${i}`,
      publishedAt: `2026-05-09T${String(12 - i).padStart(2, "0")}:00:00Z`,
      publishedDay: "2026-05-09",
    }));
    dynamoSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") return { Item: null };
      // No LastEvaluatedKey → day exhausted by this query.
      if (cmd.__cmd === "Query") return { Items: items };
      return {};
    });

    const { getNews, decodeNewsCursor } = await importService();
    const result = await getNews(2);

    expect(result.news).toHaveLength(2);
    expect(typeof result.nextCursor).toBe("string");

    // Regression: cursor must point to the immediately-prior day (2026-05-08).
    // Earlier impl applied prevDay() twice — once in the loop, once when
    // building the cursor — silently skipping a calendar day per page.
    const decoded = decodeNewsCursor(result.nextCursor!);
    expect(decoded).toEqual({ day: "2026-05-08" });

    vi.useRealTimers();
  });

  it("resumes from cursor on next page call", async () => {
    const { getNews, encodeNewsCursor } = await importService();
    const cursor = encodeNewsCursor({ day: "2026-05-08" });

    const page2Items = [
      { newsId: "p2a", publishedAt: "2026-05-08T20:00:00Z", publishedDay: "2026-05-08" },
    ];
    dynamoSend.mockImplementation(
      async (cmd: {
        __cmd: string;
        input?: { ExpressionAttributeValues?: Record<string, unknown> };
      }) => {
        if (cmd.__cmd === "Get") return { Item: null };
        if (cmd.__cmd === "Query") {
          const day = cmd.input?.ExpressionAttributeValues?.[":day"] as string | undefined;
          if (day === "2026-05-08") return { Items: page2Items };
          return { Items: [] };
        }
        return {};
      },
    );

    const result = await getNews(50, cursor);
    expect(result.news[0].newsId).toBe("p2a");
  });

  it("returns an empty result and null nextCursor when Query throws", async () => {
    dynamoSend.mockRejectedValue(new Error("throttled"));
    const { getNews } = await importService();
    const result = await getNews();
    expect(result).toEqual({ news: [], fearGreed: null, nextCursor: null });
  });

  it("keeps querying the same day when DynamoDB returns a partial page with LastEvaluatedKey (1 MB cap)", async () => {
    // Regression: previously, code broke out as soon as LastEvaluatedKey was
    // present even if collected.length < limit, returning a short page
    // when DynamoDB had explicitly signalled more rows existed.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T18:00:00Z"));

    const firstPage = [
      { newsId: "a", publishedAt: "2026-05-09T12:00:00Z", publishedDay: "2026-05-09" },
    ];
    const secondPage = [
      { newsId: "b", publishedAt: "2026-05-09T11:00:00Z", publishedDay: "2026-05-09" },
      { newsId: "c", publishedAt: "2026-05-09T10:00:00Z", publishedDay: "2026-05-09" },
    ];

    let callCount = 0;
    dynamoSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") return { Item: null };
      if (cmd.__cmd === "Query") {
        callCount++;
        if (callCount === 1) {
          // Partial page: only 1 item returned, but LastEvaluatedKey indicates more.
          return { Items: firstPage, LastEvaluatedKey: { newsId: "a" } };
        }
        if (callCount === 2) {
          return { Items: secondPage };
        }
        return { Items: [] };
      }
      return {};
    });

    const { getNews } = await importService();
    const result = await getNews(3);

    expect(result.news).toHaveLength(3);
    expect(result.news.map((r) => r.newsId)).toEqual(["a", "b", "c"]);
    // Two queries against the same day (NOT one short-page query then walk
    // back to yesterday).
    expect(callCount).toBe(2);

    vi.useRealTimers();
  });

  it("short-circuits without issuing reads when the cursor's day is older than the lookback window", async () => {
    // Regression: daysWalked previously initialized to 0, ignoring cursor.day,
    // so a stale or forged cursor with an old day could still trigger a Query.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T18:00:00Z"));

    const { getNews, encodeNewsCursor } = await importService();
    // Construct a cursor for a day far older than NEWS_LOOKBACK_DAYS (14).
    const ancientCursor = encodeNewsCursor({ day: "2025-01-01" });

    let queryCalls = 0;
    dynamoSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Get") return { Item: null };
      if (cmd.__cmd === "Query") {
        queryCalls++;
        return { Items: [] };
      }
      return {};
    });

    const result = await getNews(50, ancientCursor);

    expect(result.news).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
    expect(queryCalls).toBe(0);

    vi.useRealTimers();
  });

  it("does not emit a nextCursor when the page fills exactly at the lookback boundary", async () => {
    // Regression: when the page filled on the oldest allowed day and the
    // loop advanced `currentDay` past NEWS_LOOKBACK_DAYS at the bottom, we
    // would still emit a cursor pointing to that out-of-window day. The next
    // call would short-circuit on the daysWalked check and return an empty
    // page — confusing for clients.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T18:00:00Z"));

    // Mock: today and yesterday return 0 items, then day NEWS_LOOKBACK_DAYS-1
    // ago (i.e. 2026-04-26) returns exactly the requested 2 items so the
    // page fills there and `currentDay` advances to 2026-04-25 — which is
    // outside the 14-day window from today (2026-05-09).
    const items = [
      { newsId: "p1", publishedAt: "2026-04-26T10:00:00Z", publishedDay: "2026-04-26" },
      { newsId: "p2", publishedAt: "2026-04-26T09:00:00Z", publishedDay: "2026-04-26" },
    ];
    dynamoSend.mockImplementation(
      async (cmd: {
        __cmd: string;
        input?: { ExpressionAttributeValues?: Record<string, unknown> };
      }) => {
        if (cmd.__cmd === "Get") return { Item: null };
        if (cmd.__cmd === "Query") {
          const day = cmd.input?.ExpressionAttributeValues?.[":day"] as string | undefined;
          if (day === "2026-04-26") return { Items: items };
          return { Items: [] };
        }
        return {};
      },
    );

    const { getNews } = await importService();
    const result = await getNews(2);

    expect(result.news).toHaveLength(2);
    expect(result.nextCursor).toBeNull();

    vi.useRealTimers();
  });
});

describe("getMarket", () => {
  it("aggregates prices, candles, and fear-greed in parallel", async () => {
    dynamoSend.mockImplementation(
      async (cmd: {
        __cmd: string;
        input?: { ExpressionAttributeValues?: Record<string, unknown>; Key?: { metaKey?: string } };
      }) => {
        if (cmd.__cmd === "Get") return { Item: { value: 30, classification: "Fear" } };
        if (cmd.__cmd === "Query") {
          const ev = cmd.input?.ExpressionAttributeValues as Record<string, string> | undefined;
          const prefix = ev?.[":prefix"];
          if (prefix === "binanceus#1m#") {
            return { Items: [{ pair: "BTC/USDT", openTime: 1, close: 100 }] };
          }
          // Latest prices query (no :prefix)
          return { Items: [{ pair: ev?.[":pair"], price: 50000 }] };
        }
        return {};
      },
    );

    const { getMarket } = await importService();
    const result = await getMarket("BTC/USDT", "binanceus");
    expect(result.pair).toBe("BTC/USDT");
    expect(result.exchange).toBe("binanceus");
    expect(result.candles).toEqual([{ pair: "BTC/USDT", openTime: 1, close: 100 }]);
    expect(result.fearGreed).toEqual({ value: 30, classification: "Fear" });
    expect(result.prices.length).toBeGreaterThan(0);
  });

  it("tolerates Query failures per pair without rejecting", async () => {
    dynamoSend.mockRejectedValue(new Error("ddb down"));
    const { getMarket } = await importService();
    const result = await getMarket("BTC/USDT", "binanceus");
    expect(result.prices).toEqual([]);
    expect(result.candles).toEqual([]);
    expect(result.fearGreed).toBeNull();
  });
});

describe("getMarket — indicator key fix (Bug 1)", () => {
  it("returns indicator state when the table has a consensus PK, regardless of exchange param", async () => {
    const mockIndicatorItem = {
      pair: "BTC/USDT",
      exchange: "consensus",
      timeframe: "1m",
      asOfMs: 1700000000000,
      barsSinceStart: 50,
      rsi14: 55,
      ema20: 42000,
      ema50: 41000,
      ema200: 38000,
      macdLine: 100,
      macdSignal: 90,
      macdHist: 10,
      atr14: 500,
      bbUpper: 43000,
      bbMid: 42000,
      bbLower: 41000,
      bbWidth: 0.047,
      obv: 1000000,
      obvSlope: 500,
      vwap: 41800,
      volZ: 1.2,
      realizedVolAnnualized: 0.72,
      fearGreed: 55,
      dispersion: 0.0012,
      history: { rsi14: [], macdHist: [], ema20: [], ema50: [], close: [], volume: [] },
    };

    dynamoSend.mockImplementation(
      async (cmd: {
        __cmd: string;
        input?: {
          KeyConditionExpression?: string;
          ExpressionAttributeValues?: Record<string, unknown>;
          Key?: { metaKey?: string };
        };
      }) => {
        if (cmd.__cmd === "Get") return { Item: { value: 50, classification: "Neutral" } };
        if (cmd.__cmd === "Query") {
          const ev = cmd.input?.ExpressionAttributeValues as Record<string, string> | undefined;
          // Indicator query: pk contains #consensus#
          if (ev?.[":pk"] && String(ev[":pk"]).includes("#consensus#")) {
            return { Items: [mockIndicatorItem] };
          }
          // Other queries (prices, candles)
          return { Items: [] };
        }
        return {};
      },
    );

    const { getMarket } = await importService();

    // Called with exchange="binanceus" — but indicator key must still use "consensus"
    const result = await getMarket("BTC/USDT", "binanceus");
    expect(result.indicators).not.toBeNull();
    expect(result.indicators?.exchange).toBe("consensus");
    expect(result.indicators?.pair).toBe("BTC/USDT");
    expect(result.indicators?.rsi14).toBe(55);

    // Verify the query used "BTC/USDT#consensus#1m" as the PK
    const indicatorQuery = (
      dynamoSend.mock.calls as Array<
        [{ __cmd: string; input?: { ExpressionAttributeValues?: Record<string, unknown> } }]
      >
    )
      .map(([cmd]) => cmd)
      .find(
        (cmd) =>
          cmd.__cmd === "Query" &&
          String(
            (cmd.input?.ExpressionAttributeValues as Record<string, unknown>)?.[":pk"] ?? "",
          ).includes("#consensus#"),
      );
    expect(indicatorQuery).toBeDefined();
    expect(
      (indicatorQuery!.input!.ExpressionAttributeValues as Record<string, unknown>)[":pk"],
    ).toBe("BTC/USDT#consensus#1m");
  });

  it("returns indicators null when there is no consensus row (never binanceus key)", async () => {
    dynamoSend.mockImplementation(
      async (cmd: {
        __cmd: string;
        input?: { ExpressionAttributeValues?: Record<string, unknown>; Key?: { metaKey?: string } };
      }) => {
        if (cmd.__cmd === "Get") return { Item: null };
        if (cmd.__cmd === "Query") {
          const ev = cmd.input?.ExpressionAttributeValues as Record<string, string> | undefined;
          // Simulate only having a binanceus row — consensus lookup returns empty
          if (ev?.[":pk"] && String(ev[":pk"]).includes("#binanceus#")) {
            return { Items: [{ pair: "BTC/USDT", exchange: "binanceus" }] };
          }
          return { Items: [] };
        }
        return {};
      },
    );

    const { getMarket } = await importService();
    const result = await getMarket("BTC/USDT", "binanceus");
    expect(result.indicators).toBeNull();
  });
});

describe("computeDispersion via getMarket — dedupe fix (Bug 2)", () => {
  // Helper to mock getMarket returning specific price rows, then inspect dispersion
  async function dispersionFor(priceItems: Array<Record<string, unknown>>): Promise<number | null> {
    dynamoSend.mockImplementation(
      async (cmd: {
        __cmd: string;
        input?: { ExpressionAttributeValues?: Record<string, unknown>; Key?: { metaKey?: string } };
      }) => {
        if (cmd.__cmd === "Get") return { Item: null };
        if (cmd.__cmd === "Query") {
          const ev = cmd.input?.ExpressionAttributeValues as Record<string, unknown>;
          // Candles query has a :prefix key; prices query has :pair only
          if (ev?.[":prefix"]) return { Items: [] };
          // Indicator query has :pk
          if (ev?.[":pk"]) return { Items: [] };
          // Prices query: return priceItems filtered to the requested pair
          const requestedPair = ev?.[":pair"] as string | undefined;
          const items = requestedPair
            ? priceItems.filter((p) => p.pair === requestedPair)
            : priceItems;
          return { Items: items };
        }
        return {};
      },
    );

    const { getMarket } = await importService();
    const result = await getMarket("BTC/USDT", "binanceus");
    return result.dispersion as number | null;
  }

  it("returns null when all price rows are from the same exchange", async () => {
    const prices = [
      { pair: "BTC/USDT", exchange: "binanceus", price: 42000, stale: false },
      { pair: "BTC/USDT", exchange: "binanceus", price: 42100, stale: false },
      { pair: "BTC/USDT", exchange: "binanceus", price: 41900, stale: false },
    ];
    const result = await dispersionFor(prices);
    expect(result).toBeNull();
  });

  it("uses only the latest (first) tick per exchange and computes cross-exchange spread", async () => {
    // binanceus has two ticks (42100 is latest, 42000 is older); coinbase has one tick at 41000.
    // Expected: (42100 - 41000) / ((42100 + 41000) / 2) = 1100 / 41550
    const prices = [
      { pair: "BTC/USDT", exchange: "binanceus", price: 42100, stale: false }, // latest binanceus
      { pair: "BTC/USDT", exchange: "binanceus", price: 42000, stale: false }, // older binanceus — must be ignored
      { pair: "BTC/USDT", exchange: "coinbase", price: 41000, stale: false },
    ];
    const result = await dispersionFor(prices);
    const expectedDispersion = (42100 - 41000) / ((42100 + 41000) / 2);
    expect(result).toBeCloseTo(expectedDispersion, 8);
    // Confirm the older binanceus tick (42000) was not used — if it were, max would be 42100,
    // min would be 41000, avg would be (42100+42000+41000)/3 which differs from the expected value.
    const threeTickAvg = (42100 + 42000 + 41000) / 3;
    expect(result).not.toBeCloseTo((42100 - 41000) / threeTickAvg, 8);
  });

  it("returns null when only stale rows exist across different exchanges", async () => {
    const prices = [
      { pair: "BTC/USDT", exchange: "binanceus", price: 42000, stale: true },
      { pair: "BTC/USDT", exchange: "coinbase", price: 41000, stale: true },
    ];
    const result = await dispersionFor(prices);
    expect(result).toBeNull();
  });

  it("returns a correct value when exactly two exchanges each have one fresh row", async () => {
    const prices = [
      { pair: "BTC/USDT", exchange: "binanceus", price: 43000, stale: false },
      { pair: "BTC/USDT", exchange: "kraken", price: 41000, stale: false },
    ];
    const result = await dispersionFor(prices);
    const expected = (43000 - 41000) / ((43000 + 41000) / 2);
    expect(result).toBeCloseTo(expected, 8);
  });
});

describe("getGenieMetrics", () => {
  // Helper: build a minimal ratification row. `timeframe` is included so
  // the timeframe-filter path (now applied to ratRows too) works in tests.
  function makeRatRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      pair: "BTC/USDT",
      invokedAtRecordId: "2026-05-01T00:00:00.000Z#abc",
      invokedAt: "2026-05-01T00:00:00.000Z",
      invokedReason: "news",
      timeframe: "1h",
      fellBackToAlgo: false,
      cacheHit: false,
      costUsd: 0.01,
      ratified: { type: "buy", confidence: 0.85 },
      algoCandidate: { type: "buy" },
      ...overrides,
    };
  }

  // Helper: build a minimal outcome row matching the production resolver's
  // OutcomeRecord schema (`outcome` ∈ "correct" | "incorrect" | "neutral").
  function makeOutcomeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      pair: "BTC/USDT",
      signalId: "sig-1",
      outcome: "correct",
      gateReason: null,
      emittingTimeframe: "1h",
      resolvedAt: "2026-05-01T01:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
      ...overrides,
    };
  }

  // Helper: build a minimal signals-v2 row carrying ratificationStatus —
  // the source-of-truth for win-rate partitioning.
  function makeSignalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      pair: "BTC/USDT",
      signalId: "sig-1",
      ratificationStatus: null, // null/not-required → algoOnly bucket
      emittingTimeframe: "1h",
      closeTime: Date.parse("2026-05-01T00:00:00.000Z"),
      sk: `1h#${Date.parse("2026-05-01T00:00:00.000Z")}`,
      ...overrides,
    };
  }

  // Route mock invocations to the right table source. signals-v2 queries
  // are issued once per (pair, timeframe) so the mock filters signals by
  // the query's TF prefix (`:lo` ExpressionAttributeValue starts with `tf#`)
  // to avoid 4× duplicates from the per-TF fanout.
  function routedMock(sources: {
    signals?: unknown[];
    ratifications?: unknown[];
    outcomes?: unknown[];
  }) {
    return async (cmd: {
      __cmd: string;
      input?: {
        TableName?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    }) => {
      const t = cmd.input?.TableName ?? "";
      if (t.includes("signals-v2")) {
        const lo = (cmd.input?.ExpressionAttributeValues?.[":lo"] as string) ?? "";
        const tfPrefix = lo.split("#")[0];
        const matching = (sources.signals ?? []).filter(
          (s) => (s as { emittingTimeframe?: string }).emittingTimeframe === tfPrefix,
        );
        return { Items: matching };
      }
      if (t.includes("ratifications")) return { Items: sources.ratifications ?? [] };
      if (t.includes("signal-outcomes")) return { Items: sources.outcomes ?? [] };
      return { Items: [] };
    };
  }

  it("returns zero-counts when all tables are empty", async () => {
    // DynamoDB returns empty pages for all queries
    dynamoSend.mockResolvedValue({ Items: [] });

    const { getGenieMetrics } = await importService();
    const result = await getGenieMetrics();

    expect(result.total.signalCount).toBe(0);
    expect(result.outcomes.tp).toBe(0);
    expect(result.outcomes.sl).toBe(0);
    expect(result.cost.totalUsd).toBe(0);
    expect(result.gating.invoked).toBe(0);
    expect(result.winRate.overall).toBeNull();
    expect(result.cost.cacheHitRate).toBeNull();
  });

  it("counts gating reasons correctly", async () => {
    const rows = [
      makeRatRow({ invokedReason: "skip-low-confidence" }),
      makeRatRow({ invokedReason: "skip-rate-limited" }),
      makeRatRow({ invokedReason: "skip-daily-cap" }),
      makeRatRow({ invokedReason: "skip-no-trigger" }),
      makeRatRow({ invokedReason: "news" }), // invoked
      makeRatRow({ invokedReason: "vol" }), // invoked
    ];

    dynamoSend.mockImplementation(routedMock({ ratifications: rows }));

    const { getGenieMetrics } = await importService();
    // Use pair filter so only one pair is queried (avoids 5x multiplication
    // across SUPPORTED_PAIRS).
    const result = await getGenieMetrics(undefined, "BTC/USDT");

    expect(result.gating.skipLowConfidence).toBe(1);
    expect(result.gating.skipRateLimit).toBe(1);
    expect(result.gating.skipDailyCap).toBe(1);
    expect(result.gating.skipNotRequired).toBe(1);
    expect(result.gating.invoked).toBe(2);
    expect(result.total.gatedCount).toBe(4);
    // signalCount is now sourced from signals_v2, NOT from ratifications,
    // so 6 rat-rows with no signals_v2 rows → signalCount 0.
    expect(result.total.signalCount).toBe(0);
  });

  it("computes cache hit rate from invoked rows", async () => {
    const rows = [
      makeRatRow({ invokedReason: "news", cacheHit: true, costUsd: 0 }),
      makeRatRow({ invokedReason: "news", cacheHit: false, costUsd: 0.02 }),
      makeRatRow({ invokedReason: "vol", cacheHit: false, costUsd: 0.02 }),
    ];

    dynamoSend.mockImplementation(routedMock({ ratifications: rows }));

    const { getGenieMetrics } = await importService();
    // Use pair filter so only one pair is queried (avoids 5x multiplication
    // across SUPPORTED_PAIRS).
    const result = await getGenieMetrics(undefined, "BTC/USDT");

    // 1 cache hit out of 3 LLM invocations = 1/3
    expect(result.cost.cacheHitRate).toBeCloseTo(1 / 3, 5);
    expect(result.cost.totalUsd).toBeCloseTo(0.04, 5);
  });

  it("computes win rate from outcome rows", async () => {
    const outcomeRows = [
      makeOutcomeRow({ signalId: "sig-1", outcome: "correct" }),
      makeOutcomeRow({ signalId: "sig-2", outcome: "correct" }),
      makeOutcomeRow({ signalId: "sig-3", outcome: "incorrect" }),
      makeOutcomeRow({ signalId: "sig-4", outcome: "neutral" }),
    ];
    const signalRows = [
      makeSignalRow({ signalId: "sig-1" }),
      makeSignalRow({ signalId: "sig-2" }),
      makeSignalRow({ signalId: "sig-3" }),
      makeSignalRow({ signalId: "sig-4" }),
    ];

    dynamoSend.mockImplementation(routedMock({ signals: signalRows, outcomes: outcomeRows }));

    const { getGenieMetrics } = await importService();
    // Use pair filter so only one pair is queried (avoids 5x multiplication
    // across SUPPORTED_PAIRS).
    const result = await getGenieMetrics(undefined, "BTC/USDT");

    // 2 correct, 1 incorrect, 1 neutral → directional = 3, wins = 2 → 2/3
    expect(result.outcomes.tp).toBe(2);
    expect(result.outcomes.sl).toBe(1);
    expect(result.outcomes.neutral).toBe(1);
    expect(result.winRate.overall).toBeCloseTo(2 / 3, 5);
    // signalCount is from signals_v2 directly
    expect(result.total.signalCount).toBe(4);
  });

  it("partitions algoOnly vs llmRatified vs llmDowngraded by ratificationStatus", async () => {
    // 6 signals: 2 algoOnly (null + not-required), 2 llmRatified, 2 llmDowngraded.
    // Each has a paired outcome so win-rate is computable per partition.
    const signalRows = [
      makeSignalRow({ signalId: "a1", ratificationStatus: null }),
      makeSignalRow({ signalId: "a2", ratificationStatus: "not-required" }),
      makeSignalRow({ signalId: "r1", ratificationStatus: "ratified" }),
      makeSignalRow({ signalId: "r2", ratificationStatus: "ratified" }),
      makeSignalRow({ signalId: "d1", ratificationStatus: "downgraded" }),
      makeSignalRow({ signalId: "d2", ratificationStatus: "downgraded" }),
    ];
    const outcomeRows = [
      // algoOnly: 1 correct, 1 incorrect → 0.5
      makeOutcomeRow({ signalId: "a1", outcome: "correct" }),
      makeOutcomeRow({ signalId: "a2", outcome: "incorrect" }),
      // llmRatified: 2 correct → 1.0
      makeOutcomeRow({ signalId: "r1", outcome: "correct" }),
      makeOutcomeRow({ signalId: "r2", outcome: "correct" }),
      // llmDowngraded: 0 correct, 2 incorrect → 0.0
      makeOutcomeRow({ signalId: "d1", outcome: "incorrect" }),
      makeOutcomeRow({ signalId: "d2", outcome: "incorrect" }),
    ];

    dynamoSend.mockImplementation(routedMock({ signals: signalRows, outcomes: outcomeRows }));

    const { getGenieMetrics } = await importService();
    const result = await getGenieMetrics(undefined, "BTC/USDT");

    expect(result.winRate.algoOnly).toBeCloseTo(0.5, 5);
    expect(result.winRate.llmRatified).toBeCloseTo(1.0, 5);
    expect(result.winRate.llmDowngraded).toBeCloseTo(0.0, 5);
    expect(result.total.ratifiedCount).toBe(2);
    expect(result.total.downgradedCount).toBe(2);
    expect(result.total.signalCount).toBe(6);
  });

  it("computes avgPerTpUsd as null when there are no take-profit outcomes", async () => {
    dynamoSend.mockImplementation(
      routedMock({
        signals: [makeSignalRow({ signalId: "sig-only-incorrect" })],
        ratifications: [makeRatRow({ costUsd: 0.05 })],
        outcomes: [makeOutcomeRow({ signalId: "sig-only-incorrect", outcome: "incorrect" })],
      }),
    );

    const { getGenieMetrics } = await importService();
    const result = await getGenieMetrics(undefined, "BTC/USDT");

    expect(result.outcomes.tp).toBe(0);
    expect(result.cost.avgPerTpUsd).toBeNull();
    expect(result.cost.totalUsd).toBeCloseTo(0.05, 5);
  });

  it("filters outcomes AND signals by timeframe when specified", async () => {
    const signalRows = [
      makeSignalRow({ signalId: "h1", emittingTimeframe: "1h" }),
      makeSignalRow({ signalId: "h2", emittingTimeframe: "1h" }),
      makeSignalRow({ signalId: "f1", emittingTimeframe: "4h" }),
    ];
    const outcomeRows = [
      makeOutcomeRow({ signalId: "h1", outcome: "correct", emittingTimeframe: "1h" }),
      makeOutcomeRow({ signalId: "h2", outcome: "correct", emittingTimeframe: "1h" }),
      makeOutcomeRow({ signalId: "f1", outcome: "incorrect", emittingTimeframe: "4h" }),
    ];

    dynamoSend.mockImplementation(routedMock({ signals: signalRows, outcomes: outcomeRows }));

    const { getGenieMetrics } = await importService();
    const result = await getGenieMetrics(undefined, "BTC/USDT", "1h");

    // Only the two "1h" rows survive the filter on both signals and outcomes
    expect(result.outcomes.tp).toBe(2);
    expect(result.outcomes.sl).toBe(0);
    expect(result.total.signalCount).toBe(2);
  });

  it("filters ratification metrics by timeframe — gating, cost, cacheHitRate", async () => {
    // 1h ratifications: 1 invoked + 1 skip-low-confidence + 1 cache-hit invoked
    // 4h ratifications: 1 invoked + 1 skip-rate-limited
    // With timeframe=1h, only the three 1h rat-rows should contribute.
    const ratRows = [
      makeRatRow({ timeframe: "1h", invokedReason: "news", costUsd: 0.02, cacheHit: false }),
      makeRatRow({ timeframe: "1h", invokedReason: "skip-low-confidence", costUsd: 0 }),
      makeRatRow({ timeframe: "1h", invokedReason: "vol", costUsd: 0.01, cacheHit: true }),
      makeRatRow({ timeframe: "4h", invokedReason: "news", costUsd: 0.05 }),
      makeRatRow({ timeframe: "4h", invokedReason: "skip-rate-limited", costUsd: 0 }),
    ];

    dynamoSend.mockImplementation(routedMock({ ratifications: ratRows }));

    const { getGenieMetrics } = await importService();
    const result = await getGenieMetrics(undefined, "BTC/USDT", "1h");

    // Only 3 1h rat rows: 1 skip-low-confidence + 2 invoked (one cache-hit)
    expect(result.gating.skipLowConfidence).toBe(1);
    expect(result.gating.skipRateLimit).toBe(0); // the 4h one is filtered out
    expect(result.gating.invoked).toBe(2);
    expect(result.total.gatedCount).toBe(1);
    // Cost: 0.02 + 0 + 0.01 = 0.03 (4h's 0.05 excluded)
    expect(result.cost.totalUsd).toBeCloseTo(0.03, 5);
    // 1 cache hit out of 2 invocations = 0.5
    expect(result.cost.cacheHitRate).toBeCloseTo(0.5, 5);
  });

  it("uses provided since as windowStart", async () => {
    dynamoSend.mockResolvedValue({ Items: [] });

    const { getGenieMetrics } = await importService();
    const since = "2026-04-01T00:00:00.000Z";
    const result = await getGenieMetrics(since);

    expect(result.windowStart).toBe(since);
    expect(result.windowEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults windowStart to 7 days ago when since is omitted", async () => {
    dynamoSend.mockResolvedValue({ Items: [] });

    const { getGenieMetrics } = await importService();
    const before = Date.now();
    const result = await getGenieMetrics();
    const after = Date.now();

    const windowStartMs = new Date(result.windowStart).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // windowStart should be ~7 days before now
    expect(windowStartMs).toBeGreaterThanOrEqual(before - sevenDaysMs - 5000);
    expect(windowStartMs).toBeLessThanOrEqual(after - sevenDaysMs + 5000);
  });

  it("counts ratified vs downgraded signals from signals_v2.ratificationStatus", async () => {
    // Source of truth is the signals_v2 ratificationStatus, not a derived
    // comparison of ratified.type vs algoCandidate.type — Phase B1 already
    // resolved the comparison at write time.
    const signalRows = [
      makeSignalRow({ signalId: "r1", ratificationStatus: "ratified" }),
      makeSignalRow({ signalId: "d1", ratificationStatus: "downgraded" }),
    ];

    dynamoSend.mockImplementation(routedMock({ signals: signalRows }));

    const { getGenieMetrics } = await importService();
    const result = await getGenieMetrics(undefined, "BTC/USDT");

    expect(result.total.downgradedCount).toBe(1);
    expect(result.total.ratifiedCount).toBe(1);
    expect(result.total.signalCount).toBe(2);
  });
});

describe("getStatus", () => {
  it("returns aggregated AWS status with timestamp", async () => {
    dynamoSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "Scan") return { Count: 42 };
      if (cmd.__cmd === "Get") return { Item: { value: 60, classification: "Greed" } };
      return {};
    });
    dynamoRawSend.mockResolvedValue({ Table: { TableSizeBytes: 1024 } });
    ecsSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "DescribeServices") {
        return { services: [{ status: "ACTIVE", runningCount: 1, desiredCount: 1 }] };
      }
      return { taskArns: ["arn:aws:ecs:us-west-2:111:task/clu/abc123"] };
    });
    sqsSend.mockResolvedValue({
      Attributes: { ApproximateNumberOfMessages: "5", ApproximateNumberOfMessagesNotVisible: "1" },
    });
    cwLogsSend.mockImplementation(async (cmd: { __cmd: string }) => {
      if (cmd.__cmd === "DescribeLogStreams")
        return { logStreams: [{ logStreamName: "stream-1" }] };
      return { events: [{ message: "log line A" }, { message: "log line B" }] };
    });
    lambdaSend.mockResolvedValue({
      Configuration: { State: "Active", LastModified: "2026-04-25", CodeSize: 2048 },
    });

    const { getStatus } = await importService();
    const status = await getStatus();

    expect(status.tableCounts).toHaveLength(12);
    expect(status.tableCounts[0]).toEqual({ name: "prices", count: 42, size: 1024 });
    expect(status.fearGreed).toEqual({ value: 60, classification: "Greed" });
    expect(status.ecsStatus).toEqual({
      status: "ACTIVE",
      running: 1,
      desired: 1,
      taskId: "abc123",
    });
    expect(status.queueDepths).toHaveLength(6);
    expect(status.queueDepths[0]).toEqual({
      name: "enrichment",
      messages: 5,
      inflight: 1,
      dlq: false,
    });
    expect(status.queueDepths[1].dlq).toBe(true);
    expect(status.recentLogs).toEqual(["log line A", "log line B"]);
    expect(status.lambdaStatuses).toHaveLength(5);
    expect(status.lambdaStatuses[0]).toMatchObject({ name: "api", state: "Active", size: 2048 });
    expect(status.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("degrades gracefully when individual AWS calls fail", async () => {
    dynamoSend.mockRejectedValue(new Error("ddb"));
    dynamoRawSend.mockRejectedValue(new Error("ddb"));
    ecsSend.mockRejectedValue(new Error("ecs"));
    sqsSend.mockRejectedValue(new Error("sqs"));
    cwLogsSend.mockRejectedValue(new Error("cw"));
    lambdaSend.mockRejectedValue(new Error("lambda"));

    const { getStatus } = await importService();
    const status = await getStatus();

    expect(status.tableCounts.every((t) => t.count === -1 && t.size === 0)).toBe(true);
    expect(status.fearGreed).toBeNull();
    expect(status.ecsStatus).toEqual({ status: "ERROR", running: 0, desired: 0 });
    expect(status.queueDepths.every((q) => q.messages === -1)).toBe(true);
    expect(status.recentLogs[0]).toMatch(/Error:/);
    expect(status.lambdaStatuses.every((l) => l.state === "NOT FOUND")).toBe(true);
  });

  it("reports 'No log streams found' when CloudWatch has no streams", async () => {
    dynamoSend.mockResolvedValue({ Count: 0 });
    dynamoRawSend.mockResolvedValue({ Table: { TableSizeBytes: 0 } });
    ecsSend.mockResolvedValue({ services: [] });
    sqsSend.mockResolvedValue({ Attributes: {} });
    cwLogsSend.mockResolvedValue({ logStreams: [] });
    lambdaSend.mockResolvedValue({ Configuration: {} });

    const { getStatus } = await importService();
    const status = await getStatus();
    expect(status.recentLogs).toEqual(["No log streams found"]);
  });
});

describe("getRatifications", () => {
  function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      recordId: `rec-${Math.random().toString(36).slice(2, 8)}`,
      pair: "BTC/USDT",
      timeframe: "15m",
      invokedAt: "2026-05-09T10:00:00.000Z",
      invokedAtRecordId: "2026-05-09T10:00:00.000Z#rec-1",
      invokedReason: "news",
      triggerReason: "bar_close",
      latencyMs: 100,
      costUsd: 0.001,
      cacheHit: false,
      validation: { ok: true },
      fellBackToAlgo: false,
      algoCandidate: { type: "buy", confidence: 0.7 },
      ratified: { type: "buy", confidence: 0.75, reasoning: "agreed" },
      llmRequest: { model: "claude-sonnet-4-6" },
      llmRawResponse: null,
      ...overrides,
    };
  }

  it("returns empty page when DDB has no rows for any pair", async () => {
    dynamoSend.mockResolvedValue({ Items: [] });
    const { getRatifications } = await importService();
    const page = await getRatifications({ limit: 50 });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeNull();
  });

  it("filters by triggerReason (the user-facing field), not invokedReason", async () => {
    dynamoSend.mockResolvedValue({
      Items: [
        makeRow({ recordId: "a", triggerReason: "bar_close" }),
        makeRow({
          recordId: "b",
          triggerReason: "sentiment_shock",
          invokedAtRecordId: "2026-05-09T10:01:00.000Z#b",
          invokedAt: "2026-05-09T10:01:00.000Z",
        }),
      ],
    });
    const { getRatifications } = await importService();
    const page = await getRatifications({ pair: "BTC/USDT", triggerReason: "sentiment_shock" });
    expect(page.items.map((r) => r.recordId)).toEqual(["b"]);
  });

  it("treats absent triggerReason as bar_close (pre-#181 records)", async () => {
    dynamoSend.mockResolvedValue({
      Items: [makeRow({ recordId: "old", triggerReason: undefined })],
    });
    const { getRatifications } = await importService();
    const page = await getRatifications({ pair: "BTC/USDT", triggerReason: "bar_close" });
    expect(page.items.map((r) => r.recordId)).toEqual(["old"]);
  });

  it("sorts merged fan-out results newest-first across pairs", async () => {
    dynamoSend.mockImplementationOnce(async () => ({
      Items: [
        makeRow({
          recordId: "old-btc",
          invokedAt: "2026-05-09T10:00:00.000Z",
          invokedAtRecordId: "2026-05-09T10:00:00.000Z#old-btc",
        }),
      ],
    }));
    for (let i = 0; i < 3; i++) dynamoSend.mockImplementationOnce(async () => ({ Items: [] }));
    dynamoSend.mockImplementationOnce(async () => ({
      Items: [
        makeRow({
          recordId: "new-doge",
          pair: "DOGE/USDT",
          invokedAt: "2026-05-09T10:30:00.000Z",
          invokedAtRecordId: "2026-05-09T10:30:00.000Z#new-doge",
        }),
      ],
    }));

    const { getRatifications } = await importService();
    const page = await getRatifications({ limit: 50 });
    expect(page.items.map((r) => r.recordId)).toEqual(["new-doge", "old-btc"]);
  });

  it("encodes per-pair cursor map (base64 JSON) when more rows remain", async () => {
    // Two rows, limit 1 → one returned, one held back, cursor populated.
    dynamoSend.mockResolvedValueOnce({
      Items: [
        makeRow({
          recordId: "a",
          invokedAt: "2026-05-09T10:01:00.000Z",
          invokedAtRecordId: "2026-05-09T10:01:00.000Z#a",
        }),
        makeRow({
          recordId: "b",
          invokedAt: "2026-05-09T10:00:00.000Z",
          invokedAtRecordId: "2026-05-09T10:00:00.000Z#b",
        }),
      ],
    });
    const { getRatifications } = await importService();
    const page = await getRatifications({ pair: "BTC/USDT", limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.cursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(page.cursor!, "base64").toString());
    // The LAST returned item (not the first un-returned) is the cursor anchor —
    // ExclusiveStartKey skips strictly equal keys.
    expect(decoded["BTC/USDT"]).toEqual({
      pair: "BTC/USDT",
      invokedAtRecordId: "2026-05-09T10:01:00.000Z#a",
    });
  });

  it("ignores malformed cursor (logs + continues with no resume)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dynamoSend.mockResolvedValue({ Items: [] });
    const { getRatifications } = await importService();
    await getRatifications({ pair: "BTC/USDT", cursor: "not-base64-or-json" });
    expect(warn).toHaveBeenCalled();
    // Still queries DDB without ExclusiveStartKey on the call:
    const callArgs = dynamoSend.mock.calls[0][0];
    expect(callArgs.input.ExclusiveStartKey).toBeUndefined();
    warn.mockRestore();
  });

  it("does not return the heavy nested payloads for un-mapped pairs", async () => {
    dynamoSend.mockResolvedValue({ Items: [] });
    const { getRatifications } = await importService();
    const page = await getRatifications({ pair: "BTC/USDT", limit: 1 });
    expect(page.items).toEqual([]);
    // No throw, valid empty cursor.
    expect(page.cursor).toBeNull();
  });
});
