---
name: quantara-ingestion-source
description: Add or modify a data source in the Quantara ingestion service (ingestion/src/) — exchange streams, news pollers, or future feeds (whale monitoring, on-chain). Use when wiring a new ccxt exchange, news provider, RSS feed, sentiment source, or any periodic/streaming ingestion job. Captures the fetcher → store → SQS → metadata → S3 archive pipeline and how new sources slot into the Fargate service.
---

# quantara-ingestion-source

The ingestion service is a single long-running Node.js process running on Fargate (`ingestion/src/service.ts`). It composes independent sub-services: today, `MarketStreamManager` (ccxt websocket streams) and `NewsPoller` (Alpaca + RSS + Fear & Greed). Each sub-service exposes `start()`, `stop()`, and `getStatus()`. New sources slot in alongside.

There are also Lambda-shaped ingestion handlers in `ingestion/src/*.ts` for backfill / batch jobs (`backfill-handler.ts`, `news-backfill-handler.ts`, `enrichment/handler.ts`).

## The pipeline

```
external API / WS  →  fetcher / stream  →  store (DynamoDB)  →  SQS publish  →  S3 archive (optional)
                                              ↑
                                     metadata-store (cursor)
```

| Stage | Module | Purpose |
|---|---|---|
| Fetch | `<source>.ts` (e.g. `news/cryptopanic.ts`, `exchanges/fetcher.ts`) | Wrap the third-party API. Handle pagination, dedupe in store, not here. |
| Store | `lib/<thing>-store.ts` (e.g. `candle-store`, `news/news-store`, `lib/store.ts`) | DynamoDB BatchWrite (max 25/batch), set TTL, return count of new rows. |
| Publish | `lib/sqs-publisher.ts` → `publish(queueUrl, type, payload)` | Send a `{type, data, timestamp}` envelope to downstream consumers. |
| Cursor | `lib/metadata-store.ts` → `getCursor` / `saveCursor` | Persist last-seen ID/timestamp keyed on `metaKey` (e.g. `news:cryptopanic`). |
| Archive | `lib/s3-archive.ts` | Optional — bulk archive raw payloads for replay. |

## Adding a new source

1. **Fetcher module** in `ingestion/src/<group>/<source>.ts`. Patterns to mirror:
   - `news/cryptopanic.ts`: REST + cursor pagination, SSM-cached API key with env override.
   - `news/alpaca.ts`: REST with credentials + payload normalization helper (`alpacaToNewsRecord`).
   - `news/rss.ts`: pure HTTP, no credentials, multiple feeds in one fetcher.
   - `exchanges/fetcher.ts` + `exchanges/stream.ts`: ccxt; REST fetcher and WebSocket streamer share the same `PriceSnapshot` type.

2. **Store module** if a new shape is needed. Existing stores show the pattern: env-var table name with a `TABLE_PREFIX` fallback, BatchWrite with 25-item batching, TTL via `Math.floor(Date.now() / 1000) + N`, dedupe via a `GetCommand` ProjectionExpression check (see `news-store.ts`) or rely on idempotent put with the same primary key.

3. **Cursor** if the source is incremental. `getCursor("news:<source>")` and `saveCursor({ metaKey, lastTimestamp, status, updatedAt, metadata })` against the `ingestion-metadata` table.

4. **SQS publish** to fan out into downstream analysis. The two main queues today:
   - `ENRICHMENT_QUEUE_URL` — raw news → Bedrock enrichment Lambda.
   - `MARKET_EVENTS_QUEUE_URL` — candle close / ticker events → analysis.
   `enriched_news` queue is downstream of enrichment.

5. **Wire into the service.** Two shapes:

   **Sub-service (continuous):** make a class with `start() / stop() / getStatus()` (see `MarketStreamManager`, `NewsPoller`). Then in `ingestion/src/service.ts`:
   ```ts
   const myService = new MyService();
   startHealthServer(HEALTH_PORT, { getStatus: () => ({ ...marketStream.getStatus(), news: newsPoller.getStatus(), my: myService.getStatus() }) });
   await myService.start();
   ```
   Hook the SIGTERM/SIGINT shutdown sequence too.

   **Backfill (one-shot):** copy `news-backfill-handler.ts` — a Lambda handler invoked on demand or by schedule.

6. **Infrastructure.** A new source typically needs:
   - DynamoDB table (if new shape) — see `quantara-terraform`.
   - SSM SecureString for credentials at `/quantara/<env>/<source>-api-key` — IAM grants are already broad (`/quantara/<env>/*`) for the API Lambda; for Fargate, extend `local.alpaca_ssm_param_arns` style references in `ingestion-fargate.tf`.
   - Env var on the Fargate task in `ingestion-fargate.tf` (`environment` array) and/or new Lambda env block.
   - SQS queue if a new fan-out point is needed.

## Stream conventions (ccxt)

`exchanges/stream.ts` uses `ccxt.pro` for WebSockets. The two loops per pair are `watchTicker` (price snapshots) and `watchOHLCV` (candles). On error: log, sleep 5s, reconnect — the loop runs until `abortController` aborts. A watchdog runs every 60s and warns when a stream hasn't received data in 5 min. Don't block the main loop on store writes — `await` is fine, the loop is one-message-at-a-time.

Symbols differ across exchanges: `getSymbol(exchange, pair)` from `exchanges/config.ts` handles overrides (Coinbase uses `BTC/USD` not `BTC/USDT`). Add new pairs/exchanges to `EXCHANGES` and `PAIRS` constants.

## News conventions

`NewsPoller` polls every 2 min by default. Sources fetched in parallel with `Promise.all`, errors caught per-source so one provider failing doesn't kill the poll. New articles → `news-store.storeNewsRecords` (which dedupes by `(newsId, publishedAt)`) → `publish(ENRICHMENT_QUEUE, "enrich_news", { newsId, publishedAt })` for the first `stored` records. Follow this order — dedupe before SQS, not after.

## Logging

Ingestion still uses `console.log/warn/error` with `[Tag]` prefixes (e.g. `[NewsPoller]`, `[Stream]`). The backend was migrated to pino (commit `52eb8e3`); ingestion has not been migrated yet. Match the existing prefix style for now — when ingestion moves to pino, all sources will move together.

## TTLs

| Data | TTL |
|---|---|
| `prices` | 7 days |
| `candles` 1m | 7 days |
| `candles` 5m / 15m | 30 days |
| `candles` 1h / 4h | 90 days |
| `candles` 1d | 365 days |
| `news-events` | TTL attribute set by source (varies) |
| `signals` | `expiresAt` attribute |

If your new source produces high-volume rows, set a TTL. If it's reference data (curated lists, etc.), don't.

## Don'ts

- Don't put a sub-service in its own process — the Fargate task is intentionally one container with multiple loops, and it's behind one `desired_count = 1`.
- Don't write straight from the fetcher to SQS without going through a store — downstream consumers replay from S3/DynamoDB if SQS messages are dropped.
- Don't introduce a separate AWS SDK — `@aws-sdk/client-{dynamodb,s3,sqs,ssm}` are already in `ingestion/package.json`.
- Don't forget IAM: a new SQS queue or DynamoDB table needs the Fargate task role updated in `ingestion-fargate.tf`.
- Don't poll Aldero for user data here — the ingestion service has no auth context. Read from DynamoDB tables that the API Lambda has populated.
