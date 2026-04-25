---
name: quantara-dynamodb-access
description: Read or write Quantara's DynamoDB tables from backend or ingestion code. Use when querying users, signals, candles, prices, news, coach, deals, deal-interests, campaigns, or ingestion-metadata. Encodes the table list, key schemas, GSIs, env-var → table-name conventions, BatchWrite / TTL patterns, and where store helpers already exist so you don't reimplement them.
---

# quantara-dynamodb-access

All Quantara persistence is DynamoDB. There are 12 tables, all defined in `backend/infra/modules/quantara-backend/dynamodb.tf`. Naming is `quantara-${env}-${name}` — the application reads table names from env vars (`TABLE_USERS`, `TABLE_CANDLES`, etc.) with a `${TABLE_PREFIX}<name>` fallback for local dev.

## Table inventory

| Table | Hash / Range | GSIs | TTL | Purpose |
|---|---|---|---|---|
| `users` | `userId` | `email-index` (email) | — | User profile cache (auth lives in Aldero) |
| `signals` | `pair` / `createdAt` | — | `expiresAt` | Live trading signals |
| `signal-history` | `pair` / `signalId` | — | — | Signal audit trail |
| `coach-sessions` | `userId` / `sessionId` | — | — | AI coach sessions |
| `coach-messages` | `sessionId` / `messageId` | — | — | Messages within a session |
| `deals` | `dealId` | `author-index` (authorId/createdAt) | — | Dealflow listings |
| `deal-interests` | `dealId` / `userId` | — | — | "I'm interested" join table |
| `campaigns` | `userId` / `campaignId` | — | — | Marketing campaigns |
| `prices` | `pair` / `timestamp` | — | `ttl` (7d) | Real-time price snapshots from ccxt |
| `candles` | `pair` / `sk` (`exchange#timeframe#iso`) | `exchange-index` | `ttl` (per timeframe) | OHLCV candles |
| `news-events` | `newsId` / `publishedAt` | `currency-index` | `ttl` | News articles |
| `ingestion-metadata` | `metaKey` | — | — | Ingestion cursors |

The `signals` table has TTL on `expiresAt`; `prices` / `candles` / `news-events` have TTL on `ttl` (Unix seconds — `Math.floor(Date.now() / 1000) + N`).

## Reading the right env var

Always read `process.env.TABLE_<NAME>` with a `TABLE_PREFIX` fallback — never hardcode the table name:

```ts
const PRICES_TABLE = process.env.TABLE_PRICES ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}prices`;
```

The fallback is for local `npm run dev` (which sets `TABLE_PREFIX=quantara-dev-`). In Lambda and ECS, the explicit `TABLE_<NAME>` env var is set by Terraform (see `lambda.tf` and `ingestion-fargate.tf`).

## Existing store helpers — use these, don't reimplement

| Store | Operations |
|---|---|
| `ingestion/src/lib/store.ts` | `storePriceSnapshots`, `getLatestPrices` |
| `ingestion/src/lib/candle-store.ts` | `storeCandles`, `getCandles` |
| `ingestion/src/lib/metadata-store.ts` | `getCursor`, `saveCursor` |
| `ingestion/src/news/news-store.ts` | `storeNewsRecords` (dedupes) |

The backend has no equivalent helpers yet — read/write from route handlers via the AWS SDK directly (or factor a `backend/src/lib/<table>-store.ts` if the access pattern is non-trivial). Same conventions apply.

## SDK setup

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
```

Always `DynamoDBDocumentClient` — it does the marshalling. Constructor takes no region/credentials (picked up from the runtime).

## BatchWrite

DynamoDB caps BatchWrite at **25 items per request**. The pattern (from `candle-store.ts`):

```ts
const batches: Item[][] = [];
for (let i = 0; i < items.length; i += 25) batches.push(items.slice(i, i + 25));
for (const batch of batches) {
  await client.send(new BatchWriteCommand({
    RequestItems: { [TABLE]: batch.map((item) => ({ PutRequest: { Item: { ...item } } })) },
  }));
}
```

Don't loop over single `PutCommand` for bulk writes — burns request units and is slow. Don't try `BatchWriteCommand` with > 25 items in one call.

## Query patterns

Queries always need a hash key. `prices` and `candles` use `pair` as the partition key — use `Limit` and `ScanIndexForward: false` to get the latest:

```ts
new QueryCommand({
  TableName: CANDLES_TABLE,
  KeyConditionExpression: "#pair = :pair AND begins_with(#sk, :prefix)",
  ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
  ExpressionAttributeValues: { ":pair": pair, ":prefix": `${exchange}#${timeframe}#` },
  ScanIndexForward: false,
  Limit: limit,
});
```

For lookup by email (users table), use the GSI: `IndexName: "email-index"`, hash on `email`. Same for `author-index` on deals.

## Dedupe pattern (news)

If your insert has a natural unique key but no upsert semantics, dedupe with a `GetCommand` ProjectionExpression check first (cheap):

```ts
const existing = await client.send(new GetCommand({
  TableName: NEWS_TABLE,
  Key: { newsId: r.newsId, publishedAt: r.publishedAt },
  ProjectionExpression: "newsId",
}));
if (!existing.Item) newRecords.push(r);
```

For idempotent writes where re-writing the same row is fine, skip the check — `PutCommand` overwrites by primary key.

## TTL writes

Set the `ttl` attribute (or domain-specific `expiresAt` on `signals`) as an integer Unix-seconds timestamp:

```ts
ttl: Math.floor(Date.now() / 1000) + 86400 * 7,  // 7 days
```

DynamoDB sweeps within ~48h after expiry — assume eventual deletion, not exact.

## Sort-key composition

`candles` uses a composite SK: `${exchange}#${timeframe}#${iso8601}`. This lets one Query return all timeframes for a pair, all candles for an exchange/timeframe, or a slice of either. Mirror this approach when adding tables that need multi-attribute sort.

## IAM gotcha

If you read/write a new table from the API Lambda or Fargate task, **the IAM policy must include it**, including `${arn}/index/*` for any GSIs. See `quantara-terraform` — this is the most common failure when adding a table.

## Don'ts

- Don't `Scan` in production code paths — every existing read is a `Query` or `GetItem`.
- Don't compose table names with raw string concatenation other than the `TABLE_PREFIX` pattern above.
- Don't put binary data in DynamoDB — archive raw payloads to S3 (`lib/s3-archive.ts`) and store the key.
- Don't `BatchWrite` heterogeneous tables in one call (the SDK supports it but it's a debugging trap).
- Don't write a custom marshaller — `DynamoDBDocumentClient` handles JS objects directly.
