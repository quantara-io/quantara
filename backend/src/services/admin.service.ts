import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ECSClient, DescribeServicesCommand, ListTasksCommand } from "@aws-sdk/client-ecs";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { CloudWatchLogsClient, GetLogEventsCommand, DescribeLogStreamsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";

const REGION = process.env.AWS_REGION ?? "us-west-2";
const PREFIX = (process.env.TABLE_PREFIX ?? "quantara-dev-").replace(/-$/, "");
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? "";
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const dynamoRaw = new DynamoDBClient({ region: REGION });
const ecs = new ECSClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const cwLogs = new CloudWatchLogsClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

const TABLES = [
  "prices", "candles", "news-events", "ingestion-metadata",
  "signals", "signal-history", "users", "deals",
  "deal-interests", "coach-sessions", "coach-messages", "campaigns",
];

const SQS_QUEUES = [
  "enrichment", "enrichment-dlq",
  "market-events", "market-events-dlq",
  "enriched-news", "enriched-news-dlq",
];

const LAMBDAS = ["api", "ingestion", "backfill", "news-backfill", "enrichment"];

async function getTableCount(table: string): Promise<number> {
  try {
    const result = await dynamo.send(new ScanCommand({ TableName: `${PREFIX}-${table}`, Select: "COUNT" }));
    return result.Count ?? 0;
  } catch { return -1; }
}

async function getTableSize(table: string): Promise<number> {
  try {
    const result = await dynamoRaw.send(new DescribeTableCommand({ TableName: `${PREFIX}-${table}` }));
    return result.Table?.TableSizeBytes ?? 0;
  } catch { return 0; }
}

async function getFearGreed(): Promise<{ value: number; classification: string } | null> {
  try {
    const result = await dynamo.send(new GetCommand({
      TableName: `${PREFIX}-ingestion-metadata`,
      Key: { metaKey: "market:fear-greed" },
    }));
    if (!result.Item) return null;
    return { value: result.Item.value as number, classification: result.Item.classification as string };
  } catch (err) {
    console.error("[admin.service] getFearGreed failed:", err);
    return null;
  }
}

async function getEcsStatus(): Promise<{ status: string; running: number; desired: number; taskId?: string }> {
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
  } catch { return { status: "ERROR", running: 0, desired: 0 }; }
}

async function getQueueDepth(queue: string): Promise<{ name: string; messages: number; inflight: number; dlq: boolean }> {
  try {
    const url = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${PREFIX}-${queue}`;
    const result = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }));
    return {
      name: queue,
      messages: parseInt(result.Attributes?.ApproximateNumberOfMessages ?? "0"),
      inflight: parseInt(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0"),
      dlq: queue.endsWith("-dlq"),
    };
  } catch { return { name: queue, messages: -1, inflight: 0, dlq: queue.endsWith("-dlq") }; }
}

async function getRecentLogs(limit = 20): Promise<string[]> {
  try {
    const logGroupName = `/ecs/${PREFIX}-ingestion`;
    const streams = await cwLogs.send(new DescribeLogStreamsCommand({
      logGroupName,
      orderBy: "LastEventTime",
      descending: true,
      limit: 1,
    }));
    const logStreamName = streams.logStreams?.[0]?.logStreamName;
    if (!logStreamName) return ["No log streams found"];
    const events = await cwLogs.send(new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      limit,
      startFromHead: false,
    }));
    return (events.events ?? []).map((e) => e.message ?? "").filter(Boolean);
  } catch (err) { return [`Error: ${(err as Error).message}`]; }
}

async function getLambdaStatus(name: string): Promise<{ name: string; state: string; lastModified: string; size: number }> {
  try {
    const result = await lambda.send(new GetFunctionCommand({ FunctionName: `${PREFIX}-${name}` }));
    return {
      name,
      state: result.Configuration?.State ?? "Unknown",
      lastModified: result.Configuration?.LastModified ?? "",
      size: result.Configuration?.CodeSize ?? 0,
    };
  } catch { return { name, state: "NOT FOUND", lastModified: "", size: 0 }; }
}

export async function getStatus() {
  const [tableCounts, fearGreed, ecsStatus, queueDepths, recentLogs, lambdaStatuses] = await Promise.all([
    Promise.all(TABLES.map(async (t) => ({ name: t, count: await getTableCount(t), size: await getTableSize(t) }))),
    getFearGreed(),
    getEcsStatus(),
    Promise.all(SQS_QUEUES.map((q) => getQueueDepth(q))),
    getRecentLogs(20),
    Promise.all(LAMBDAS.map((l) => getLambdaStatus(l))),
  ]);
  return { tableCounts, fearGreed, ecsStatus, queueDepths, recentLogs, lambdaStatuses, timestamp: new Date().toISOString() };
}

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"];

async function getLatestPrices() {
  const results: Array<Record<string, unknown>> = [];
  for (const pair of PAIRS) {
    try {
      const result = await dynamo.send(new QueryCommand({
        TableName: `${PREFIX}-prices`,
        KeyConditionExpression: "#pair = :pair",
        ExpressionAttributeNames: { "#pair": "pair" },
        ExpressionAttributeValues: { ":pair": pair },
        ScanIndexForward: false,
        Limit: 3,
      }));
      for (const item of result.Items ?? []) results.push(item);
    } catch (err) {
      console.error(`[admin.service] getLatestPrices failed for ${pair}:`, err);
    }
  }
  return results;
}

async function getRecentCandles(pair: string, exchange: string, timeframe: string, limit = 60) {
  try {
    const prefix = `${exchange}#${timeframe}#`;
    const result = await dynamo.send(new QueryCommand({
      TableName: `${PREFIX}-candles`,
      KeyConditionExpression: "#pair = :pair AND begins_with(#sk, :prefix)",
      ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
      ExpressionAttributeValues: { ":pair": pair, ":prefix": prefix },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return ((result.Items ?? []) as Record<string, unknown>[]).reverse();
  } catch (err) {
    console.error(`[admin.service] getRecentCandles failed for ${pair}/${exchange}/${timeframe}:`, err);
    return [];
  }
}

export async function getMarket(pair: string, exchange: string) {
  const [prices, candles, fearGreed] = await Promise.all([
    getLatestPrices(),
    getRecentCandles(pair, exchange, "1m", 60),
    getFearGreed(),
  ]);
  return { prices, candles, fearGreed, pair, exchange };
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

const WHITELIST_PARAM = `/quantara/${ENVIRONMENT}/docs-allowed-ips`;

export async function getWhitelist(): Promise<{ ips: string[] }> {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: WHITELIST_PARAM, WithDecryption: false }));
    const raw = result.Parameter?.Value ?? "";
    const ips = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return { ips };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "ParameterNotFound") return { ips: [] };
    throw err;
  }
}

export async function setWhitelist(ips: string[]): Promise<{ ips: string[] }> {
  const value = ips.join(",");
  await ssm.send(new PutParameterCommand({
    Name: WHITELIST_PARAM,
    Value: value,
    Type: "String",
    Overwrite: true,
  }));
  return { ips };
}
