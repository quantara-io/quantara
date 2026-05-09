import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  minify: true,
  external: [
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/util-dynamodb",
    "@aws-sdk/lib-dynamodb",
    "@aws-sdk/client-s3",
    "@aws-sdk/client-sqs",
    "@aws-sdk/client-ssm",
    "@aws-sdk/client-bedrock-runtime",
    "@aws-sdk/client-apigatewaymanagementapi",
    "ccxt",
  ],
};

// Lambda: scheduled price ingestion
await build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

// Lambda: historical backfill
await build({
  ...shared,
  entryPoints: ["src/backfill-handler.ts"],
  outfile: "dist/backfill-handler.js",
});

// Lambda: news backfill
await build({
  ...shared,
  entryPoints: ["src/news-backfill-handler.ts"],
  outfile: "dist/news-backfill-handler.js",
});

// Lambda: SQS-triggered Bedrock enrichment
await build({
  ...shared,
  entryPoints: ["src/enrichment/handler.ts"],
  outfile: "dist/enrichment-handler.js",
});

// Lambda: indicator computation + scoring + blending (Phase 4b)
await build({
  ...shared,
  entryPoints: ["src/indicator-handler.ts"],
  outfile: "dist/indicator-handler.js",
});

// Lambda: SQS-triggered sentiment aggregation + EventBridge fallback (Phase 5b)
await build({
  ...shared,
  entryPoints: ["src/aggregator-handler.ts"],
  outfile: "dist/aggregator-handler.js",
});

// Lambda: close-quorum monitor — emits CloseMissed metric on TTL expiry (v6 P2 §11.5)
await build({
  ...shared,
  entryPoints: ["src/handlers/close-quorum-monitor.ts"],
  outfile: "dist/close-quorum-monitor.js",
});

// Lambda: higher-TF poller — produces live 15m/1h/4h/1d candles via fetchOHLCV.
// Required by v6 §5.9 + §12.3 — without this, no candles match the indicator
// FilterCriteria (timeframe in {15m,1h,4h,1d} AND source = "live") and zero signals fire.
await build({
  ...shared,
  entryPoints: ["src/higher-tf-poller-handler.ts"],
  outfile: "dist/higher-tf-poller-handler.js",
});

// Fargate: long-running streaming service
await build({
  ...shared,
  entryPoints: ["src/service.ts"],
  outfile: "dist/service.js",
});

// Lambda: WebSocket $connect — JWT verify + connection-registry write (§16)
await build({
  ...shared,
  entryPoints: ["src/ws-connect-handler.ts"],
  outfile: "dist/ws-connect-handler.js",
});

// Lambda: WebSocket $disconnect — connection-registry delete (§16)
await build({
  ...shared,
  entryPoints: ["src/ws-disconnect-handler.ts"],
  outfile: "dist/ws-disconnect-handler.js",
});

// Lambda: DDB Streams fanout — push ratified signals to WebSocket subscribers (§16)
// IMPORTANT: subscribed to `signals` table (ratified), NOT `signals-v2` (pre-ratification).
await build({
  ...shared,
  entryPoints: ["src/signals-fanout.ts"],
  outfile: "dist/signals-fanout.js",
});

console.log(
  "Build complete: dist/index.js, dist/backfill-handler.js, dist/news-backfill-handler.js, dist/enrichment-handler.js, dist/indicator-handler.js, dist/aggregator-handler.js, dist/close-quorum-monitor.js, dist/higher-tf-poller-handler.js, dist/service.js, dist/ws-connect-handler.js, dist/ws-disconnect-handler.js, dist/signals-fanout.js",
);
