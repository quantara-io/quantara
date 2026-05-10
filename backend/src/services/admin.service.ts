import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  QueryCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BlendedSignal, IndicatorState, PipelineEvent } from "@quantara/shared";
import { HAIKU_INPUT_PRICE_PER_M, HAIKU_OUTPUT_PRICE_PER_M, PAIRS } from "@quantara/shared";
import { ECSClient, DescribeServicesCommand, ListTasksCommand } from "@aws-sdk/client-ecs";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  DescribeLogStreamsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  QueryStatus,
} from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";

const REGION = process.env.AWS_REGION ?? "us-west-2";
const PREFIX = (process.env.TABLE_PREFIX ?? "quantara-dev-").replace(/-$/, "");
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? "";
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

const SIGNALS_COLLECTION_TABLE =
  process.env.TABLE_SIGNALS_COLLECTION ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-collection`;
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
const cloudwatch = new CloudWatchClient({ region: REGION });

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

async function getRecentCandles(
  pair: string,
  exchange: string,
  timeframe: string,
  limit = 60,
  beforeMs?: number,
) {
  try {
    const prefix = `${exchange}#${timeframe}#`;
    // When `beforeMs` is provided, use a range comparison so DynamoDB returns
    // only candles whose SK is lex-before the cursor. DynamoDB does not support
    // combining begins_with() with < in the same KeyConditionExpression, so we
    // switch to an explicit range:
    //   sk >= "${prefix}"   (prefix itself is less than any candle SK because
    //                        the next char is always an ISO digit '0'–'9')
    //   sk < "${beforeSk}"  (strict upper bound = the cursor's ISO timestamp)
    //
    // Without `beforeMs`, falls back to the original begins_with pattern.
    const keyCondition = beforeMs
      ? "#pair = :pair AND #sk BETWEEN :prefixMin AND :beforeSk"
      : "#pair = :pair AND begins_with(#sk, :prefix)";

    // BETWEEN is inclusive on both ends. To simulate strict "<" on :beforeSk we
    // subtract one millisecond: ISO timestamps have ms precision, so
    // new Date(beforeMs - 1).toISOString() is strictly less than the cursor SK.
    const expressionValues: Record<string, string> = beforeMs
      ? {
          ":pair": pair,
          ":prefixMin": prefix,
          ":beforeSk": `${exchange}#${timeframe}#${new Date(beforeMs - 1).toISOString()}`,
        }
      : {
          ":pair": pair,
          ":prefix": prefix,
        };

    const result = await dynamo.send(
      new QueryCommand({
        TableName: `${PREFIX}-candles`,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
        ExpressionAttributeValues: expressionValues,
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

export async function getMarket(
  pair: string,
  exchange: string,
  timeframe: string = "1m",
  limit: number = 60,
  beforeMs?: number,
) {
  const [prices, candles, fearGreed, indicators] = await Promise.all([
    getLatestPrices(),
    getRecentCandles(pair, exchange, timeframe, limit, beforeMs),
    getFearGreed(),
    getIndicatorState(pair, exchange, timeframe),
  ]);
  const dispersion = computeDispersion(prices, pair);
  return { prices, candles, fearGreed, indicators, dispersion, pair, exchange, timeframe };
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

// ---------------------------------------------------------------------------
// Ratifications + Genie Performance Metrics
// ---------------------------------------------------------------------------

const RATIFICATIONS_TABLE =
  process.env.TABLE_RATIFICATIONS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratifications`;

const SIGNAL_OUTCOMES_TABLE =
  process.env.TABLE_SIGNAL_OUTCOMES ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signal-outcomes`;

// Reuse the file-level PAIRS constant for the genie-metrics fan-out so the
// pair list is sourced from one place. (Was a duplicate ALL_PAIRS array
// before — drift hazard whenever pairs are added or removed.)
export const SUPPORTED_PAIRS = PAIRS;

// Sonnet 4.6 pricing ($3/1M input, $15/1M output) — NOT the same as Haiku.
// Ratification records store costUsd directly so this is only a fallback reference.

export interface GenieMetrics {
  windowStart: string;
  windowEnd: string;
  total: {
    signalCount: number;
    ratifiedCount: number;
    downgradedCount: number;
    gatedCount: number;
    fallbackCount: number;
  };
  // Outcome counts using domain-standard names (tp = take-profit hit,
  // sl = stop-loss hit) from the issue spec. The persisted resolver enum
  // is `OutcomeRecord.outcome ∈ "correct" | "incorrect" | "neutral"`; we
  // map correct → tp, incorrect → sl at the API boundary. "pending" is
  // synthesized for signals whose corresponding outcome row hasn't been
  // resolved yet.
  outcomes: {
    tp: number;
    sl: number;
    neutral: number;
    pending: number;
  };
  winRate: {
    overall: number | null;
    algoOnly: number | null;
    llmRatified: number | null;
    llmDowngraded: number | null;
  };
  cost: {
    totalUsd: number;
    avgPerSignalUsd: number;
    avgPerTpUsd: number | null;
    cacheHitRate: number | null;
  };
  gating: {
    skipLowConfidence: number;
    skipRateLimit: number;
    skipDailyCap: number;
    skipNotRequired: number;
    invoked: number;
  };
}

// Internal row shape for genie-metrics aggregation. Distinct from the
// exported `RatificationRow` (declared further down in the file) which is
// the API response shape for the ratification audit listing — different
// projection, different consumer.
interface RatificationMetricRow {
  pair: string;
  invokedAtRecordId: string;
  invokedAt: string;
  invokedReason: string;
  // The (15m / 1h / 4h / 1d) the bar that triggered this ratification was
  // emitted on. Persisted by `ingestion/src/lib/ratification-store.ts` and
  // used here to scope cost/gating metrics to a requested timeframe.
  timeframe: string | null;
  fellBackToAlgo: boolean;
  cacheHit: boolean;
  costUsd: number;
  ratified: { type?: string; confidence?: number } | null;
  algoCandidate: { type?: string };
}

interface OutcomeRow {
  pair: string;
  signalId: string;
  // Production resolver writes "correct" | "incorrect" | "neutral" — see
  // ingestion/src/outcomes/resolver.ts (`OutcomeValue`).
  outcome: "correct" | "incorrect" | "neutral";
  gateReason: string | null;
  emittingTimeframe: string;
  resolvedAt: string;
  createdAt: string;
}

/** Subset of a signals-v2 row needed to partition outcomes by ratification pathway. */
interface SignalRow {
  pair: string;
  signalId: string;
  // Mirrors `BlendedSignal.ratificationStatus`. Production-emitted rows
  // carry one of these five states; `null` means the row predates Phase B1.
  ratificationStatus: "pending" | "ratified" | "downgraded" | "not-required" | null;
  emittingTimeframe: string;
  closeTime: number;
}

/**
 * Query all ratification records for a set of pairs over a time window.
 * Ratifications table PK=pair, SK=invokedAtRecordId (starts with invokedAt ISO).
 */
async function queryRatificationsForWindow(
  pairs: readonly string[],
  sinceIso: string,
  untilIso: string,
): Promise<RatificationMetricRow[]> {
  const rows: RatificationMetricRow[] = [];

  await Promise.all(
    pairs.map(async (pair) => {
      let lastKey: Record<string, unknown> | undefined;
      do {
        const result = await dynamo.send(
          new QueryCommand({
            TableName: RATIFICATIONS_TABLE,
            KeyConditionExpression: "#pair = :pair AND invokedAtRecordId BETWEEN :lo AND :hi",
            ExpressionAttributeNames: { "#pair": "pair" },
            ExpressionAttributeValues: {
              ":pair": pair,
              ":lo": sinceIso,
              ":hi": untilIso + "￿", // lexicographic upper bound
            },
            ExclusiveStartKey: lastKey,
          }),
        );
        for (const item of result.Items ?? []) {
          rows.push(item as RatificationMetricRow);
        }
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey !== undefined);
    }),
  );

  return rows;
}

/**
 * Query signals-v2 for a set of pairs over a time window across blended TFs.
 * signals-v2 PK=pair, SK=`tf#closeTimeMs`. closeTime is fixed-width epoch ms
 * within a TF prefix so SK BETWEEN comparisons are correct ordered ranges.
 *
 * When `timeframe` is provided, only that TF's partition is queried (saves
 * 3 of 4 DDB queries per pair). Otherwise all four blended TFs are queried.
 *
 * Used as the source-of-truth for `signalCount` and ratification-status
 * partitioning. The ratifications table is NOT a 1:1 with signals — every
 * `skip-no-trigger` bar evaluation creates a ratification row even when no
 * signal was emitted, so counting ratifications inflates `signalCount`.
 */
async function querySignalsForWindow(
  pairs: readonly string[],
  sinceIso: string,
  untilIso: string,
  timeframe?: string,
): Promise<SignalRow[]> {
  const sinceMs = new Date(sinceIso).getTime();
  const untilMs = new Date(untilIso).getTime();
  const blendTfs = timeframe ? [timeframe] : (["15m", "1h", "4h", "1d"] as const);
  const rows: SignalRow[] = [];

  await Promise.all(
    pairs.flatMap((pair) =>
      blendTfs.map(async (tf) => {
        let lastKey: Record<string, unknown> | undefined;
        do {
          const result = await dynamo.send(
            new QueryCommand({
              TableName: SIGNALS_V2_TABLE,
              KeyConditionExpression: "#pair = :pair AND #sk BETWEEN :lo AND :hi",
              ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
              ExpressionAttributeValues: {
                ":pair": pair,
                ":lo": `${tf}#${sinceMs}`,
                ":hi": `${tf}#${untilMs}`,
              },
              ExclusiveStartKey: lastKey,
            }),
          );
          for (const item of result.Items ?? []) {
            rows.push({
              pair: item.pair as string,
              signalId: (item.signalId as string) ?? "",
              ratificationStatus:
                (item.ratificationStatus as SignalRow["ratificationStatus"]) ?? null,
              emittingTimeframe: tf as string,
              closeTime: typeof item.closeTime === "number" ? item.closeTime : 0,
            });
          }
          lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
        } while (lastKey !== undefined);
      }),
    ),
  );

  return rows;
}

/**
 * Query signal-outcome records for a set of pairs where the originating
 * signal's emit time (`createdAt`) falls in `[sinceIso, untilIso]`. We
 * filter on emit time (not `resolvedAt`) so the outcomes window aligns
 * with `signals_v2.closeTime` — otherwise pre-window signals that resolve
 * during the window distort the per-signal win-rate.
 *
 * signal-outcomes table PK=pair, SK=signalId; the time range is enforced
 * via FilterExpression on `createdAt` (DynamoDB scans the partition before
 * filtering). Acceptable today (small partitions per pair); if cost
 * becomes an issue, add a GSI keyed on createdAt.
 */
async function queryOutcomesForWindow(
  pairs: readonly string[],
  sinceIso: string,
  untilIso: string,
): Promise<OutcomeRow[]> {
  const rows: OutcomeRow[] = [];

  await Promise.all(
    pairs.map(async (pair) => {
      let lastKey: Record<string, unknown> | undefined;
      do {
        const result = await dynamo.send(
          new QueryCommand({
            TableName: SIGNAL_OUTCOMES_TABLE,
            KeyConditionExpression: "#pair = :pair",
            FilterExpression: "#createdAt BETWEEN :since AND :until",
            ExpressionAttributeNames: { "#pair": "pair", "#createdAt": "createdAt" },
            ExpressionAttributeValues: {
              ":pair": pair,
              ":since": sinceIso,
              ":until": untilIso,
            },
            ExclusiveStartKey: lastKey,
          }),
        );
        for (const item of result.Items ?? []) {
          rows.push(item as OutcomeRow);
        }
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey !== undefined);
    }),
  );

  return rows;
}

/**
 * Compute the Genie performance metrics for a given time window.
 *
 * @param since      ISO-8601 lower bound (default: 7 days ago). Caller is
 *                   responsible for canonicalising format — admin.ts does
 *                   `new Date(sinceRaw).toISOString()` before passing here
 *                   so DDB string range comparisons are consistent.
 * @param pair       Optional pair filter (default: all monitored pairs)
 * @param timeframe  Optional timeframe filter applied to ALL three sources:
 *                   signals_v2 (Query is scoped to that tf's sk prefix),
 *                   ratifications (filtered post-Query on row.timeframe),
 *                   signal-outcomes (filtered post-Query on emittingTimeframe).
 *                   With a filter active, every metric in the response
 *                   describes the same (pair × tf) slice of the data.
 */
export async function getGenieMetrics(
  since?: string,
  pair?: string,
  timeframe?: string,
): Promise<GenieMetrics> {
  const windowEnd = new Date().toISOString();
  const windowStart = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const pairs = pair ? [pair] : SUPPORTED_PAIRS;

  // signals_v2 is the source of truth for `signalCount` and ratification-
  // pathway partitioning. ratifications is the source for cost + gating
  // breakdown. signal-outcomes is the source for win-rate.
  // Pass `timeframe` through to querySignalsForWindow so we only Query the
  // requested tf's sk prefix instead of all four.
  const [signalRows, ratRows, outcomeRows] = await Promise.all([
    querySignalsForWindow(pairs, windowStart, windowEnd, timeframe),
    queryRatificationsForWindow(pairs, windowStart, windowEnd),
    queryOutcomesForWindow(pairs, windowStart, windowEnd),
  ]);

  // Apply timeframe filter consistently across all three sources so every
  // metric in the response describes the same slice of the data.
  // - signalRows: already scoped via querySignalsForWindow's sk prefix
  // - ratRows: filtered post-Query on the persisted `timeframe` field
  // - outcomeRows: filtered post-Query on `emittingTimeframe`
  // Without filtering ratRows, cost.* and gating.* would reflect ALL TFs
  // while signalCount/win-rate reflect only the requested TF — inconsistent.
  const filteredSignals = signalRows;
  const filteredRats = timeframe ? ratRows.filter((r) => r.timeframe === timeframe) : ratRows;
  // Restrict outcomes to those whose signalId is in filteredSignals — this
  // aligns the outcomes window with the signals window (was filtering on
  // resolvedAt, which let pre-window signals resolved during the window
  // skew win-rate vs signalCount). Restored timeframe filter as a belt-
  // and-suspenders check in case of unexpected outcome rows.
  const signalIdSet = new Set(filteredSignals.map((s) => s.signalId).filter(Boolean));
  const filteredOutcomes = outcomeRows.filter(
    (o) => signalIdSet.has(o.signalId) && (timeframe ? o.emittingTimeframe === timeframe : true),
  );

  // Map signalId → ratificationStatus for joining outcomes to their pathway.
  const statusBySignalId = new Map<string, SignalRow["ratificationStatus"]>();
  for (const s of filteredSignals) {
    if (s.signalId) statusBySignalId.set(s.signalId, s.ratificationStatus);
  }

  // ------------------------------------------------------------------
  // Gating breakdown + cost (from ratification rows)
  // ------------------------------------------------------------------
  let skipLowConfidence = 0;
  let skipRateLimit = 0;
  let skipDailyCap = 0;
  let skipNotRequired = 0;
  let invoked = 0;
  let totalCacheHits = 0;
  let totalLlmInvocations = 0;
  let totalCostUsd = 0;

  for (const r of filteredRats) {
    const reason = r.invokedReason ?? "";
    if (reason === "skip-low-confidence") skipLowConfidence++;
    else if (reason === "skip-rate-limited") skipRateLimit++;
    else if (reason === "skip-daily-cap") skipDailyCap++;
    else if (reason === "skip-no-trigger") skipNotRequired++;
    else {
      // LLM was actually invoked (news, vol, fng-shift, all, sentiment_shock)
      invoked++;
      totalLlmInvocations++;
      if (r.cacheHit) totalCacheHits++;
    }
    totalCostUsd += typeof r.costUsd === "number" ? r.costUsd : 0;
  }

  // ------------------------------------------------------------------
  // Signal totals and ratification-pathway buckets (from signals_v2)
  // ------------------------------------------------------------------
  // signalCount comes from signals_v2 — it's the count of *emitted* signals.
  // Ratifications has many extra rows for `skip-no-trigger` bar evaluations
  // that never produced a signal; using ratRows.length as signalCount would
  // distort avgPerSignalUsd and gatedCount.
  const signalCount = filteredSignals.length;
  let ratifiedCount = 0; // ratificationStatus "ratified"
  let downgradedCount = 0; // ratificationStatus "downgraded"
  // algoOnly + pending are derivable as (signalCount - ratified - downgraded
  // - pending-from-status); not exposed on the response shape directly, but
  // implied by signalCount minus the partitions.

  for (const s of filteredSignals) {
    const status = s.ratificationStatus;
    if (status === "ratified") ratifiedCount++;
    else if (status === "downgraded") downgradedCount++;
    // null / "not-required" / "pending" aren't ratified; they fall into
    // the algoOnly + pending buckets surfaced via win-rate partitioning.
  }

  // gatedCount = the gating side of ratification activity (skip rows). It's
  // a separate axis from signal count: many skip rows produce no signal.
  const gatedCount = skipLowConfidence + skipRateLimit + skipDailyCap + skipNotRequired;
  // fallbackCount is "LLM was invoked but failed validation, fell back to
  // the algo verdict". Comes from ratifications, scoped to filteredRats so
  // it stays consistent with the timeframe filter.
  let fallbackCount = 0;
  for (const r of filteredRats) {
    if (r.fellBackToAlgo) fallbackCount++;
  }

  // ------------------------------------------------------------------
  // Outcome counts — production resolver writes correct/incorrect/neutral;
  // we map to the issue-spec names (tp = take-profit hit, sl = stop-loss
  // hit) at the API boundary so frontend consumers match the spec.
  // ------------------------------------------------------------------
  let tp = 0;
  let sl = 0;
  let neutral = 0;
  // "pending" is computed from signals that don't yet have an outcome row.
  const resolvedSignalIds = new Set<string>();
  for (const o of filteredOutcomes) resolvedSignalIds.add(o.signalId);
  let pendingOutcomes = 0;
  for (const s of filteredSignals) {
    if (!resolvedSignalIds.has(s.signalId)) pendingOutcomes++;
  }

  for (const o of filteredOutcomes) {
    if (o.outcome === "correct") tp++;
    else if (o.outcome === "incorrect") sl++;
    else if (o.outcome === "neutral") neutral++;
  }

  // ------------------------------------------------------------------
  // Win-rate breakdown — partition outcomes by ratificationStatus on their signal
  // ------------------------------------------------------------------
  // algoOnly:      signal had ratificationStatus null or "not-required"
  // llmRatified:   signal had ratificationStatus "ratified"
  // llmDowngraded: signal had ratificationStatus "downgraded"
  // Three buckets are mutually exclusive and (with pending outcomes) sum to
  // signalCount. "pending" outcomes are excluded from win-rate (no result yet).
  const countWins = (outcomes: OutcomeRow[]): number | null => {
    const directional = outcomes.filter(
      (o) => o.outcome === "correct" || o.outcome === "incorrect",
    );
    if (directional.length === 0) return null;
    const wins = directional.filter((o) => o.outcome === "correct").length;
    return wins / directional.length;
  };

  const partitionByStatus = (target: SignalRow["ratificationStatus"][] | "algoOnly") =>
    filteredOutcomes.filter((o) => {
      const status = statusBySignalId.get(o.signalId) ?? null;
      if (target === "algoOnly") return status === null || status === "not-required";
      return target.includes(status);
    });

  const overallWinRate = countWins(filteredOutcomes);
  const algoOnlyWinRate = countWins(partitionByStatus("algoOnly"));
  const llmRatifiedWinRate = countWins(partitionByStatus(["ratified"]));
  const llmDowngradedWinRate = countWins(partitionByStatus(["downgraded"]));

  // ------------------------------------------------------------------
  // Cost metrics
  // ------------------------------------------------------------------
  const avgPerSignalUsd = signalCount > 0 ? totalCostUsd / signalCount : 0;
  const avgPerTpUsd = tp > 0 ? totalCostUsd / tp : null;
  const cacheHitRate = totalLlmInvocations > 0 ? totalCacheHits / totalLlmInvocations : null;

  return {
    windowStart,
    windowEnd,
    total: {
      signalCount,
      // Sum of these four equals signalCount (all signals partitioned by status).
      ratifiedCount,
      downgradedCount,
      // gatedCount tracks ratification skip rows (separate axis from signal count).
      gatedCount,
      fallbackCount,
    },
    outcomes: { tp, sl, neutral, pending: pendingOutcomes },
    winRate: {
      overall: overallWinRate,
      algoOnly: algoOnlyWinRate,
      llmRatified: llmRatifiedWinRate,
      llmDowngraded: llmDowngradedWinRate,
    },
    cost: { totalUsd: totalCostUsd, avgPerSignalUsd, avgPerTpUsd, cacheHitRate },
    gating: { skipLowConfidence, skipRateLimit, skipDailyCap, skipNotRequired, invoked },
  };
}

// ---------------------------------------------------------------------------
// Ratification audit listing
// ---------------------------------------------------------------------------

export interface RatificationRow {
  recordId: string;
  pair: string;
  timeframe: string;
  invokedReason: string;
  triggerReason: string | null;
  invokedAt: string;
  latencyMs: number;
  costUsd: number;
  cacheHit: boolean;
  validationOk: boolean;
  fellBackToAlgo: boolean;
  algoCandidateType: string | null;
  algoCandidateConfidence: number | null;
  ratifiedType: string | null;
  ratifiedConfidence: number | null;
  ratifiedReasoning: string | null;
  llmModel: string | null;
  // full payload for detail modal
  algoCandidate: Record<string, unknown> | null;
  ratified: Record<string, unknown> | null;
  llmRequest: Record<string, unknown> | null;
  llmRawResponse: Record<string, unknown> | null;
}

export interface GetRatificationsParams {
  pair?: string;
  timeframe?: string;
  triggerReason?: string;
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
}

export interface RatificationsPage {
  items: RatificationRow[];
  cursor: string | null;
}

/** Map a raw DDB item to the API shape. */
function toRatificationRow(item: Record<string, unknown>): RatificationRow {
  const algo = (item.algoCandidate as Record<string, unknown> | null) ?? null;
  const ratified = (item.ratified as Record<string, unknown> | null) ?? null;
  const validation = (item.validation as { ok?: boolean } | null) ?? null;
  const llmReq = (item.llmRequest as Record<string, unknown> | null) ?? null;
  const rawReasoning = (ratified?.reasoning as string | undefined) ?? null;
  return {
    recordId: item.recordId as string,
    pair: item.pair as string,
    timeframe: item.timeframe as string,
    invokedReason: item.invokedReason as string,
    // triggerReason is the surface that distinguishes bar_close / sentiment_shock /
    // manual paths. Older records (pre-#181) may not have it; treat absent as
    // bar_close per ratification-store.ts convention.
    triggerReason:
      typeof item.triggerReason === "string" && item.triggerReason.length > 0
        ? (item.triggerReason as string)
        : "bar_close",
    invokedAt: item.invokedAt as string,
    latencyMs: (item.latencyMs as number) ?? 0,
    costUsd: (item.costUsd as number) ?? 0,
    cacheHit: Boolean(item.cacheHit),
    validationOk: Boolean(validation?.ok),
    fellBackToAlgo: Boolean(item.fellBackToAlgo),
    algoCandidateType: (algo?.type as string | null) ?? null,
    algoCandidateConfidence: (algo?.confidence as number | null) ?? null,
    ratifiedType: (ratified?.type as string | null) ?? null,
    ratifiedConfidence: (ratified?.confidence as number | null) ?? null,
    ratifiedReasoning: rawReasoning ? rawReasoning.slice(0, 240) : null,
    llmModel: (llmReq?.model as string | null) ?? null,
    algoCandidate: algo,
    ratified,
    llmRequest: llmReq,
    llmRawResponse: (item.llmRawResponse as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Paginated query of ratification records.
 *
 * Strategy: the table has PK=pair, SK=invokedAtRecordId.
 * When a pair filter is supplied, we Query that partition directly.
 * When no pair is given, we fan-out over all known pairs.
 * After applying client-side filters (timeframe, triggerReason, since, until),
 * we re-sort descending by invokedAt and slice to `limit`.
 *
 * Cursor encoding: the cursor is a base64 JSON map `{ [pair]: ExclusiveStartKey }`.
 * Each entry is the last DDB key returned by *that* pair's previous query, so
 * resume preserves per-partition position. A single cursor across 5 partitions
 * would let DDB reject 4 of 5 keys and silently return empty pages.
 */
export async function getRatifications(params: GetRatificationsParams): Promise<RatificationsPage> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  // Use the shared PAIRS constant — was previously a hardcoded literal that
  // would drift when pairs are added/removed. PAIRS is the canonical list.
  const pairsToQuery = params.pair ? [params.pair] : (PAIRS as readonly string[]);

  // Decode per-pair cursor map; absent or malformed → no resume keys.
  let perPairCursor: Record<string, Record<string, unknown>> = {};
  if (params.cursor) {
    try {
      const raw = JSON.parse(Buffer.from(params.cursor, "base64").toString());
      if (raw && typeof raw === "object") {
        perPairCursor = raw as Record<string, Record<string, unknown>>;
      }
    } catch (err) {
      console.warn("[admin.service] getRatifications: malformed cursor, ignoring", err);
    }
  }

  // Build SK range bounds from since/until so DDB does the heavy lifting.
  const skLo = params.since ? `${params.since}#` : undefined;
  const skHi = params.until ? `${params.until}#￿` : undefined;

  // Track each pair's per-batch results so we can compute per-pair next-cursor.
  const perPairItems: Record<string, Record<string, unknown>[]> = {};
  // Capture per-pair LastEvaluatedKey so we can emit a cursor whenever ANY
  // partition has more rows to read — even if client-side filtering shrunk
  // the merged page below `limit`. Without this, a selective filter like
  // `triggerReason=sentiment_shock` could prematurely end pagination.
  const perPairLastKey: Record<string, Record<string, unknown> | undefined> = {};

  for (const pair of pairsToQuery) {
    perPairItems[pair] = [];
    try {
      let keyCondition = "#pair = :pair";
      const exprNames: Record<string, string> = { "#pair": "pair" };
      const exprValues: Record<string, unknown> = { ":pair": pair };

      if (skLo && skHi) {
        keyCondition += " AND #sk BETWEEN :lo AND :hi";
        exprNames["#sk"] = "invokedAtRecordId";
        exprValues[":lo"] = skLo;
        exprValues[":hi"] = skHi;
      } else if (skLo) {
        keyCondition += " AND #sk >= :lo";
        exprNames["#sk"] = "invokedAtRecordId";
        exprValues[":lo"] = skLo;
      } else if (skHi) {
        keyCondition += " AND #sk <= :hi";
        exprNames["#sk"] = "invokedAtRecordId";
        exprValues[":hi"] = skHi;
      }

      const startKey = perPairCursor[pair];

      // Per-pair fetch budget. Need enough headroom to absorb client-side
      // filters (timeframe, triggerReason) without short-paging, but not so
      // much that we read multi-KB rows we'll never return. `limit + 20`
      // keeps the read cost bounded while leaving room for typical filter
      // throwaway rates. ScanIndexForward=false gives newest-first.
      const result = await dynamo.send(
        new QueryCommand({
          TableName: RATIFICATIONS_TABLE,
          KeyConditionExpression: keyCondition,
          ExpressionAttributeNames: exprNames,
          ExpressionAttributeValues: exprValues,
          ScanIndexForward: false,
          Limit: limit + 20,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      perPairItems[pair].push(...(result.Items ?? []));
      perPairLastKey[pair] = result.LastEvaluatedKey;
    } catch (err) {
      console.error(`[admin.service] getRatifications query failed for ${pair}:`, err);
    }
  }

  // Flatten with pair-of-origin tracked so we can build per-pair cursors later.
  // The cast keeps the index signature alive — `{ ...item, _pair: p }` infers
  // to `{ _pair: string }` alone otherwise, losing all DDB attribute access.
  type ItemWithPair = Record<string, unknown> & { _pair: string };
  const allItems: ItemWithPair[] = pairsToQuery.flatMap((p) =>
    perPairItems[p].map((item) => ({ ...item, _pair: p }) as ItemWithPair),
  );

  // Client-side filters (timeframe, triggerReason) since DDB has no secondary
  // index on those attributes. Records pre-#181 lack triggerReason; treat
  // absent as `bar_close` per the ratification-store.ts convention.
  const filtered = allItems.filter((item) => {
    if (params.timeframe && item.timeframe !== params.timeframe) return false;
    if (params.triggerReason) {
      const itemTrigger =
        typeof item.triggerReason === "string" && item.triggerReason.length > 0
          ? (item.triggerReason as string)
          : "bar_close";
      if (itemTrigger !== params.triggerReason) return false;
    }
    return true;
  });

  // Re-sort by invokedAt descending (fan-out from multiple partitions breaks DDB order).
  filtered.sort((a, b) => {
    const aKey = (a.invokedAtRecordId as string) ?? "";
    const bKey = (b.invokedAtRecordId as string) ?? "";
    return bKey.localeCompare(aKey);
  });

  const page = filtered.slice(0, limit);

  // Per-pair next-cursor. Three sources contribute to "more available":
  //   1. `filtered.length > limit` — we trimmed rows we already fetched.
  //   2. ANY pair's Query returned `LastEvaluatedKey` — that partition has
  //      more rows older than what we read, regardless of how many made it
  //      through the client-side filter. Without this, a selective filter
  //      can shrink `filtered` below `limit` and prematurely end paging.
  //   3. A pair came in with a cursor but contributed no rows this round
  //      (e.g. all its remaining rows in the window were filtered out
  //      client-side); we forward its prior cursor so a future request
  //      with different filters can still resume.
  //
  // Cursor anchor selection: for pairs that contributed rows to `page`, use
  // the LAST returned row's invokedAtRecordId. DDB's ExclusiveStartKey
  // skips strictly equal keys and returns what comes after — so the last
  // returned record is the correct anchor for "give me what comes next."
  // For pairs that hit Limit but didn't contribute (filter rejected all),
  // forward the Query's `LastEvaluatedKey` directly.
  const hasMoreFromAnyPair = Object.values(perPairLastKey).some((k) => k !== undefined);
  let nextCursor: Record<string, Record<string, unknown>> | null = null;
  if (filtered.length > limit || hasMoreFromAnyPair) {
    const cursorMap: Record<string, Record<string, unknown>> = {};
    for (const item of page) {
      const pair = item._pair as string;
      cursorMap[pair] = {
        pair,
        invokedAtRecordId: item.invokedAtRecordId,
      };
    }
    // For pairs whose Query had more rows but contributed nothing to this
    // page (filter ate everything), forward the Query's LastEvaluatedKey
    // so the next request resumes correctly.
    for (const pair of pairsToQuery) {
      if (!cursorMap[pair] && perPairLastKey[pair]) {
        cursorMap[pair] = perPairLastKey[pair] as Record<string, unknown>;
      }
    }
    // Pairs that contributed nothing AND didn't hit Limit but came in with a
    // prior cursor should keep that cursor — the user might change filters
    // next request and want to resume the same partition.
    for (const pair of pairsToQuery) {
      if (!cursorMap[pair] && perPairCursor[pair]) {
        cursorMap[pair] = perPairCursor[pair];
      }
    }
    if (Object.keys(cursorMap).length > 0) {
      nextCursor = cursorMap;
    }
  }

  // Strip the synthetic `_pair` before mapping to the API row shape.
  const cleanedPage = page.map(({ _pair: _ignored, ...rest }) => rest as Record<string, unknown>);

  return {
    items: cleanedPage.map(toRatificationRow),
    cursor: nextCursor ? Buffer.from(JSON.stringify(nextCursor)).toString("base64") : null,
  };
}

// ---------------------------------------------------------------------------
// getActivity — backfill for the ActivityFeed component (issue #222)
// ---------------------------------------------------------------------------

/**
 * Aggregate the most recent N pipeline events across four DynamoDB sources and
 * normalize each one into the `PipelineEvent` discriminated union understood by
 * `ActivityFeed.tsx`.
 *
 * Sources (matches what the WS fanout publishes):
 *  1. signals-v2        → "signal-emitted" events, newest per (pair × timeframe).
 *  2. ratifications     → "ratification-fired" (non-skip) events.
 *  3. news-events       → "news-enriched" events filtered to status="enriched".
 *  4. indicator-state   → "indicator-state-updated", most recent per (pair × timeframe).
 *
 * Events are merged, sorted by their `ts` field descending, and sliced to `limit`.
 */
export async function getActivity(limit: number): Promise<{ events: PipelineEvent[] }> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);

  // Per-source budgets: fetch enough rows from each source that after merging
  // we can always return `safeLimit` events sorted by recency.
  const perSourceLimit = Math.min(safeLimit, 150);

  const [signalEvents, ratificationEvents, newsEvents, indicatorEvents] = await Promise.all([
    fetchRecentSignalEvents(perSourceLimit),
    fetchRecentRatificationEvents(perSourceLimit),
    fetchRecentNewsEvents(perSourceLimit),
    fetchRecentIndicatorEvents(),
  ]);

  const all: PipelineEvent[] = [
    ...signalEvents,
    ...ratificationEvents,
    ...newsEvents,
    ...indicatorEvents,
  ];

  // Sort newest-first by `ts`, then slice.
  all.sort((a, b) => b.ts.localeCompare(a.ts));
  return { events: all.slice(0, safeLimit) };
}

// ---------------------------------------------------------------------------
// Per-source fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch recent signal-emitted events from signals-v2.
 *
 * `Limit: 1` per (pair × timeframe) is intentional: with 5 pairs × 4 timeframes
 * = 20 cells, we get the 20 most recent signals across the matrix in one batch
 * of 20 cheap point Queries (1 RCU each). The caller (`getActivity`) merges
 * these alongside the other event sources, sorts by `ts` desc, and slices to
 * the requested limit. The previous `Limit: limit` per cell did 20 × `limit`
 * row reads to surface a feed that only ever shows ~5–20 signal events.
 */
async function fetchRecentSignalEvents(limit: number): Promise<PipelineEvent[]> {
  const blendTfs = ["15m", "1h", "4h", "1d"] as const;
  const events: PipelineEvent[] = [];

  try {
    const perTfItems = await Promise.all(
      (PAIRS as readonly string[]).flatMap((pair) =>
        blendTfs.map(async (tf) => {
          const result = await dynamo.send(
            new QueryCommand({
              TableName: SIGNALS_V2_TABLE,
              KeyConditionExpression: "#pair = :pair AND begins_with(#sk, :prefix)",
              ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
              ExpressionAttributeValues: { ":pair": pair, ":prefix": `${tf}#` },
              ScanIndexForward: false,
              // Latest-per-cell only — cheap "newest signal across the matrix"
              // pattern. Tuning this back to `limit` was an N+1 read amplifier.
              Limit: 1,
            }),
          );
          return result.Items ?? [];
        }),
      ),
    );

    for (const items of perTfItems) {
      for (const item of items) {
        const emittedAt =
          (item.emittedAt as string | undefined) ?? new Date(Number(item.asOf ?? 0)).toISOString();
        events.push({
          type: "signal-emitted",
          pair: item.pair as string,
          timeframe: item.emittingTimeframe as string,
          signalType: item.type as "buy" | "sell" | "hold",
          confidence: (item.confidence as number) ?? 0,
          closeTime: new Date(Number(item.closeTime ?? item.asOf ?? 0)).toISOString(),
          ts: emittedAt,
        });
      }
    }
  } catch (err) {
    console.error("[admin.service] fetchRecentSignalEvents failed:", err);
  }

  // Sort newest-first by closeTime so the caller's slice picks the most
  // recent signals across the matrix when fewer than `limit` are kept.
  events.sort((a, b) => {
    const aClose = a.type === "signal-emitted" ? a.closeTime : "";
    const bClose = b.type === "signal-emitted" ? b.closeTime : "";
    return bClose.localeCompare(aClose);
  });

  return events.slice(0, limit);
}

/** Fetch recent ratification-fired events from the ratifications table. */
async function fetchRecentRatificationEvents(limit: number): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];

  try {
    await Promise.all(
      (PAIRS as readonly string[]).map(async (pair) => {
        const result = await dynamo.send(
          new QueryCommand({
            TableName: RATIFICATIONS_TABLE,
            KeyConditionExpression: "#pair = :pair",
            ExpressionAttributeNames: { "#pair": "pair" },
            ExpressionAttributeValues: { ":pair": pair },
            ScanIndexForward: false,
            Limit: limit,
          }),
        );

        for (const item of result.Items ?? []) {
          // Skip "skip" rows — they are gating rows, not fired ratifications.
          const invokedReason = (item.invokedReason as string) ?? "";
          if (invokedReason.startsWith("skip")) continue;

          const invokedAt = (item.invokedAt as string) ?? new Date().toISOString();
          const ratified = item.ratified as { type?: string; confidence?: number } | null;
          let verdict: "ratified" | "downgraded" | "not-required" = "not-required";
          if (item.fellBackToAlgo) verdict = "downgraded";
          else if (ratified?.type) verdict = "ratified";

          events.push({
            type: "ratification-fired",
            pair: item.pair as string,
            timeframe: (item.timeframe as string) ?? "",
            triggerReason:
              typeof item.triggerReason === "string" && item.triggerReason.length > 0
                ? (item.triggerReason as string)
                : "bar_close",
            verdict,
            latencyMs: (item.latencyMs as number) ?? 0,
            costUsd: (item.costUsd as number) ?? 0,
            cacheHit: Boolean(item.cacheHit),
            ts: invokedAt,
          });
        }
      }),
    );
  } catch (err) {
    console.error("[admin.service] fetchRecentRatificationEvents failed:", err);
  }

  return events;
}

/** Fetch recent news-enriched events from the news-events table. */
async function fetchRecentNewsEvents(limit: number): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];

  try {
    // Walk the published-day-index newest-first. Walk up to 3 days to ensure
    // we can fill the requested limit even on low-traffic days.
    const MAX_DAYS = 3;
    let collected = 0;
    const today = new Date();

    for (let d = 0; d < MAX_DAYS && collected < limit; d++) {
      const day = new Date(today);
      day.setUTCDate(today.getUTCDate() - d);
      const dayStr = day.toISOString().slice(0, 10);

      const result = await dynamo.send(
        new QueryCommand({
          TableName: NEWS_TABLE,
          IndexName: NEWS_DAY_INDEX,
          KeyConditionExpression: "#day = :day",
          FilterExpression: "#status = :enriched",
          ExpressionAttributeNames: { "#day": "publishedDay", "#status": "status" },
          ExpressionAttributeValues: { ":day": dayStr, ":enriched": "enriched" },
          ScanIndexForward: false,
          Limit: limit - collected,
        }),
      );

      for (const item of result.Items ?? []) {
        const enrichment = item.enrichment as Record<string, unknown> | undefined;
        const mentionedPairs = (enrichment?.mentionedPairs as string[] | undefined) ?? [];
        const sentiment = enrichment?.sentiment as
          | { score?: number; magnitude?: number }
          | undefined;

        events.push({
          type: "news-enriched",
          newsId: item.newsId as string,
          mentionedPairs,
          sentimentScore: (sentiment?.score as number) ?? 0,
          sentimentMagnitude: (sentiment?.magnitude as number) ?? 0,
          ts: (item.enrichedAt as string | undefined) ?? (item.publishedAt as string),
        });
        collected++;
      }
    }
  } catch (err) {
    console.error("[admin.service] fetchRecentNewsEvents failed:", err);
  }

  return events;
}

/** Fetch the most-recent indicator-state update per pair × timeframe. */
async function fetchRecentIndicatorEvents(): Promise<PipelineEvent[]> {
  const blendTfs = ["15m", "1h", "4h", "1d"] as const;
  const events: PipelineEvent[] = [];

  try {
    // One Query per (pair × timeframe) with Limit=1 + ScanIndexForward=false
    // returns the single most-recent snapshot cheaply.
    await Promise.all(
      (PAIRS as readonly string[]).flatMap((pair) =>
        blendTfs.map(async (tf) => {
          const pk = `${pair}#consensus#${tf}`;
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
          if (!item) return;

          // asOf is stored as ISO8601 string (SK). asOfMs is the epoch-ms number.
          const ts =
            typeof item.asOf === "string"
              ? item.asOf
              : new Date(Number(item.asOfMs ?? 0)).toISOString();

          events.push({
            type: "indicator-state-updated",
            pair: item.pair as string,
            timeframe: tf,
            barsSinceStart: (item.barsSinceStart as number) ?? 0,
            rsi14: item.rsi14 != null ? (item.rsi14 as number) : undefined,
            ts,
          });
        }),
      ),
    );
  } catch (err) {
    console.error("[admin.service] fetchRecentIndicatorEvents failed:", err);
  }

  return events;
}

// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getPipelineHealth — data for admin/pipeline-health dashboard
// ---------------------------------------------------------------------------

const HEALTH_EXCHANGES = ["binanceus", "kraken", "coinbase"] as const;
type Exchange = (typeof HEALTH_EXCHANGES)[number];

/** Seconds since a candle was last written before we consider an exchange stale/down. */
const STALE_THRESHOLD_S = 5 * 60; // 5 min
const DOWN_THRESHOLD_S = 15 * 60; // 15 min

/** Lambda functions tracked for CloudWatch metrics. */
const HEALTH_LAMBDAS = ["api", "ingestion", "backfill", "news-backfill", "enrichment"] as const;

/** Pairs × timeframes used for quorum success-rate calculation. */
const QUORUM_TIMEFRAMES = ["15m", "1h", "4h"] as const;

export interface ExchangeHealth {
  lastDataAt: string | null;
  streamHealth: "healthy" | "stale" | "down";
  stalenessSec: number | null;
  // Always null for now; populating from watchdog log Insights tracked in #212.
  restartCount: number | null;
}

export interface QuorumHealth {
  successRate: number | null;
  perPair: Record<string, { perTf: Record<string, number | null> }>;
}

export interface LambdaHealth {
  invocations: number | null;
  errors: number | null;
  errorRate: number | null;
  avgDurationMs: number | null;
  throttles: number | null;
}

export interface FargateHealth {
  runningCount: number;
  desiredCount: number;
  lastRestartAt: string | null;
  cpuUtilizationPct: number | null;
  memoryUtilizationPct: number | null;
}

export interface PipelineHealth {
  windowStart: string;
  windowEnd: string;
  exchanges: Record<Exchange, ExchangeHealth>;
  quorum: QuorumHealth;
  lambdas: Record<string, LambdaHealth>;
  fargate: FargateHealth;
}

// Stream writers (ingestion/src/exchanges/stream.ts) push 1m candles continuously,
// so 1m is the canonical freshness signal for "is this exchange streaming?".
const HEALTH_FRESHNESS_TIMEFRAME = "1m";

/** Fetch the latest candle sk per exchange from the candles GSI.
 *  The GSI `exchange-index` uses `exchange` as hash key and `sk` as range key
 *  where sk = `exchange#timeframe#iso`. Without a `begins_with` prefix the
 *  ScanIndexForward=false query would return the lexicographically-largest sk
 *  across timeframes, which can blend higher-tf backfills into the freshness
 *  measurement. Constrain to the streaming timeframe so we measure live data. */
async function getExchangeLastDataAt(exchange: Exchange): Promise<string | null> {
  try {
    const skPrefix = `${exchange}#${HEALTH_FRESHNESS_TIMEFRAME}#`;
    const result = await dynamo.send(
      new QueryCommand({
        TableName: `${PREFIX}-candles`,
        IndexName: "exchange-index",
        KeyConditionExpression: "#exchange = :exchange AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#exchange": "exchange", "#sk": "sk" },
        ExpressionAttributeValues: { ":exchange": exchange, ":skPrefix": skPrefix },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    const item = result.Items?.[0];
    if (!item) return null;
    // sk format: exchange#timeframe#iso8601
    const sk = item.sk as string | undefined;
    if (!sk) return null;
    const iso = sk.split("#")[2];
    return iso ?? null;
  } catch {
    return null;
  }
}

/** Compute staleness health bucket from a timestamp string. */
function toStreamHealth(
  lastDataAt: string | null,
  nowMs: number,
): { streamHealth: ExchangeHealth["streamHealth"]; stalenessSec: number | null } {
  if (!lastDataAt) return { streamHealth: "down", stalenessSec: null };
  const lastMs = new Date(lastDataAt).getTime();
  // Malformed ISO → NaN. Treat as "down" rather than letting NaN propagate
  // through the threshold comparisons (every comparison with NaN is false,
  // which would silently report "healthy").
  if (!Number.isFinite(lastMs)) return { streamHealth: "down", stalenessSec: null };
  const stalenessSec = Math.round((nowMs - lastMs) / 1000);
  if (stalenessSec > DOWN_THRESHOLD_S) return { streamHealth: "down", stalenessSec };
  if (stalenessSec > STALE_THRESHOLD_S) return { streamHealth: "stale", stalenessSec };
  return { streamHealth: "healthy", stalenessSec };
}

/** Page through enough indicator-state rows to cover the window without
 *  truncating. Hard cap on pages prevents a runaway query on a partition with
 *  unexpectedly many rows. */
const QUORUM_QUERY_PAGE_SIZE = 500;
const QUORUM_QUERY_MAX_PAGES = 10; // 5,000 rows max per pair+tf — well above 168h × 15m bars (672)

/** Count quorum bar-closes: a bar-close has quorum when ≥2 of 3 exchanges
 *  had fresh data for that pair+timeframe within the window.
 *  We read from indicator_state records (exchange=consensus) and compare the
 *  dispersion field — when dispersion is non-null a quorum was achieved.
 *  Returns raw counts so the aggregate can be a weighted (not naive) average. */
async function computeQuorumForPairTf(
  pair: string,
  timeframe: string,
  windowStart: string,
): Promise<{ totalBars: number; barsWithQuorum: number } | null> {
  try {
    const pk = `${pair}#consensus#${timeframe}`;
    let totalBars = 0;
    let barsWithQuorum = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;

    for (let page = 0; page < QUORUM_QUERY_MAX_PAGES; page++) {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: INDICATOR_STATE_TABLE,
          KeyConditionExpression: "#pk = :pk AND #asOf >= :start",
          ExpressionAttributeNames: { "#pk": "pk", "#asOf": "asOf" },
          ExpressionAttributeValues: { ":pk": pk, ":start": windowStart },
          ScanIndexForward: false,
          Limit: QUORUM_QUERY_PAGE_SIZE,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      const items = result.Items ?? [];
      totalBars += items.length;
      for (const it of items) {
        // DDB DocumentClient drops null attrs on write, so no-quorum rows lack
        // `dispersion` entirely. Use `!= null` so both `null` and `undefined`
        // fail the check; previously `!== null` overcounted undefined as quorum-achieved.
        if (it.dispersion != null) barsWithQuorum += 1;
      }
      if (!result.LastEvaluatedKey) break;
      exclusiveStartKey = result.LastEvaluatedKey;
    }

    if (totalBars === 0) return null;
    return { totalBars, barsWithQuorum };
  } catch {
    return null;
  }
}

/** CloudWatch GetMetricStatistics constraints we care about:
 *  - Period must be a multiple of 60 (when ≥60).
 *  - For windows up to 15 days, max Period is 86_400 s (1 day).
 *  - Total returned datapoints capped at 1,440 per call.
 *  Setting Period = full window seconds (the previous behaviour) breaks for
 *  any window longer than 24h. Clamp to ≤86_400 and snap to a 60s multiple
 *  that yields a sensible bucket count (target ~24 buckets so dashboards are
 *  legible: small windows → fine grain, large windows → 1h buckets). */
function clampPeriod(windowSec: number): number {
  const TARGET_BUCKETS = 24;
  const MAX_PERIOD = 86_400;
  const MIN_PERIOD = 60;
  const raw = Math.max(MIN_PERIOD, Math.round(windowSec / TARGET_BUCKETS));
  const clamped = Math.min(MAX_PERIOD, raw);
  // Snap up to the nearest 60s multiple so CloudWatch accepts the value.
  return Math.ceil(clamped / 60) * 60;
}

/**
 * Fetch CloudWatch metric statistics for a Lambda function over the given window.
 * Returns null-filled metrics on failure (e.g. IAM denied, no datapoints).
 */
async function fetchLambdaMetrics(
  functionName: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<LambdaHealth> {
  const nullMetrics: LambdaHealth = {
    invocations: null,
    errors: null,
    errorRate: null,
    avgDurationMs: null,
    throttles: null,
  };

  try {
    const windowSec = Math.round((windowEnd.getTime() - windowStart.getTime()) / 1000);
    const periodSec = clampPeriod(windowSec);
    const dims = [{ Name: "FunctionName", Value: functionName }];

    async function stat(metricName: string, statName: "Sum" | "Average"): Promise<number | null> {
      try {
        const res = await cloudwatch.send(
          new GetMetricStatisticsCommand({
            Namespace: "AWS/Lambda",
            MetricName: metricName,
            Dimensions: dims,
            StartTime: windowStart,
            EndTime: windowEnd,
            Period: periodSec,
            Statistics: [statName],
          }),
        );
        // CloudWatch returns datapoints in arbitrary order; aggregate across the whole window.
        // Sum stat: total across buckets. Average stat: mean of per-bucket averages.
        const points = (res.Datapoints ?? [])
          .map((d) => d[statName])
          .filter((v): v is number => typeof v === "number");
        if (points.length === 0) return null;
        if (statName === "Sum") return points.reduce((a, b) => a + b, 0);
        return points.reduce((a, b) => a + b, 0) / points.length;
      } catch {
        return null;
      }
    }

    const [invocations, errors, avgDurationMs, throttles] = await Promise.all([
      stat("Invocations", "Sum"),
      stat("Errors", "Sum"),
      stat("Duration", "Average"),
      stat("Throttles", "Sum"),
    ]);

    const errorRate =
      invocations !== null && errors !== null && invocations > 0 ? errors / invocations : null;

    return { invocations, errors, errorRate, avgDurationMs, throttles };
  } catch {
    return nullMetrics;
  }
}

/** Fetch Fargate ECS service state + CloudWatch utilization metrics. */
async function getFargateHealth(windowStart: Date, windowEnd: Date): Promise<FargateHealth> {
  const cluster = `${PREFIX}-ingestion`;

  // ECS service state
  let runningCount = 0;
  let desiredCount = 0;
  try {
    const svcRes = await ecs.send(new DescribeServicesCommand({ cluster, services: [cluster] }));
    const svc = svcRes.services?.[0];
    if (svc) {
      runningCount = svc.runningCount ?? 0;
      desiredCount = svc.desiredCount ?? 0;
    }
  } catch {
    /* graceful */
  }

  // CloudWatch ECS utilization
  let cpuUtilizationPct: number | null = null;
  let memoryUtilizationPct: number | null = null;
  let lastRestartAt: string | null = null;

  try {
    const windowSec = Math.round((windowEnd.getTime() - windowStart.getTime()) / 1000);
    const periodSec = clampPeriod(windowSec);
    const dims = [
      { Name: "ClusterName", Value: cluster },
      { Name: "ServiceName", Value: cluster },
    ];

    async function ecsStat(metricName: string): Promise<number | null> {
      try {
        const res = await cloudwatch.send(
          new GetMetricStatisticsCommand({
            Namespace: "AWS/ECS",
            MetricName: metricName,
            Dimensions: dims,
            StartTime: windowStart,
            EndTime: windowEnd,
            Period: periodSec,
            Statistics: ["Average"],
          }),
        );
        // Datapoints are unordered; mean-of-means represents window utilization.
        const points = (res.Datapoints ?? [])
          .map((d) => d.Average)
          .filter((v): v is number => typeof v === "number");
        if (points.length === 0) return null;
        return points.reduce((a, b) => a + b, 0) / points.length;
      } catch {
        return null;
      }
    }

    [cpuUtilizationPct, memoryUtilizationPct] = await Promise.all([
      ecsStat("CPUUtilization"),
      ecsStat("MemoryUtilization"),
    ]);
  } catch {
    /* IAM denied or transient — fall through to nulls */
  }

  // Attempt to find last restart time from CloudWatch Logs
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
    const createdAt = streams.logStreams?.[0]?.creationTime;
    if (createdAt) lastRestartAt = new Date(createdAt).toISOString();
  } catch {
    /* graceful */
  }

  return { runningCount, desiredCount, lastRestartAt, cpuUtilizationPct, memoryUtilizationPct };
}

/** Maximum milliseconds spent polling for a Logs Insights query result.
 *  Abort and return null when exceeded so the dashboard endpoint stays fast. */
const INSIGHTS_POLL_TIMEOUT_MS = 3_000;
/** Interval between Insights status polls. */
const INSIGHTS_POLL_INTERVAL_MS = 250;

/**
 * Run a CloudWatch Logs Insights query against the ingestion watchdog log group
 * and return restart counts per exchange over the given window.
 *
 * The watchdog emits: [Watchdog] Restarting stream <exchange>#<pair> (…)
 * We `stats count() by exchange` after splitting that prefix.
 *
 * Returns null per exchange on timeout or IAM/permissions errors.
 * Abort after INSIGHTS_POLL_TIMEOUT_MS to keep the dashboard endpoint under budget.
 */
export async function getExchangeRestartCounts(
  windowStart: Date,
  windowEnd: Date,
): Promise<Record<string, number> | null> {
  const logGroupName = `/ecs/${PREFIX}-ingestion`;
  // Extract the exchange name from the stream key (format: <exchange>#<pair>).
  // The watchdog log line: [Watchdog] Restarting stream <key> (no data for …)
  const queryString = [
    "fields @message",
    "| filter @message like /\\[Watchdog\\] Restarting stream /",
    "| parse @message '[Watchdog] Restarting stream *#* ' as exchange, rest",
    "| stats count() as restartCount by exchange",
  ].join(" ");

  let queryId: string | undefined;
  try {
    const startResult = await cwLogs.send(
      new StartQueryCommand({
        logGroupName,
        startTime: Math.floor(windowStart.getTime() / 1000),
        endTime: Math.floor(windowEnd.getTime() / 1000),
        queryString,
      }),
    );
    queryId = startResult.queryId;
  } catch {
    // IAM denied, log group missing, or transient — return null gracefully.
    return null;
  }

  if (!queryId) return null;

  // Poll for results with a hard timeout.
  const deadline = Date.now() + INSIGHTS_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, INSIGHTS_POLL_INTERVAL_MS));
    try {
      const result = await cwLogs.send(new GetQueryResultsCommand({ queryId }));
      const status = result.status;
      if (
        status === QueryStatus.Running ||
        status === QueryStatus.Scheduled ||
        status === QueryStatus.Unknown
      ) {
        continue;
      }
      if (status !== QueryStatus.Complete) {
        // Failed, Cancelled, or other terminal non-complete state.
        return null;
      }
      // Build exchange → count map from the result rows.
      const counts: Record<string, number> = {};
      for (const row of result.results ?? []) {
        let exchange: string | undefined;
        let count: number | undefined;
        for (const field of row) {
          if (field.field === "exchange") exchange = field.value;
          if (field.field === "restartCount") count = Number(field.value);
        }
        if (exchange && count !== undefined && Number.isFinite(count)) {
          counts[exchange] = count;
        }
      }
      return counts;
    } catch {
      return null;
    }
  }
  // Timed out — return null so the caller fills restartCount: null.
  return null;
}

export async function getPipelineHealth(windowHours = 24): Promise<PipelineHealth> {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);

  // --- Exchange health ---
  // Run the Insights query concurrently with per-exchange DDB queries.
  // getExchangeRestartCounts returns null on timeout or IAM error (restartCount stays null).
  const [exchangeEntries, restartCountMap] = await Promise.all([
    Promise.all(
      HEALTH_EXCHANGES.map(async (exchange) => {
        const lastDataAt = await getExchangeLastDataAt(exchange);
        const { streamHealth, stalenessSec } = toStreamHealth(lastDataAt, windowEnd.getTime());
        return [exchange, { lastDataAt, streamHealth, stalenessSec }] as const;
      }),
    ),
    getExchangeRestartCounts(windowStart, windowEnd),
  ]);
  const exchanges = Object.fromEntries(
    exchangeEntries.map(([exchange, health]) => [
      exchange,
      {
        ...health,
        restartCount: restartCountMap?.[exchange] ?? null,
      } satisfies ExchangeHealth,
    ]),
  ) as Record<Exchange, ExchangeHealth>;

  // --- Quorum ---
  // Aggregate is a weighted average: sum(barsWithQuorum) / sum(totalBars)
  // across pair×tf, so a high-bar-density timeframe (e.g. 15m) contributes
  // proportionally to its actual bar count rather than being one-row-equivalent
  // to a low-density timeframe (4h).
  let totalBars = 0;
  let barsWithQuorum = 0;
  const perPair: QuorumHealth["perPair"] = {};

  for (const pair of PAIRS) {
    perPair[pair] = { perTf: {} };
    for (const tf of QUORUM_TIMEFRAMES) {
      const counts = await computeQuorumForPairTf(pair, tf, windowStart.toISOString());
      if (counts === null) {
        perPair[pair].perTf[tf] = null;
        continue;
      }
      perPair[pair].perTf[tf] =
        counts.totalBars > 0 ? counts.barsWithQuorum / counts.totalBars : null;
      totalBars += counts.totalBars;
      barsWithQuorum += counts.barsWithQuorum;
    }
  }

  const quorumSuccessRate = totalBars > 0 ? barsWithQuorum / totalBars : null;
  const quorum: QuorumHealth = { successRate: quorumSuccessRate, perPair };

  // --- Lambda metrics ---
  const lambdaEntries = await Promise.all(
    HEALTH_LAMBDAS.map(async (name) => {
      const fullName = `${PREFIX}-${name}`;
      const metrics = await fetchLambdaMetrics(fullName, windowStart, windowEnd);
      return [name, metrics] as const;
    }),
  );
  const lambdas = Object.fromEntries(lambdaEntries) as Record<string, LambdaHealth>;

  // --- Fargate ---
  const fargate = await getFargateHealth(windowStart, windowEnd);

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    exchanges,
    quorum,
    lambdas,
    fargate,
  };
}

// ---------------------------------------------------------------------------
// Issue #133: shadow signals (1m/5m data-collection, no LLM, no fanout)
// ---------------------------------------------------------------------------

export interface ShadowSignalRow {
  pair: string;
  sk: string;
  signalId: string;
  emittedAt: string;
  closeTime: number;
  timeframe: string;
  source: "shadow";
  type: "buy" | "sell" | "hold";
  confidence: number;
  volatilityFlag: boolean;
  gateReason: string | null;
  rulesFired: string[];
  bullishScore: number;
  bearishScore: number;
  asOf: number;
  /** UI badge marker — always true for shadow rows. */
  shadow: true;
}

/**
 * Read the most recent shadow signals from signals-collection.
 *
 * Queries by pair. When no pair is specified, reads all PAIRS in parallel
 * (each pair is a separate partition key). Results are merged and sorted
 * by emittedAt descending, sliced to `limit`.
 */
export async function getShadowSignals(opts: {
  pair?: string;
  timeframe?: string;
  since?: string;
  limit: number;
}): Promise<ShadowSignalRow[]> {
  const { pair, timeframe, limit } = opts;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sinceMs = new Date(since).getTime();

  const pairs = pair ? [pair] : (SUPPORTED_PAIRS as readonly string[]).slice();
  const shadowTfs = timeframe ? [timeframe] : ["1m", "5m"];

  // Bound DDB fan-out. With all 5 pairs × 2 timeframes (= 10 queries) the
  // unbounded Promise.all path was issuing every Query simultaneously, which
  // can spike provisioned-throughput consumption and trigger throttling at
  // higher pair counts. Cap at 4 concurrent queries — a manual semaphore
  // keeps the dependency footprint clean (no p-limit).
  const SHADOW_QUERY_CONCURRENCY = 4;
  const tasks: Array<() => Promise<Record<string, unknown>[]>> = pairs.flatMap((p) =>
    shadowTfs.map((tf) => async (): Promise<Record<string, unknown>[]> => {
      const tfPrefix = `${tf}#`;
      const result = await dynamo.send(
        new QueryCommand({
          TableName: SIGNALS_COLLECTION_TABLE,
          KeyConditionExpression: "#pair = :pair AND #sk BETWEEN :lo AND :hi",
          ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pair": p,
            ":lo": `${tfPrefix}${sinceMs}`,
            ":hi": `${tfPrefix}￿`,
          },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );
      return (result.Items as Record<string, unknown>[] | undefined) ?? [];
    }),
  );

  try {
    const perPairTf: Record<string, unknown>[][] = new Array(tasks.length);
    let nextIdx = 0;
    async function worker(): Promise<void> {
      while (true) {
        const i = nextIdx++;
        if (i >= tasks.length) return;
        perPairTf[i] = await tasks[i]!();
      }
    }
    const workerCount = Math.min(SHADOW_QUERY_CONCURRENCY, tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const merged = perPairTf.flat();
    merged.sort((a, b) => {
      const aT = (a["emittedAt"] as string) ?? "";
      const bT = (b["emittedAt"] as string) ?? "";
      return bT.localeCompare(aT);
    });

    // Defensive: signals-collection should only ever contain source="shadow"
    // rows (the shadow handler is the only writer), but if a non-shadow row
    // somehow lands here, drop it rather than silently mislabeling it as
    // shadow. Anything else indicates a bug we want to surface, not paper over.
    const filtered = merged.filter((item) => item["source"] === "shadow");
    if (filtered.length !== merged.length) {
      console.warn(
        `[admin.service] getShadowSignals dropped ${merged.length - filtered.length} non-shadow rows from signals-collection`,
      );
    }

    return filtered.slice(0, limit).map(
      (item): ShadowSignalRow => ({
        pair: item["pair"] as string,
        sk: item["sk"] as string,
        signalId: item["signalId"] as string,
        emittedAt: item["emittedAt"] as string,
        closeTime: item["closeTime"] as number,
        timeframe: item["timeframe"] as string,
        // After the filter above, source is guaranteed "shadow". Read it
        // from the item (with the literal cast) rather than hard-coding so
        // any future drift surfaces in the filter, not silently here.
        source: item["source"] as "shadow",
        type: item["type"] as "buy" | "sell" | "hold",
        confidence: item["confidence"] as number,
        volatilityFlag: (item["volatilityFlag"] as boolean) ?? false,
        gateReason: (item["gateReason"] as string | null) ?? null,
        rulesFired: (item["rulesFired"] as string[]) ?? [],
        bullishScore: (item["bullishScore"] as number) ?? 0,
        bearishScore: (item["bearishScore"] as number) ?? 0,
        asOf: item["asOf"] as number,
        shadow: true,
      }),
    );
  } catch (err) {
    console.error("[admin.service] getShadowSignals failed:", err);
    return [];
  }
}
