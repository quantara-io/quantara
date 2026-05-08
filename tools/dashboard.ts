/**
 * Quantara Ops Dashboard — local server that queries AWS and serves a live status page.
 * Usage: npx tsx tools/dashboard.ts
 */
import { createServer } from "node:http";

import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ECSClient, DescribeServicesCommand, ListTasksCommand, DescribeClustersCommand } from "@aws-sdk/client-ecs";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { CloudWatchLogsClient, GetLogEventsCommand, DescribeLogStreamsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient, ListFunctionsCommand, GetFunctionCommand } from "@aws-sdk/client-lambda";

const REGION = "us-west-2";
const PREFIX = "quantara-dev";
const PORT = 3333;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ecs = new ECSClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

const ACCOUNT_ID = "442725244722";

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
    const result = await dynamo.send(new ScanCommand({
      TableName: `${PREFIX}-${table}`,
      Select: "COUNT",
    }));
    return result.Count ?? 0;
  } catch { return -1; }
}

async function getTableSize(table: string): Promise<number> {
  try {
    const result = await new DynamoDBClient({ region: REGION }).send(
      new DescribeTableCommand({ TableName: `${PREFIX}-${table}` })
    );
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
  } catch { return null; }
}

async function getEcsStatus(): Promise<{ status: string; running: number; desired: number; taskId?: string }> {
  try {
    const svc = await ecs.send(new DescribeServicesCommand({
      cluster: `${PREFIX}-ingestion`,
      services: [`${PREFIX}-ingestion`],
    }));
    const service = svc.services?.[0];
    const tasks = await ecs.send(new ListTasksCommand({
      cluster: `${PREFIX}-ingestion`,
      serviceName: `${PREFIX}-ingestion`,
    }));
    return {
      status: service?.status ?? "UNKNOWN",
      running: service?.runningCount ?? 0,
      desired: service?.desiredCount ?? 0,
      taskId: tasks.taskArns?.[0]?.split("/").pop(),
    };
  } catch { return { status: "ERROR", running: 0, desired: 0 }; }
}

async function getQueueDepth(queue: string): Promise<{ messages: number; inflight: number; dlq: boolean }> {
  try {
    const url = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${PREFIX}-${queue}`;
    const result = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }));
    return {
      messages: parseInt(result.Attributes?.ApproximateNumberOfMessages ?? "0"),
      inflight: parseInt(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0"),
      dlq: queue.endsWith("-dlq"),
    };
  } catch { return { messages: -1, inflight: 0, dlq: queue.endsWith("-dlq") }; }
}

async function getRecentLogs(limit = 15): Promise<string[]> {
  try {
    const streams = await logs.send(new DescribeLogStreamsCommand({
      logGroupName: `/ecs/${PREFIX}-ingestion`,
      orderBy: "LastEventTime",
      descending: true,
      limit: 1,
    }));
    const streamName = streams.logStreams?.[0]?.logStreamName;
    if (!streamName) return ["No log streams found"];
    const events = await logs.send(new GetLogEventsCommand({
      logGroupName: `/ecs/${PREFIX}-ingestion`,
      logStreamName: streamName,
      limit,
      startFromHead: false,
    }));
    return (events.events ?? []).map(e => e.message ?? "").filter(Boolean);
  } catch (err) { return [`Error: ${(err as Error).message}`]; }
}

async function getLambdaStatus(name: string): Promise<{ state: string; lastModified: string; size: number }> {
  try {
    const result = await lambda.send(new GetFunctionCommand({ FunctionName: `${PREFIX}-${name}` }));
    return {
      state: result.Configuration?.State ?? "Unknown",
      lastModified: result.Configuration?.LastModified ?? "",
      size: result.Configuration?.CodeSize ?? 0,
    };
  } catch { return { state: "NOT FOUND", lastModified: "", size: 0 }; }
}

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "DOGE/USDT"];
const EXCHANGES_LIST = ["binanceus", "coinbase", "kraken"];

async function getLatestPrices(): Promise<Array<{ pair: string; exchange: string; price: number; bid: number; ask: number; volume24h: number; timestamp: string }>> {
  const results: Array<{ pair: string; exchange: string; price: number; bid: number; ask: number; volume24h: number; timestamp: string }> = [];
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
      for (const item of result.Items ?? []) {
        results.push(item as any);
      }
    } catch { /* skip */ }
  }
  return results;
}

async function getRecentCandles(pair: string, exchange: string, timeframe: string, limit = 60): Promise<Array<{ open: number; high: number; low: number; close: number; volume: number; openTime: number }>> {
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
    return ((result.Items ?? []) as any[]).reverse();
  } catch { return []; }
}

async function getRecentNews(limit = 50): Promise<Array<{ newsId: string; title: string; source: string; publishedAt: string; currencies: string[]; rawSentiment: string; status: string }>> {
  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: `${PREFIX}-news-events`,
      Limit: 200,
    }));
    const items = (result.Items ?? []) as any[];
    items.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    return items.slice(0, limit);
  } catch { return []; }
}

async function collectData() {
  const [
    tableCounts,
    fearGreed,
    ecsStatus,
    queueDepths,
    recentLogs,
    lambdaStatuses,
  ] = await Promise.all([
    Promise.all(TABLES.map(async t => ({ name: t, count: await getTableCount(t), size: await getTableSize(t) }))),
    getFearGreed(),
    getEcsStatus(),
    Promise.all(SQS_QUEUES.map(async q => ({ name: q, ...await getQueueDepth(q) }))),
    getRecentLogs(20),
    Promise.all(LAMBDAS.map(async l => ({ name: l, ...await getLambdaStatus(l) }))),
  ]);

  return { tableCounts, fearGreed, ecsStatus, queueDepths, recentLogs, lambdaStatuses, timestamp: new Date().toISOString() };
}

function renderHTML(data: Awaited<ReturnType<typeof collectData>>): string {
  const fgColor = data.fearGreed
    ? data.fearGreed.value <= 25 ? "#ef4444"
      : data.fearGreed.value <= 45 ? "#f97316"
      : data.fearGreed.value <= 55 ? "#eab308"
      : data.fearGreed.value <= 75 ? "#84cc16"
      : "#22c55e"
    : "#6b7280";

  const ecsColor = data.ecsStatus.running > 0 ? "#22c55e" : "#ef4444";

  const totalRecords = data.tableCounts.reduce((sum, t) => sum + (t.count > 0 ? t.count : 0), 0);
  const totalSizeMB = (data.tableCounts.reduce((sum, t) => sum + t.size, 0) / 1024 / 1024).toFixed(1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>Quantara Ops Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0e17; color: #c8d6e5; padding: 24px; }
  h1 { font-size: 18px; color: #00e5ff; margin-bottom: 4px; display: inline; }
  nav { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #1e293b; }
  nav a { color: #64748b; text-decoration: none; font-size: 12px; margin-right: 16px; padding: 4px 8px; border-radius: 4px; }
  nav a:hover { color: #00e5ff; background: #1e293b; }
  nav a.active { color: #00e5ff; background: #1e293b; }
  .meta { font-size: 11px; color: #475569; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .stat { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #1e293b; font-size: 12px; }
  .stat:last-child { border-bottom: none; }
  .stat .label { color: #94a3b8; }
  .stat .value { color: #e2e8f0; font-weight: 600; }
  .stat .value.green { color: #22c55e; }
  .stat .value.red { color: #ef4444; }
  .stat .value.yellow { color: #eab308; }
  .stat .value.cyan { color: #00e5ff; }
  .hero { display: flex; gap: 16px; margin-bottom: 24px; }
  .hero-card { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 20px; flex: 1; text-align: center; }
  .hero-card .number { font-size: 32px; font-weight: 700; margin: 8px 0 4px; }
  .hero-card .label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
  .logs { background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 16px; margin-top: 16px; }
  .logs h2 { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .log-line { font-size: 11px; color: #94a3b8; padding: 3px 0; border-bottom: 1px solid #0a0e17; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .log-line .tag { color: #00e5ff; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .pulse { animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
</head>
<body>

<nav>
  <h1>QUANTARA</h1>
  <a href="/" class="active">Ops</a>
  <a href="/market">Market</a>
  <a href="/news">News</a>
</nav>
<p class="meta">Auto-refreshes every 30s &middot; Last update: ${data.timestamp} &middot; Environment: dev</p>

<div class="hero">
  <div class="hero-card">
    <div class="label">Fargate Service</div>
    <div class="number" style="color:${ecsColor}">
      <span class="dot pulse" style="background:${ecsColor}"></span>
      ${data.ecsStatus.running > 0 ? "RUNNING" : "DOWN"}
    </div>
    <div class="label">${data.ecsStatus.running}/${data.ecsStatus.desired} tasks${data.ecsStatus.taskId ? ` &middot; ${data.ecsStatus.taskId.slice(0, 8)}` : ""}</div>
  </div>
  <div class="hero-card">
    <div class="label">Fear & Greed Index</div>
    <div class="number" style="color:${fgColor}">${data.fearGreed?.value ?? "—"}</div>
    <div class="label">${data.fearGreed?.classification ?? "Unknown"}</div>
  </div>
  <div class="hero-card">
    <div class="label">Total Records</div>
    <div class="number" style="color:#00e5ff">${totalRecords.toLocaleString()}</div>
    <div class="label">${totalSizeMB} MB across ${TABLES.length} tables</div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>DynamoDB Tables</h2>
    ${data.tableCounts.map(t => {
      const color = t.count < 0 ? "red" : t.count > 1000 ? "green" : t.count > 0 ? "cyan" : "yellow";
      return `<div class="stat"><span class="label">${t.name}</span><span class="value ${color}">${t.count < 0 ? "ERROR" : t.count.toLocaleString()}</span></div>`;
    }).join("\n    ")}
  </div>

  <div class="card">
    <h2>SQS Queues</h2>
    ${data.queueDepths.map(q => {
      const color = q.messages < 0 ? "red" : q.dlq && q.messages > 0 ? "red" : q.messages > 0 ? "yellow" : "green";
      const icon = q.dlq ? " (DLQ)" : "";
      return `<div class="stat"><span class="label">${q.name}${icon}</span><span class="value ${color}">${q.messages < 0 ? "ERROR" : `${q.messages} msg / ${q.inflight} inflight`}</span></div>`;
    }).join("\n    ")}
  </div>

  <div class="card">
    <h2>Lambda Functions</h2>
    ${data.lambdaStatuses.map(l => {
      const color = l.state === "Active" ? "green" : l.state === "NOT FOUND" ? "red" : "yellow";
      const modified = l.lastModified ? new Date(l.lastModified).toLocaleString() : "—";
      const sizeMB = (l.size / 1024 / 1024).toFixed(1);
      return `<div class="stat"><span class="label">${l.name} (${sizeMB}MB)</span><span class="value ${color}">${l.state} &middot; ${modified}</span></div>`;
    }).join("\n    ")}
  </div>

  <div class="card">
    <h2>Ingestion Streams</h2>
    <div class="stat"><span class="label">Exchanges</span><span class="value cyan">Binance US, Coinbase, Kraken</span></div>
    <div class="stat"><span class="label">Pairs</span><span class="value cyan">BTC, ETH, SOL, XRP, DOGE</span></div>
    <div class="stat"><span class="label">Transport</span><span class="value green">WebSocket (CCXT Pro)</span></div>
    <div class="stat"><span class="label">News Sources</span><span class="value cyan">Alpaca, CoinTelegraph, Decrypt, CoinDesk</span></div>
    <div class="stat"><span class="label">News Interval</span><span class="value">Every 2 min</span></div>
    <div class="stat"><span class="label">F&G Interval</span><span class="value">Every 1 hour</span></div>
  </div>
</div>

<div class="logs">
  <h2>Recent Fargate Logs</h2>
  ${data.recentLogs.map(line => {
    const escaped = line.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const highlighted = escaped.replace(/\[(.*?)\]/g, '<span class="tag">[$1]</span>');
    return `<div class="log-line">${highlighted}</div>`;
  }).join("\n  ")}
</div>

</body>
</html>`;
}

function renderMarketHTML(
  prices: Awaited<ReturnType<typeof getLatestPrices>>,
  candles: Awaited<ReturnType<typeof getRecentCandles>>,
  fearGreed: Awaited<ReturnType<typeof getFearGreed>>,
  selectedPair: string,
  selectedExchange: string,
): string {
  // Group prices by pair, pick latest per exchange
  const byPair: Record<string, Array<{ exchange: string; price: number; bid: number; ask: number; volume24h: number; timestamp: string }>> = {};
  for (const p of prices) {
    if (!byPair[p.pair]) byPair[p.pair] = [];
    byPair[p.pair].push(p);
  }

  const fgColor = fearGreed
    ? fearGreed.value <= 25 ? "#ef4444"
      : fearGreed.value <= 45 ? "#f97316"
      : fearGreed.value <= 55 ? "#eab308"
      : fearGreed.value <= 75 ? "#84cc16"
      : "#22c55e"
    : "#6b7280";

  // Build simple candlestick SVG
  const candleSvg = buildCandleSvg(candles);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="15">
<title>Quantara — Market Data</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0e17; color: #c8d6e5; padding: 24px; }
  h1 { font-size: 18px; color: #00e5ff; margin-bottom: 4px; display: inline; }
  nav { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #1e293b; }
  nav a { color: #64748b; text-decoration: none; font-size: 12px; margin-right: 16px; padding: 4px 8px; border-radius: 4px; }
  nav a:hover { color: #00e5ff; background: #1e293b; }
  nav a.active { color: #00e5ff; background: #1e293b; }
  .meta { font-size: 11px; color: #475569; margin-bottom: 24px; }
  .price-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .price-card { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 16px; }
  .price-card .pair { font-size: 14px; font-weight: 700; color: #00e5ff; margin-bottom: 8px; }
  .price-card .exchange-row { display: flex; justify-content: space-between; font-size: 11px; padding: 4px 0; border-bottom: 1px solid #0a0e17; }
  .price-card .exchange-row:last-child { border-bottom: none; }
  .price-card .exchange-name { color: #64748b; }
  .price-card .price-val { color: #e2e8f0; font-weight: 600; }
  .price-card .spread { color: #475569; font-size: 10px; }
  .chart-section { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
  .chart-section h2 { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .chart-section .chart-meta { font-size: 11px; color: #475569; margin-bottom: 16px; }
  .pair-selector { margin-bottom: 16px; }
  .pair-selector a { color: #64748b; text-decoration: none; font-size: 11px; margin-right: 8px; padding: 4px 10px; border: 1px solid #1e293b; border-radius: 4px; }
  .pair-selector a:hover, .pair-selector a.sel { color: #00e5ff; border-color: #00e5ff; }
  .fg-badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: 700; margin-left: 12px; }
</style>
</head>
<body>

<nav>
  <h1>QUANTARA</h1>
  <a href="/">Ops</a>
  <a href="/market" class="active">Market</a>
  <a href="/news">News</a>
</nav>
<p class="meta">
  Auto-refreshes every 15s &middot; Live WebSocket data
  <span class="fg-badge" style="background:${fgColor}22;color:${fgColor}">F&G: ${fearGreed?.value ?? "—"} ${fearGreed?.classification ?? ""}</span>
</p>

<div class="price-grid">
${PAIRS.map(pair => {
  const exchanges = byPair[pair] ?? [];
  return `  <div class="price-card">
    <div class="pair">${pair.replace("/USDT", "")}<span style="color:#475569;font-size:11px;font-weight:400"> /USDT</span></div>
    ${exchanges.length === 0 ? '<div class="exchange-row"><span class="exchange-name">No data</span></div>' :
    exchanges.map(e => {
      const spread = e.ask && e.bid ? ((e.ask - e.bid) / e.bid * 100).toFixed(3) : "—";
      return `<div class="exchange-row">
      <span class="exchange-name">${e.exchange}</span>
      <span class="price-val">$${e.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      <span class="spread">${spread}% spread</span>
    </div>`;
    }).join("\n    ")}
  </div>`;
}).join("\n")}
</div>

<div class="pair-selector">
  ${PAIRS.map(p => `<a href="/market?pair=${encodeURIComponent(p)}&exchange=${selectedExchange}" class="${p === selectedPair ? 'sel' : ''}">${p.replace("/USDT","")}</a>`).join("")}
  &nbsp;&middot;&nbsp;
  ${EXCHANGES_LIST.map(e => `<a href="/market?pair=${encodeURIComponent(selectedPair)}&exchange=${e}" class="${e === selectedExchange ? 'sel' : ''}">${e}</a>`).join("")}
</div>

<div class="chart-section">
  <h2>Candlestick — ${selectedPair} @ ${selectedExchange}</h2>
  <div class="chart-meta">${candles.length} candles (1-minute) &middot; Most recent on the right</div>
  ${candleSvg}
</div>

</body>
</html>`;
}

function buildCandleSvg(candles: Array<{ open: number; high: number; low: number; close: number; volume: number; openTime: number }>): string {
  if (candles.length === 0) return '<p style="color:#475569;font-size:12px;">No candle data available for this pair/exchange.</p>';

  const W = 1100;
  const H = 320;
  const PAD = 40;
  const chartW = W - PAD * 2;
  const chartH = H - PAD * 2;

  const allHighs = candles.map(c => c.high);
  const allLows = candles.map(c => c.low);
  const maxPrice = Math.max(...allHighs);
  const minPrice = Math.min(...allLows);
  const priceRange = maxPrice - minPrice || 1;

  const barW = Math.max(2, Math.floor(chartW / candles.length) - 2);
  const gap = Math.max(1, Math.floor((chartW - barW * candles.length) / (candles.length)));

  function yPos(price: number): number {
    return PAD + chartH - ((price - minPrice) / priceRange) * chartH;
  }

  let bars = "";
  candles.forEach((c, i) => {
    const x = PAD + i * (barW + gap) + gap / 2;
    const isGreen = c.close >= c.open;
    const color = isGreen ? "#22c55e" : "#ef4444";
    const bodyTop = yPos(Math.max(c.open, c.close));
    const bodyBot = yPos(Math.min(c.open, c.close));
    const bodyH = Math.max(1, bodyBot - bodyTop);
    const wickX = x + barW / 2;

    // Wick
    bars += `<line x1="${wickX}" y1="${yPos(c.high)}" x2="${wickX}" y2="${yPos(c.low)}" stroke="${color}" stroke-width="1"/>`;
    // Body
    bars += `<rect x="${x}" y="${bodyTop}" width="${barW}" height="${bodyH}" fill="${color}" rx="1"/>`;
  });

  // Y-axis labels
  const steps = 5;
  let yLabels = "";
  for (let i = 0; i <= steps; i++) {
    const price = minPrice + (priceRange * i) / steps;
    const y = yPos(price);
    yLabels += `<text x="${PAD - 4}" y="${y + 3}" text-anchor="end" fill="#475569" font-size="9" font-family="monospace">$${price.toFixed(2)}</text>`;
    yLabels += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#1e293b" stroke-width="0.5"/>`;
  }

  // Time labels
  let tLabels = "";
  const labelEvery = Math.max(1, Math.floor(candles.length / 6));
  candles.forEach((c, i) => {
    if (i % labelEvery === 0) {
      const x = PAD + i * (barW + gap) + barW / 2;
      const d = new Date(c.openTime);
      const label = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
      tLabels += `<text x="${x}" y="${H - 8}" text-anchor="middle" fill="#475569" font-size="9" font-family="monospace">${label}</text>`;
    }
  });

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;background:#0a0e17;border-radius:6px;">
    ${yLabels}
    ${bars}
    ${tLabels}
  </svg>`;
}

function renderNewsHTML(news: Awaited<ReturnType<typeof getRecentNews>>, fearGreed: Awaited<ReturnType<typeof getFearGreed>>): string {
  const fgColor = fearGreed
    ? fearGreed.value <= 25 ? "#ef4444"
      : fearGreed.value <= 45 ? "#f97316"
      : fearGreed.value <= 55 ? "#eab308"
      : fearGreed.value <= 75 ? "#84cc16"
      : "#22c55e"
    : "#6b7280";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>Quantara — News Feed</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0e17; color: #c8d6e5; padding: 24px; }
  h1 { font-size: 18px; color: #00e5ff; margin-bottom: 4px; display: inline; }
  nav { margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #1e293b; }
  nav a { color: #64748b; text-decoration: none; font-size: 12px; margin-right: 16px; padding: 4px 8px; border-radius: 4px; }
  nav a:hover { color: #00e5ff; background: #1e293b; }
  nav a.active { color: #00e5ff; background: #1e293b; }
  .meta { font-size: 11px; color: #475569; margin-bottom: 24px; }
  .fg-badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: 700; margin-left: 12px; }
  .news-list { max-width: 900px; }
  .news-item { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; }
  .news-item .news-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .news-item .news-title { font-size: 13px; color: #e2e8f0; font-weight: 500; line-height: 1.4; flex: 1; }
  .news-item .news-title a { color: #e2e8f0; text-decoration: none; }
  .news-item .news-title a:hover { color: #00e5ff; }
  .news-item .news-meta { font-size: 10px; color: #475569; display: flex; gap: 12px; align-items: center; }
  .news-item .news-source { color: #64748b; font-weight: 600; }
  .news-item .news-time { color: #475569; }
  .tag-pill { display: inline-block; padding: 1px 6px; background: #1e293b; border-radius: 3px; font-size: 9px; color: #00e5ff; margin-right: 4px; }
  .sentiment { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 3px; }
  .sentiment.bullish { color: #22c55e; background: #22c55e22; }
  .sentiment.bearish { color: #ef4444; background: #ef444422; }
  .sentiment.neutral { color: #eab308; background: #eab30822; }
  .status-pill { font-size: 9px; padding: 2px 6px; border-radius: 3px; }
  .status-pill.raw { color: #f97316; background: #f9731622; }
  .status-pill.enriched { color: #22c55e; background: #22c55e22; }
  .status-pill.failed { color: #ef4444; background: #ef444422; }
  .stats-row { display: flex; gap: 16px; margin-bottom: 20px; }
  .stats-row .stat-box { background: #111827; border: 1px solid #1e293b; border-radius: 8px; padding: 12px 20px; text-align: center; }
  .stats-row .stat-num { font-size: 24px; font-weight: 700; color: #00e5ff; }
  .stats-row .stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
</style>
</head>
<body>

<nav>
  <h1>QUANTARA</h1>
  <a href="/">Ops</a>
  <a href="/market">Market</a>
  <a href="/news" class="active">News</a>
</nav>
<p class="meta">
  ${news.length} articles &middot; Auto-refreshes every 30s
  <span class="fg-badge" style="background:${fgColor}22;color:${fgColor}">F&G: ${fearGreed?.value ?? "—"} ${fearGreed?.classification ?? ""}</span>
</p>

<div class="stats-row">
  <div class="stat-box">
    <div class="stat-num">${news.length}</div>
    <div class="stat-label">Total Articles</div>
  </div>
  <div class="stat-box">
    <div class="stat-num">${news.filter(n => n.status === "enriched").length}</div>
    <div class="stat-label">Enriched</div>
  </div>
  <div class="stat-box">
    <div class="stat-num">${news.filter(n => n.status === "raw").length}</div>
    <div class="stat-label">Awaiting Enrichment</div>
  </div>
  <div class="stat-box">
    <div class="stat-num">${new Set(news.map(n => n.source)).size}</div>
    <div class="stat-label">Sources</div>
  </div>
</div>

<div class="news-list">
${news.map(n => {
  const time = n.publishedAt ? new Date(n.publishedAt).toLocaleString() : "—";
  const currencies = (n.currencies ?? []).slice(0, 6);
  const sentimentClass = n.rawSentiment === "bullish" ? "bullish" : n.rawSentiment === "bearish" ? "bearish" : "neutral";
  const escaped = (n.title ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `  <div class="news-item">
    <div class="news-header">
      <div class="news-title">${escaped}</div>
    </div>
    <div class="news-meta">
      <span class="news-source">${n.source ?? "unknown"}</span>
      <span class="news-time">${time}</span>
      <span class="sentiment ${sentimentClass}">${n.rawSentiment ?? "neutral"}</span>
      <span class="status-pill ${n.status ?? "raw"}">${n.status ?? "raw"}</span>
      ${currencies.map(c => `<span class="tag-pill">${c}</span>`).join("")}
    </div>
  </div>`;
}).join("\n")}
</div>

</body>
</html>`;
}

const server = createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/dashboard") {
    try {
      console.log(`[Dashboard] Fetching data...`);
      const data = await collectData();
      const html = renderHTML(data);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      console.log(`[Dashboard] Served. ${data.tableCounts.reduce((s, t) => s + (t.count > 0 ? t.count : 0), 0).toLocaleString()} total records.`);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${(err as Error).message}`);
    }
  } else if (req.url?.startsWith("/market")) {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const selectedPair = url.searchParams.get("pair") || "BTC/USDT";
      const selectedExchange = url.searchParams.get("exchange") || "binanceus";
      console.log(`[Dashboard] Fetching market data for ${selectedPair}@${selectedExchange}...`);
      const [prices, candles, fearGreed] = await Promise.all([
        getLatestPrices(),
        getRecentCandles(selectedPair, selectedExchange, "1m", 60),
        getFearGreed(),
      ]);
      const html = renderMarketHTML(prices, candles, fearGreed, selectedPair, selectedExchange);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      console.log(`[Dashboard] Market page served. ${prices.length} prices, ${candles.length} candles.`);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${(err as Error).message}`);
    }
  } else if (req.url === "/news") {
    try {
      console.log(`[Dashboard] Fetching news...`);
      const [news, fearGreed] = await Promise.all([getRecentNews(50), getFearGreed()]);
      const html = renderNewsHTML(news, fearGreed);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      console.log(`[Dashboard] News page served. ${news.length} articles.`);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${(err as Error).message}`);
    }
  } else if (req.url === "/api/status") {
    try {
      const data = await collectData();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  } else {
    res.writeHead(302, { Location: "/" });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n  Quantara Ops Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});
