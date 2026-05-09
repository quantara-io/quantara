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

export async function getNews(limit = 50) {
  try {
    const [scan, fearGreed] = await Promise.all([
      dynamo.send(new ScanCommand({ TableName: `${PREFIX}-news-events`, Limit: 200 })),
      getFearGreed(),
    ]);
    const items = ((scan.Items ?? []) as Record<string, unknown>[]).sort((a, b) =>
      String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")),
    );
    return { news: items.slice(0, limit), fearGreed };
  } catch (err) {
    console.error("[admin.service] getNews failed:", err);
    return { news: [], fearGreed: null };
  }
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
// Genie Performance Metrics
// ---------------------------------------------------------------------------

const RATIFICATIONS_TABLE =
  process.env.TABLE_RATIFICATIONS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratifications`;

const SIGNAL_OUTCOMES_TABLE =
  process.env.TABLE_SIGNAL_OUTCOMES ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signal-outcomes`;

// All monitored pairs — used when no pair filter is specified.
const ALL_PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"] as const;

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
  // Outcome counts keyed by the production resolver's enum
  // (`OutcomeRecord.outcome` ∈ "correct" | "incorrect" | "neutral"; "pending"
  // is synthesized for outcomes whose corresponding signal hasn't resolved yet).
  outcomes: {
    correct: number;
    incorrect: number;
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
    avgPerCorrectUsd: number | null;
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

interface RatificationRow {
  pair: string;
  invokedAtRecordId: string;
  invokedAt: string;
  invokedReason: string;
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
): Promise<RatificationRow[]> {
  const rows: RatificationRow[] = [];

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
          rows.push(item as RatificationRow);
        }
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey !== undefined);
    }),
  );

  return rows;
}

/**
 * Query signals-v2 for a set of pairs over a time window across all blended TFs.
 * signals-v2 PK=pair, SK=`tf#closeTimeMs`. closeTime is fixed-width epoch ms
 * within a TF prefix so SK BETWEEN comparisons are correct ordered ranges.
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
): Promise<SignalRow[]> {
  const sinceMs = new Date(sinceIso).getTime();
  const untilMs = new Date(untilIso).getTime();
  const blendTfs = ["15m", "1h", "4h", "1d"] as const;
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
              emittingTimeframe: tf,
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
 * Query all signal-outcome records for a set of pairs where resolvedAt >= sinceIso.
 * signal-outcomes table PK=pair, SK=signalId. FilterExpression on resolvedAt.
 */
async function queryOutcomesForWindow(
  pairs: readonly string[],
  sinceIso: string,
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
            FilterExpression: "#resolvedAt >= :since",
            ExpressionAttributeNames: { "#pair": "pair", "#resolvedAt": "resolvedAt" },
            ExpressionAttributeValues: { ":pair": pair, ":since": sinceIso },
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
 * @param since      ISO-8601 lower bound (default: 7 days ago)
 * @param pair       Optional pair filter (default: all monitored pairs)
 * @param timeframe  Optional timeframe filter applied to signal-outcomes only
 */
export async function getGenieMetrics(
  since?: string,
  pair?: string,
  timeframe?: string,
): Promise<GenieMetrics> {
  const windowEnd = new Date().toISOString();
  const windowStart = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const pairs = pair ? [pair] : ALL_PAIRS;

  // signals_v2 is the source of truth for `signalCount` and ratification-
  // pathway partitioning. ratifications is the source for cost + gating
  // breakdown. signal-outcomes is the source for win-rate.
  const [signalRows, ratRows, outcomeRows] = await Promise.all([
    querySignalsForWindow(pairs, windowStart, windowEnd),
    queryRatificationsForWindow(pairs, windowStart, windowEnd),
    queryOutcomesForWindow(pairs, windowStart),
  ]);

  // Apply timeframe filter consistently across signals and outcomes so all
  // counts and partitions describe the same slice of the data.
  const filteredSignals = timeframe
    ? signalRows.filter((s) => s.emittingTimeframe === timeframe)
    : signalRows;
  const filteredOutcomes = timeframe
    ? outcomeRows.filter((o) => o.emittingTimeframe === timeframe)
    : outcomeRows;

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

  for (const r of ratRows) {
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
  // the algo verdict". Comes from ratifications.
  let fallbackCount = 0;
  for (const r of ratRows) {
    if (r.fellBackToAlgo) fallbackCount++;
  }

  // ------------------------------------------------------------------
  // Outcome counts (production resolver enum)
  // ------------------------------------------------------------------
  let correct = 0;
  let incorrect = 0;
  let neutral = 0;
  // "pending" is computed from signals that don't yet have an outcome row.
  const resolvedSignalIds = new Set<string>();
  for (const o of filteredOutcomes) resolvedSignalIds.add(o.signalId);
  let pendingOutcomes = 0;
  for (const s of filteredSignals) {
    if (!resolvedSignalIds.has(s.signalId)) pendingOutcomes++;
  }

  for (const o of filteredOutcomes) {
    if (o.outcome === "correct") correct++;
    else if (o.outcome === "incorrect") incorrect++;
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
  const avgPerCorrectUsd = correct > 0 ? totalCostUsd / correct : null;
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
    outcomes: { correct, incorrect, neutral, pending: pendingOutcomes },
    winRate: {
      overall: overallWinRate,
      algoOnly: algoOnlyWinRate,
      llmRatified: llmRatifiedWinRate,
      llmDowngraded: llmDowngradedWinRate,
    },
    cost: { totalUsd: totalCostUsd, avgPerSignalUsd, avgPerCorrectUsd, cacheHitRate },
    gating: { skipLowConfidence, skipRateLimit, skipDailyCap, skipNotRequired, invoked },
  };
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
