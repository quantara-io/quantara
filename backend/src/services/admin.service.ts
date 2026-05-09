import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  QueryCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BlendedSignal, IndicatorState } from "@quantara/shared";
import { HAIKU_INPUT_PRICE_PER_M, HAIKU_OUTPUT_PRICE_PER_M } from "@quantara/shared";
import { ECSClient, DescribeServicesCommand, ListTasksCommand } from "@aws-sdk/client-ecs";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  DescribeLogStreamsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";

const REGION = process.env.AWS_REGION ?? "us-west-2";
const PREFIX = (process.env.TABLE_PREFIX ?? "quantara-dev-").replace(/-$/, "");
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? "";
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;
const INDICATOR_STATE_TABLE =
  process.env.TABLE_INDICATOR_STATE ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}indicator-state`;
const NEWS_TABLE =
  process.env.TABLE_NEWS_EVENTS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}news-events`;

/**
 * GSI on news-events for time-ordered queries.
 * HASH: publishedDay (YYYY-MM-DD)
 * RANGE: publishedAt (ISO-8601)
 * Requires the published-day-index GSI to be deployed (see backend/infra — needs-human-review).
 */
const NEWS_DAY_INDEX = "published-day-index";

/** Maximum number of days to walk back when paginating news. */
const NEWS_LOOKBACK_DAYS = 14;

interface NewsCursor {
  day: string;
  lastEvaluatedKey?: Record<string, unknown>;
}

/** Encode a cursor to an opaque base64 string for the API response. */
export function encodeNewsCursor(cursor: NewsCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * Validate that an unknown value is a plausible DynamoDB ExclusiveStartKey:
 * a flat object whose values are primitives DDB accepts in keys (string,
 * number, boolean). Anything else (nested objects, arrays, null/undefined,
 * functions) gets rejected so a malformed `lastEvaluatedKey` from a forged
 * or corrupted cursor doesn't reach the SDK and fail the whole request.
 */
function isValidLastEvaluatedKey(v: unknown): v is Record<string, string | number | boolean> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
      return false;
    }
  }
  return true;
}

/**
 * Decode an opaque cursor. Returns null if the input is invalid. If the
 * cursor's `day` is well-formed but `lastEvaluatedKey` has the wrong shape,
 * we drop just the `lastEvaluatedKey` field rather than rejecting the whole
 * cursor — the caller can still resume at the day boundary.
 */
export function decodeNewsCursor(encoded: string): NewsCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (
      typeof obj !== "object" ||
      obj === null ||
      !("day" in obj) ||
      typeof (obj as { day: unknown }).day !== "string"
    ) {
      return null;
    }
    const day = (obj as { day: string }).day;
    const rawLek = (obj as { lastEvaluatedKey?: unknown }).lastEvaluatedKey;
    if (rawLek === undefined) return { day };
    if (!isValidLastEvaluatedKey(rawLek)) return { day };
    return { day, lastEvaluatedKey: rawLek };
  } catch {
    return null;
  }
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const dynamoRaw = new DynamoDBClient({ region: REGION });
const ecs = new ECSClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const cwLogs = new CloudWatchLogsClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

const TABLES = [
  "prices",
  "candles",
  "news-events",
  "ingestion-metadata",
  "signals",
  "signal-history",
  "users",
  "deals",
  "deal-interests",
  "coach-sessions",
  "coach-messages",
  "campaigns",
];

const SQS_QUEUES = [
  "enrichment",
  "enrichment-dlq",
  "market-events",
  "market-events-dlq",
  "enriched-news",
  "enriched-news-dlq",
];

const LAMBDAS = ["api", "ingestion", "backfill", "news-backfill", "enrichment"];

async function getTableCount(table: string): Promise<number> {
  try {
    const result = await dynamo.send(
      new ScanCommand({ TableName: `${PREFIX}-${table}`, Select: "COUNT" }),
    );
    return result.Count ?? 0;
  } catch {
    return -1;
  }
}

async function getTableSize(table: string): Promise<number> {
  try {
    const result = await dynamoRaw.send(
      new DescribeTableCommand({ TableName: `${PREFIX}-${table}` }),
    );
    return result.Table?.TableSizeBytes ?? 0;
  } catch {
    return 0;
  }
}

async function getFearGreed(): Promise<{ value: number; classification: string } | null> {
  try {
    const result = await dynamo.send(
      new GetCommand({
        TableName: `${PREFIX}-ingestion-metadata`,
        Key: { metaKey: "market:fear-greed" },
      }),
    );
    if (!result.Item) return null;
    return {
      value: result.Item.value as number,
      classification: result.Item.classification as string,
    };
  } catch (err) {
    console.error("[admin.service] getFearGreed failed:", err);
    return null;
  }
}

async function getEcsStatus(): Promise<{
  status: string;
  running: number;
  desired: number;
  taskId?: string;
}> {
  try {
    const cluster = `${PREFIX}-ingestion`;
    const [svc, tasks] = await Promise.all([
      ecs.send(new DescribeServicesCommand({ cluster, services: [cluster] })),
      ecs.send(new ListTasksCommand({ cluster, serviceName: cluster })),
    ]);
    const service = svc.services?.[0];
    return {
      status: service?.status ?? "UNKNOWN",
      running: service?.runningCount ?? 0,
      desired: service?.desiredCount ?? 0,
      taskId: tasks.taskArns?.[0]?.split("/").pop(),
    };
  } catch {
    return { status: "ERROR", running: 0, desired: 0 };
  }
}

async function getQueueDepth(
  queue: string,
): Promise<{ name: string; messages: number; inflight: number; dlq: boolean }> {
  try {
    const url = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${PREFIX}-${queue}`;
    const result = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    return {
      name: queue,
      messages: parseInt(result.Attributes?.ApproximateNumberOfMessages ?? "0"),
      inflight: parseInt(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0"),
      dlq: queue.endsWith("-dlq"),
    };
  } catch {
    return { name: queue, messages: -1, inflight: 0, dlq: queue.endsWith("-dlq") };
  }
}

async function getRecentLogs(limit = 20): Promise<string[]> {
  try {
    const logGroupName = `/ecs/${PREFIX}-ingestion`;
    const streams = await cwLogs.send(
      new DescribeLogStreamsCommand({
        logGroupName,
        orderBy: "LastEventTime",
        descending: true,
        limit: 1,
      }),
    );
    const logStreamName = streams.logStreams?.[0]?.logStreamName;
    if (!logStreamName) return ["No log streams found"];
    const events = await cwLogs.send(
      new GetLogEventsCommand({
        logGroupName,
        logStreamName,
        limit,
        startFromHead: false,
      }),
    );
    return (events.events ?? []).map((e) => e.message ?? "").filter(Boolean);
  } catch (err) {
    return [`Error: ${(err as Error).message}`];
  }
}

async function getLambdaStatus(
  name: string,
): Promise<{ name: string; state: string; lastModified: string; size: number }> {
  try {
    const result = await lambda.send(new GetFunctionCommand({ FunctionName: `${PREFIX}-${name}` }));
    return {
      name,
      state: result.Configuration?.State ?? "Unknown",
      lastModified: result.Configuration?.LastModified ?? "",
      size: result.Configuration?.CodeSize ?? 0,
    };
  } catch {
    return { name, state: "NOT FOUND", lastModified: "", size: 0 };
  }
}

export async function getStatus() {
  const [tableCounts, fearGreed, ecsStatus, queueDepths, recentLogs, lambdaStatuses] =
    await Promise.all([
      Promise.all(
        TABLES.map(async (t) => ({
          name: t,
          count: await getTableCount(t),
          size: await getTableSize(t),
        })),
      ),
      getFearGreed(),
      getEcsStatus(),
      Promise.all(SQS_QUEUES.map((q) => getQueueDepth(q))),
      getRecentLogs(20),
      Promise.all(LAMBDAS.map((l) => getLambdaStatus(l))),
    ]);
  return {
    tableCounts,
    fearGreed,
    ecsStatus,
    queueDepths,
    recentLogs,
    lambdaStatuses,
    timestamp: new Date().toISOString(),
  };
}

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"];

async function getLatestPrices() {
  const now = Date.now();
  const results: Array<Record<string, unknown>> = [];
  for (const pair of PAIRS) {
    try {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: `${PREFIX}-prices`,
          KeyConditionExpression: "#pair = :pair",
          ExpressionAttributeNames: { "#pair": "pair" },
          ExpressionAttributeValues: { ":pair": pair },
          ScanIndexForward: false,
          Limit: 3,
        }),
      );
      for (const item of result.Items ?? []) {
        const timestamp = item.timestamp as string | undefined;
        const ageSeconds = timestamp
          ? Math.round((now - new Date(timestamp).getTime()) / 1000)
          : null;
        results.push({ ...item, ageSeconds });
      }
    } catch (err) {
      console.error(`[admin.service] getLatestPrices failed for ${pair}:`, err);
    }
  }
  return results;
}

async function getIndicatorState(
  pair: string,
  exchange: string,
  timeframe = "1m",
): Promise<IndicatorState | null> {
  // Indicator snapshots are always written with exchange="consensus" by the indicator handler.
  // Per-exchange indicator state is not produced, so hard-code "consensus" here regardless of
  // the requested exchange parameter.
  void exchange; // intentionally ignored — consensus is the only valid key
  try {
    const pk = `${pair}#consensus#${timeframe}`;
    const result = await dynamo.send(
      new QueryCommand({
        TableName: INDICATOR_STATE_TABLE,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": pk },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    const item = result.Items?.[0];
    if (!item) return null;
    return {
      pair: item.pair as string,
      exchange: item.exchange as string,
      timeframe: item.timeframe as IndicatorState["timeframe"],
      asOf: item.asOfMs as number,
      barsSinceStart: item.barsSinceStart as number,
      rsi14: (item.rsi14 as number | null) ?? null,
      ema20: (item.ema20 as number | null) ?? null,
      ema50: (item.ema50 as number | null) ?? null,
      ema200: (item.ema200 as number | null) ?? null,
      macdLine: (item.macdLine as number | null) ?? null,
      macdSignal: (item.macdSignal as number | null) ?? null,
      macdHist: (item.macdHist as number | null) ?? null,
      atr14: (item.atr14 as number | null) ?? null,
      bbUpper: (item.bbUpper as number | null) ?? null,
      bbMid: (item.bbMid as number | null) ?? null,
      bbLower: (item.bbLower as number | null) ?? null,
      bbWidth: (item.bbWidth as number | null) ?? null,
      obv: (item.obv as number | null) ?? null,
      obvSlope: (item.obvSlope as number | null) ?? null,
      vwap: (item.vwap as number | null) ?? null,
      volZ: (item.volZ as number | null) ?? null,
      realizedVolAnnualized: (item.realizedVolAnnualized as number | null) ?? null,
      fearGreed: (item.fearGreed as number | null) ?? null,
      dispersion: (item.dispersion as number | null) ?? null,
      history: item.history as IndicatorState["history"],
    };
  } catch (err) {
    console.error(`[admin.service] getIndicatorState failed for ${pair}/${exchange}:`, err);
    return null;
  }
}

function computeDispersion(prices: Array<Record<string, unknown>>, pair: string): number | null {
  // De-dupe by exchange: keep only the latest (first-seen) tick per exchange.
  // getLatestPrices returns newest-first within each pair partition (ScanIndexForward: false),
  // so the first entry per exchange in iteration order is the latest tick.
  const latestByExchange = new Map<string, number>();
  for (const p of prices) {
    if (p.pair !== pair || p.stale === true) continue;
    const ex = p.exchange as string | undefined;
    const price = p.price as number | undefined;
    if (!ex || typeof price !== "number" || !isFinite(price)) continue;
    if (!latestByExchange.has(ex)) latestByExchange.set(ex, price);
  }
  // Require at least 2 distinct exchanges for a meaningful cross-exchange spread.
  if (latestByExchange.size < 2) return null;
  const values = Array.from(latestByExchange.values());
  const max = Math.max(...values);
  const min = Math.min(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  if (avg === 0) return null;
  return (max - min) / avg;
}

async function getRecentCandles(pair: string, exchange: string, timeframe: string, limit = 60) {
  try {
    const prefix = `${exchange}#${timeframe}#`;
    const result = await dynamo.send(
      new QueryCommand({
        TableName: `${PREFIX}-candles`,
        KeyConditionExpression: "#pair = :pair AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
        ExpressionAttributeValues: { ":pair": pair, ":prefix": prefix },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return ((result.Items ?? []) as Record<string, unknown>[]).reverse();
  } catch (err) {
    console.error(
      `[admin.service] getRecentCandles failed for ${pair}/${exchange}/${timeframe}:`,
      err,
    );
    return [];
  }
}

export async function getMarket(pair: string, exchange: string) {
  const [prices, candles, fearGreed, indicators] = await Promise.all([
    getLatestPrices(),
    getRecentCandles(pair, exchange, "1m", 60),
    getFearGreed(),
    getIndicatorState(pair, exchange, "1m"),
  ]);
  const dispersion = computeDispersion(prices, pair);
  return { prices, candles, fearGreed, indicators, dispersion, pair, exchange };
}

export async function getSignals(
  pair: string,
  since: Date,
  limit: number,
): Promise<Array<BlendedSignal & { signalId: string; emittedAt: string }>> {
  try {
    // v6 signals-v2 schema: SK = `tf#closeTime` (epoch ms as string).
    // For "since this time" across all blended TFs, query each TF separately
    // with begins_with(sk, "tf#") and a closeTime lower bound, then merge.
    const sinceMs = since.getTime();
    const blendTfs = ["15m", "1h", "4h", "1d"] as const;

    const perTf = await Promise.all(
      blendTfs.map(async (tf) => {
        const tfPrefix = `${tf}#`;
        // Lower bound is `${tf}#${sinceMs}` so begins_with constrains TF and
        // SK ≥ ensures closeTime ≥ sinceMs (same lexical/numeric order since
        // closeTime is fixed-width epoch ms within a TF prefix).
        const result = await dynamo.send(
          new QueryCommand({
            TableName: SIGNALS_V2_TABLE,
            KeyConditionExpression: "#pair = :pair AND #sk BETWEEN :lo AND :hi",
            ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
            ExpressionAttributeValues: {
              ":pair": pair,
              ":lo": `${tfPrefix}${sinceMs}`,
              // upper bound is just past the prefix range — any closeTime
              ":hi": `${tfPrefix}￿`,
            },
            ScanIndexForward: false,
            Limit: limit,
          }),
        );
        return result.Items ?? [];
      }),
    );

    // Merge per-TF results, sort by emittedAt (or asOf as fallback) descending, slice to limit.
    const merged = perTf.flat();
    merged.sort((a, b) => {
      const aT = (a.emittedAt as string) ?? new Date(Number(a.asOf ?? 0)).toISOString();
      const bT = (b.emittedAt as string) ?? new Date(Number(b.asOf ?? 0)).toISOString();
      return bT.localeCompare(aT);
    });

    return merged.slice(0, limit).map((item) => ({
      pair: item.pair as string,
      type: item.type as BlendedSignal["type"],
      confidence: item.confidence as number,
      volatilityFlag: item.volatilityFlag as boolean,
      gateReason: item.gateReason as BlendedSignal["gateReason"],
      rulesFired: item.rulesFired as string[],
      risk: (item.risk as BlendedSignal["risk"]) ?? null,
      perTimeframe: item.perTimeframe as BlendedSignal["perTimeframe"],
      weightsUsed: item.weightsUsed as BlendedSignal["weightsUsed"],
      asOf: item.asOf as number,
      emittingTimeframe: item.emittingTimeframe as BlendedSignal["emittingTimeframe"],
      signalId: item.signalId as string,
      emittedAt: item.emittedAt as string,
    }));
  } catch (err) {
    console.error(`[admin.service] getSignals failed for ${pair}:`, err);
    return [];
  }
}

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

export interface NewsUsage {
  articlesEnriched: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  byModel: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; costUsd: number }
  >;
}

/**
 * Fetch the most-recent `limit` news articles using a day-by-day GSI Query.
 *
 * Walks backward from `startDay` (or today) querying the `published-day-index`
 * GSI with `ScanIndexForward: false` so results are newest-first within each
 * day. Continues to the previous day when a day has fewer rows than needed.
 * Stops at `NEWS_LOOKBACK_DAYS` days total.
 *
 * The returned `nextCursor` is an opaque base64url token that encodes the
 * resume position (day + DynamoDB LastEvaluatedKey). Pass it as the `cursor`
 * query param on the next request to load the next page. `nextCursor` is
 * suppressed when the resume position would already be outside the lookback
 * window — emitting it would just produce an empty next page.
 *
 * NOTE: Requires the `published-day-index` GSI to be deployed and `ACTIVE`
 * (added in #203). The ingestion write path populates `publishedDay` on every
 * new record (#202). Pre-existing rows must be backfilled with
 * `ingestion/scripts/backfill-published-day.ts` before they appear in
 * paginated results.
 */
export async function getNews(
  limit = 50,
  cursorToken?: string,
): Promise<{
  news: Record<string, unknown>[];
  fearGreed: { value: number; classification: string } | null;
  nextCursor: string | null;
}> {
  // Kick off the fear-greed fetch up front so it overlaps with the day-by-day
  // Query loop instead of adding sequential latency. We `await` it just before
  // returning. Errors are absorbed by `getFearGreed()` itself (returns null).
  const fearGreedPromise = getFearGreed();

  try {
    const cursor: NewsCursor = cursorToken
      ? (decodeNewsCursor(cursorToken) ?? { day: todayUtc() })
      : { day: todayUtc() };

    const collected: Record<string, unknown>[] = [];
    let currentDay = cursor.day;
    let resumeKey: Record<string, unknown> | undefined = cursor.lastEvaluatedKey;

    // Bound the walk by calendar distance from today, not by iteration count,
    // so a stale/forged cursor with an old `day` doesn't escape the lookback
    // window. Initialize from the cursor's day so a day-by-day Query loop
    // for a cursor older than NEWS_LOOKBACK_DAYS short-circuits before
    // issuing any reads.
    const startDayMs = dayToMs(todayUtc());
    let daysWalked = Math.max(0, Math.round((startDayMs - dayToMs(currentDay)) / 86400000));

    while (collected.length < limit && daysWalked < NEWS_LOOKBACK_DAYS) {
      const needed = limit - collected.length;

      const result = await dynamo.send(
        new QueryCommand({
          TableName: NEWS_TABLE,
          IndexName: NEWS_DAY_INDEX,
          KeyConditionExpression: "#day = :day",
          ExpressionAttributeNames: { "#day": "publishedDay" },
          ExpressionAttributeValues: { ":day": currentDay },
          ScanIndexForward: false,
          Limit: needed,
          ...(resumeKey ? { ExclusiveStartKey: resumeKey } : {}),
        }),
      );

      const items = (result.Items ?? []) as Record<string, unknown>[];
      collected.push(...items);

      if (result.LastEvaluatedKey) {
        // DynamoDB Query can return fewer than `Limit` items even when more
        // matching rows exist for the partition (1 MB response cap). When
        // that happens with the page still unfilled, we MUST keep querying
        // the same day with `ExclusiveStartKey` instead of moving on, or
        // the caller will silently get a short page even though more rows
        // are available right there. Only break out when the page is full —
        // the cursor then resumes from this position next page.
        resumeKey = result.LastEvaluatedKey as Record<string, unknown>;
        if (collected.length >= limit) break;
        continue;
      }

      // No LastEvaluatedKey → day exhausted. Advance to the previous day.
      resumeKey = undefined;
      currentDay = prevDay(currentDay);
      daysWalked = Math.round((startDayMs - dayToMs(currentDay)) / 86400000);
    }

    // Build nextCursor: if we stopped mid-page (have a resumeKey) or still
    // have more days to walk and could yield more rows, emit a cursor.
    //
    // When the page filled exactly on day-exhaustion, `currentDay` was already
    // advanced to the previous calendar day at the bottom of the loop body.
    // The next page should resume from that already-advanced day — applying
    // `prevDay()` again here would skip a calendar day per page.
    //
    // Suppress the cursor when the resume day is already past
    // `NEWS_LOOKBACK_DAYS` (would only happen at the lookback boundary and a
    // resume-key still mid-day on that boundary). Emitting it would return a
    // cursor whose next call would short-circuit on day 1 of the loop and
    // return an empty page — confusing for clients/UI.
    let nextCursor: string | null = null;
    if (collected.length >= limit) {
      const resumeDay = currentDay;
      const resumeDaysFromToday = Math.round((startDayMs - dayToMs(resumeDay)) / 86400000);
      if (resumeDaysFromToday < NEWS_LOOKBACK_DAYS) {
        const nextCursorObj: NewsCursor = resumeKey
          ? { day: resumeDay, lastEvaluatedKey: resumeKey }
          : { day: resumeDay };
        nextCursor = encodeNewsCursor(nextCursorObj);
      }
    }

    const fearGreed = await fearGreedPromise;
    return { news: collected, fearGreed, nextCursor };
  } catch (err) {
    console.error("[admin.service] getNews failed:", err);
    // Make sure the prefetched fearGreed promise doesn't reject unhandled.
    void fearGreedPromise.catch(() => {});
    return { news: [], fearGreed: null, nextCursor: null };
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function prevDay(day: string): string {
  const ms = dayToMs(day) - 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function dayToMs(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getTime();
}

/**
 * Aggregate LLM token usage from ingestion-metadata keys of the form
 * `llm_usage#YYYY-MM-DD` written by `recordLlmUsage` on each Bedrock invocation.
 *
 * Storage is **day-bucketed**, so the `since` parameter is truncated to a
 * date and the window is inclusive of every day from `since-day` through
 * today. A request for "last 24h" near midnight UTC therefore returns up
 * to ~48h of data — this is fundamental to day-bucket storage and the UI
 * label should reflect it ("Today + last N days" rather than a strict
 * 24h window). Sub-day bucketing would shrink this to one-hour granularity
 * but trades 24× more DDB writes per active day; not worth it for the
 * dashboard's accuracy needs.
 *
 * Counters are read directly:
 *   - `calls` = total InvokeModel invocations (1 per call)
 *   - `articlesEnriched` = total fully-enriched articles (1 per article,
 *     incremented only on the call that completes the article — see
 *     `recordLlmUsage(countAsArticle)` for the contract)
 */
/** Build the deterministic list of `llm_usage#YYYY-MM-DD` keys from `since` (truncated to date) through today. */
function dailyUsageKeys(since: Date): string[] {
  const startMs = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
  const todayMs = (() => {
    const t = new Date();
    return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  })();
  const keys: string[] = [];
  for (let ms = startMs; ms <= todayMs; ms += 24 * 60 * 60 * 1000) {
    keys.push(`llm_usage#${new Date(ms).toISOString().slice(0, 10)}`);
  }
  return keys;
}

export async function getNewsUsage(since: Date): Promise<NewsUsage> {
  try {
    // Generate the deterministic list of day-keys from `since` to today and
    // BatchGet them. Previously we Scanned the whole metadata table on every
    // 60-second poll, which scales linearly with unrelated keys (cooldowns,
    // close-quorum markers, fear-greed cache, etc.). Day-keys are deterministic
    // — no reason to scan.
    //
    // BatchGet has a 100-key cap per request; a single request covers ~3 months
    // of usage history, which is far beyond any reasonable dashboard window.
    // For a hypothetical >100-day request the loop below chunks accordingly.
    const wantedKeys = dailyUsageKeys(since);
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < wantedKeys.length; i += 100) {
      const chunk = wantedKeys.slice(i, i + 100);
      const result = await dynamo.send(
        new BatchGetCommand({
          RequestItems: {
            [METADATA_TABLE]: {
              Keys: chunk.map((metaKey) => ({ metaKey })),
            },
          },
        }),
      );
      const responseItems = (result.Responses?.[METADATA_TABLE] ?? []) as Record<string, unknown>[];
      items.push(...responseItems);
    }

    let articlesEnriched = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const byModel: NewsUsage["byModel"] = {};

    for (const item of items) {
      const inputTok = (item.totalInputTokens as number) ?? 0;
      const outputTok = (item.totalOutputTokens as number) ?? 0;
      const articles = (item.articlesEnriched as number) ?? 0;
      // Fall back to articles for legacy day-buckets written before the
      // separate `calls` counter shipped — never under-report total calls.
      const calls = (item.calls as number) ?? articles;
      const model: string = (item.modelTag as string) ?? "anthropic.claude-haiku-4-5";

      articlesEnriched += articles;
      totalInputTokens += inputTok;
      totalOutputTokens += outputTok;

      if (!byModel[model]) {
        byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      }
      byModel[model].calls += calls;
      byModel[model].inputTokens += inputTok;
      byModel[model].outputTokens += outputTok;
    }

    // Compute cost for each model bucket
    for (const m of Object.values(byModel)) {
      m.costUsd =
        (m.inputTokens / 1_000_000) * HAIKU_INPUT_PRICE_PER_M +
        (m.outputTokens / 1_000_000) * HAIKU_OUTPUT_PRICE_PER_M;
    }

    const estimatedCostUsd =
      (totalInputTokens / 1_000_000) * HAIKU_INPUT_PRICE_PER_M +
      (totalOutputTokens / 1_000_000) * HAIKU_OUTPUT_PRICE_PER_M;

    return { articlesEnriched, totalInputTokens, totalOutputTokens, estimatedCostUsd, byModel };
  } catch (err) {
    console.error("[admin.service] getNewsUsage failed:", err);
    return {
      articlesEnriched: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      byModel: {},
    };
  }
}

const WHITELIST_PARAM = `/quantara/${ENVIRONMENT}/docs-allowed-ips`;

export async function getWhitelist(): Promise<{ ips: string[] }> {
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: WHITELIST_PARAM, WithDecryption: false }),
    );
    const raw = result.Parameter?.Value ?? "";
    const ips = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { ips };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "ParameterNotFound") return { ips: [] };
    throw err;
  }
}

export async function setWhitelist(ips: string[]): Promise<{ ips: string[] }> {
  const value = ips.join(",");
  await ssm.send(
    new PutParameterCommand({
      Name: WHITELIST_PARAM,
      Value: value,
      Type: "String",
      Overwrite: true,
    }),
  );
  return { ips };
}
