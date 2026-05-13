/**
 * Fargate backtest runner — Phase 4 (issue #371).
 *
 * Long-running worker process that:
 *   1. Polls the backtest-jobs SQS queue (20s long-poll)
 *   2. Parses the job body — the BacktestInput shape persisted by
 *      backend/src/routes/admin.ts:POST /admin/backtest
 *   3. Marks the DDB row `status=running`, emits `backtest-started`
 *   4. Loads the strategy from `backtest/strategies/<name>.ts` via the
 *      static registry in `strategies-registry.ts`
 *   5. Constructs the engine with DdbCandleStore + the appropriate
 *      Ratifier (per `ratificationMode`)
 *   6. Runs the backtest. Emits `backtest-progress` at 0/25/50/75/100%.
 *   7. Builds the same Phase 3 outputs the CLI builds (summary.md,
 *      metrics.json, trades.csv, equity-curve.csv, per-rule-attribution.csv,
 *      calibration-by-bin.csv) and uploads them to S3 under `<runId>/`
 *   8. Updates the DDB row to status=done with actualCostUsd,
 *      metricsSummary, s3ResultPrefix. Emits `backtest-completed`.
 *   9. Deletes the SQS message.
 *  10. On error: status=failed, emit `backtest-failed`, delete the message
 *      (do not infinite-retry — the operator can resubmit).
 *
 * Resolves PR #376 review finding 1 (no runner source / Dockerfile / CI build).
 */

import { randomUUID } from "node:crypto";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PipelineEvent } from "@quantara/shared";

import { BacktestEngine, type BacktestInput, type BacktestResult } from "../engine.js";
import { DdbCandleStore } from "../store/ddb-candle-store.js";
import { simulateEquityCurve, extractDrawdownPeriods } from "../equity/simulator.js";
import { computeRuleAttribution } from "../attribution/compute.js";
import { computeCalibrationBins } from "../calibration/bins.js";
import { equityCurveToCsv, ruleAttributionToCsv, calibrationBinsToCsv } from "../output/csv.js";
import { generateMarkdownReport } from "../report/markdown.js";
import { BedrockInvokerImpl, DdbRatificationsLookup } from "../ratification/ratifier.js";
import { getStrategy } from "../strategies-registry.js";
import type { RatificationModel } from "../cost/estimator-pure.js";
import type { Timeframe } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Module-scope clients (process-lifetime) and config
// ---------------------------------------------------------------------------

const REGION = process.env.AWS_REGION ?? "us-west-2";
const sqs = new SQSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const JOBS_QUEUE_URL = process.env.BACKTEST_JOBS_QUEUE_URL ?? "";
const RESULTS_BUCKET = process.env.BACKTEST_RESULTS_BUCKET ?? "";
const RUNS_TABLE =
  process.env.TABLE_BACKTEST_RUNS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}backtest-runs`;
const PIPELINE_EVENTS_TABLE =
  process.env.TABLE_PIPELINE_EVENTS ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}pipeline-events`;

/** Receive batch size — 1 keeps job tracking simple; scale-out is horizontal. */
const RECEIVE_MAX_MESSAGES = 1;
/** Long-poll wait — ECS task scales on queue depth so 20s is fine. */
const WAIT_TIME_SECONDS = 20;

// ---------------------------------------------------------------------------
// Job payload shape (must match what admin.ts persists to SQS)
// ---------------------------------------------------------------------------

interface BacktestJobMessage {
  runId: string;
  strategy: string;
  baseline?: string;
  pair: string;
  timeframe: string;
  from: string;
  to: string;
  ratificationMode: "none" | "skip-bedrock" | "replay-bedrock";
  model?: RatificationModel;
  s3ResultPrefix: string;
}

// ---------------------------------------------------------------------------
// Pipeline-events helper (mirrors backend / ingestion writers)
// ---------------------------------------------------------------------------

const PIPELINE_TTL_SECONDS = 86_400; // 24h

async function emitEvent(event: PipelineEvent): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: PIPELINE_EVENTS_TABLE,
        Item: {
          eventId: randomUUID(),
          ttl: Math.floor(Date.now() / 1000) + PIPELINE_TTL_SECONDS,
          ...event,
        },
      }),
    );
  } catch (err) {
    // Never block the run on a pipeline-events failure.
    console.warn(`[runner] failed to emit ${event.type}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// DDB updates for backtest-runs (atomic mutators)
// ---------------------------------------------------------------------------

async function markRunning(runId: string, startedAt: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: RUNS_TABLE,
      Key: { runId },
      UpdateExpression: "SET #status = :s, startedAt = :ts, updatedAt = :ts",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":s": "running", ":ts": startedAt },
    }),
  );
}

async function markCompleted(
  runId: string,
  completedAt: string,
  extra: {
    actualCostUsd: number;
    metricsSummary: Record<string, unknown>;
    s3ResultPrefix: string;
  },
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: RUNS_TABLE,
      Key: { runId },
      UpdateExpression:
        "SET #status = :s, completedAt = :ts, updatedAt = :ts, " +
        "actualCostUsd = :cost, metricsSummary = :metrics, s3ResultPrefix = :prefix",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":s": "done",
        ":ts": completedAt,
        ":cost": extra.actualCostUsd,
        ":metrics": extra.metricsSummary,
        ":prefix": extra.s3ResultPrefix,
      },
    }),
  );
}

async function markFailed(runId: string, reason: string): Promise<void> {
  const ts = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: RUNS_TABLE,
        Key: { runId },
        UpdateExpression:
          "SET #status = :s, completedAt = :ts, updatedAt = :ts, failureReason = :reason",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":s": "failed", ":ts": ts, ":reason": reason },
      }),
    );
  } catch (err) {
    console.error(`[runner] failed to mark run ${runId} as failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// S3 artifact upload
// ---------------------------------------------------------------------------

async function uploadArtifact(key: string, body: string, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: RESULTS_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

// ---------------------------------------------------------------------------
// Trades CSV (the runner builds this — the CLI references the path but
// the writer wasn't exported. Mirrors the markdown report's expectations.)
// ---------------------------------------------------------------------------

function tradesToCsv(result: BacktestResult): string {
  const header = [
    "emittedAt",
    "closeTime",
    "pair",
    "timeframe",
    "type",
    "confidence",
    "rulesFired",
    "gateReason",
    "resolvedAt",
    "outcome",
    "priceMovePct",
    "priceAtSignal",
    "priceAtResolution",
    "expiresAt",
    "ratificationStatus",
    "ratifiedType",
    "ratifiedConfidence",
    "verdictKind",
  ].join(",");
  const rows = result.signals.map((s) => {
    const esc = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const str = String(v);
      return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    };
    return [
      s.emittedAt,
      s.closeTime,
      s.pair,
      s.timeframe,
      s.type,
      s.confidence.toFixed(6),
      esc(s.rulesFired.join("|")),
      s.gateReason ?? "",
      s.resolvedAt ?? "",
      s.outcome ?? "",
      s.priceMovePct !== null ? s.priceMovePct.toFixed(6) : "",
      s.priceAtSignal.toFixed(6),
      s.priceAtResolution !== null ? s.priceAtResolution.toFixed(6) : "",
      s.expiresAt,
      s.ratificationStatus,
      s.ratifiedType ?? "",
      s.ratifiedConfidence !== undefined ? s.ratifiedConfidence.toFixed(6) : "",
      s.verdictKind ?? "",
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Build the BacktestInput from the SQS message + run the engine
// ---------------------------------------------------------------------------

/** Map admin ratificationMode → engine RatificationMode. */
function mapMode(mode: BacktestJobMessage["ratificationMode"]): BacktestInput["ratification"] {
  if (mode === "none") return "skip";
  if (mode === "skip-bedrock") return "skip";
  return "replay-bedrock";
}

async function processJob(
  msg: BacktestJobMessage,
  candleStore: DdbCandleStore,
): Promise<{ result: BacktestResult; baselineResult?: BacktestResult }> {
  const strategy = getStrategy(msg.strategy);
  if (!strategy) {
    throw new Error(`unknown strategy: ${msg.strategy}`);
  }
  const baseline = msg.baseline ? getStrategy(msg.baseline) : undefined;
  if (msg.baseline && !baseline) {
    throw new Error(`unknown baseline strategy: ${msg.baseline}`);
  }

  const engine = new BacktestEngine(candleStore);

  const ratification = mapMode(msg.ratificationMode);
  const ratificationsLookup =
    ratification === "cache-only" ? new DdbRatificationsLookup() : undefined;
  const bedrockInvoker = ratification === "replay-bedrock" ? new BedrockInvokerImpl() : undefined;

  const totalWindowMs = new Date(msg.to).getTime() - new Date(msg.from).getTime();
  let lastReportedQuartile = -1;
  const onCostUpdate = (_runningCost: number): true => {
    // Translate per-call cost ticks into 4-quartile coarse progress events.
    // The engine doesn't expose true progress; the cost callback is the
    // closest signal we have. We additionally bracket 0% / 100% explicitly
    // outside this callback.
    const tickMs = Date.now();
    const elapsedPct = totalWindowMs > 0 ? (tickMs % totalWindowMs) / totalWindowMs : 0;
    const quartile = Math.min(3, Math.floor(elapsedPct * 4));
    if (quartile > lastReportedQuartile) {
      lastReportedQuartile = quartile;
      void emitEvent({
        type: "backtest-progress",
        runId: msg.runId,
        progress: 0.25 * (quartile + 1),
        ts: new Date().toISOString(),
      });
    }
    return true;
  };

  const input: BacktestInput = {
    pair: msg.pair,
    timeframe: msg.timeframe as Timeframe,
    from: new Date(msg.from),
    to: new Date(msg.to),
    strategy,
    ratification,
    ...(msg.model ? { model: msg.model } : {}),
    ...(ratificationsLookup ? { ratificationsLookup } : {}),
    ...(bedrockInvoker ? { bedrockInvoker } : {}),
    onCostUpdate,
  };

  // Explicit 0% kick so the activity feed shows movement before the first
  // Bedrock call (which may be many bars away if gating is sparse).
  await emitEvent({
    type: "backtest-progress",
    runId: msg.runId,
    progress: 0,
    ts: new Date().toISOString(),
  });

  const result = await engine.run(input);

  let baselineResult: BacktestResult | undefined;
  if (baseline) {
    baselineResult = await engine.run({
      ...input,
      strategy: baseline,
    });
  }

  return { result, ...(baselineResult ? { baselineResult } : {}) };
}

// ---------------------------------------------------------------------------
// Build outputs (same set the CLI produces) and upload to S3.
// Returns the metricsSummary persisted on the DDB row.
// ---------------------------------------------------------------------------

async function buildAndUploadArtifacts(
  msg: BacktestJobMessage,
  result: BacktestResult,
  baselineResult: BacktestResult | undefined,
): Promise<Record<string, unknown>> {
  const sizing = { kind: "fixed-pct" as const, pct: 0.02 };
  const equityCurve = simulateEquityCurve(result.signals, sizing);
  const drawdowns = extractDrawdownPeriods(equityCurve.points, 3);
  const ruleAttribution = computeRuleAttribution(result.signals, sizing, equityCurve.finalEquity);
  const calibrationBins = computeCalibrationBins(result.signals);

  const prefix = msg.s3ResultPrefix;

  // Compose the metrics blob (parsed back on the DDB row + served inline
  // by GET /admin/backtest/:runId).
  const metricsBlob = {
    ...result.metrics,
    equityCurve: equityCurve.points.map((p) => p.equity),
    finalEquity: equityCurve.finalEquity,
    maxDrawdownPct: equityCurve.maxDrawdownPct,
    sharpeAnnualized: equityCurve.sharpeAnnualized,
    perRuleAttribution: ruleAttribution,
    calibrationByBin: calibrationBins,
    drawdownPeriods: drawdowns,
    meta: result.meta,
    pair: msg.pair,
    timeframe: msg.timeframe,
  };

  const baselineEquityCurve = baselineResult
    ? simulateEquityCurve(baselineResult.signals, sizing)
    : undefined;

  // Summary markdown
  const summary = baselineResult
    ? generateMarkdownReport({
        test: result,
        baseline: baselineResult,
        period: `${msg.from.substring(0, 10)} → ${msg.to.substring(0, 10)}`,
        testEquityCurve: equityCurve,
        ...(baselineEquityCurve ? { baselineEquityCurve } : {}),
        testDrawdownPeriods: drawdowns,
        testRuleAttribution: ruleAttribution,
        testCalibrationBins: calibrationBins,
      })
    : `# Backtest ${msg.runId}\n\n` +
      `Pair: ${msg.pair}\n` +
      `Timeframe: ${msg.timeframe}\n` +
      `Period: ${msg.from} → ${msg.to}\n` +
      `Strategy: ${msg.strategy}\n\n` +
      `Total signals: ${result.metrics.totalSignals}\n` +
      `Win rate: ${result.metrics.winRate !== null ? (result.metrics.winRate * 100).toFixed(1) + "%" : "n/a"}\n` +
      `Final equity: ${equityCurve.finalEquity.toFixed(4)}×\n` +
      `Max drawdown: ${(equityCurve.maxDrawdownPct * 100).toFixed(1)}%\n` +
      (equityCurve.sharpeAnnualized !== null
        ? `Sharpe: ${equityCurve.sharpeAnnualized.toFixed(3)}\n`
        : "");

  await Promise.all([
    uploadArtifact(`${prefix}summary.md`, summary, "text/markdown; charset=utf-8"),
    uploadArtifact(
      `${prefix}metrics.json`,
      JSON.stringify(metricsBlob, null, 2),
      "application/json; charset=utf-8",
    ),
    uploadArtifact(`${prefix}trades.csv`, tradesToCsv(result), "text/csv; charset=utf-8"),
    uploadArtifact(
      `${prefix}equity-curve.csv`,
      equityCurveToCsv(equityCurve.points),
      "text/csv; charset=utf-8",
    ),
    uploadArtifact(
      `${prefix}per-rule-attribution.csv`,
      ruleAttributionToCsv(ruleAttribution),
      "text/csv; charset=utf-8",
    ),
    uploadArtifact(
      `${prefix}calibration-by-bin.csv`,
      calibrationBinsToCsv(calibrationBins),
      "text/csv; charset=utf-8",
    ),
  ]);

  // Trim the metricsSummary stored on the DDB row to the fields the admin UI
  // reads on the list view — full data lives in metrics.json on S3.
  return {
    sharpe: equityCurve.sharpeAnnualized,
    maxDrawdownPct: equityCurve.maxDrawdownPct,
    totalReturnPct: equityCurve.finalEquity - 1,
    winRate: result.metrics.winRate,
    totalTrades: result.metrics.totalSignals,
    brierScore: result.metrics.brierScore,
  };
}

// ---------------------------------------------------------------------------
// Single-message processing (extracted so tests can inject a job directly
// without going through SQS).
// ---------------------------------------------------------------------------

export interface HandleOptions {
  candleStore?: DdbCandleStore;
}

export async function handleJob(msg: BacktestJobMessage, opts: HandleOptions = {}): Promise<void> {
  const candleStore = opts.candleStore ?? new DdbCandleStore();
  const startedAt = new Date().toISOString();
  await markRunning(msg.runId, startedAt);
  await emitEvent({
    type: "backtest-started",
    runId: msg.runId,
    strategy: msg.strategy,
    pair: msg.pair,
    timeframe: msg.timeframe,
    ts: startedAt,
  });

  const t0 = Date.now();
  let actualCostUsd = 0;
  try {
    const { result, baselineResult } = await processJob(msg, candleStore);
    actualCostUsd = result.meta.actualCostUsd ?? 0;
    const metricsSummary = await buildAndUploadArtifacts(msg, result, baselineResult);
    const completedAt = new Date().toISOString();

    await markCompleted(msg.runId, completedAt, {
      actualCostUsd,
      metricsSummary,
      s3ResultPrefix: msg.s3ResultPrefix,
    });

    await emitEvent({
      type: "backtest-progress",
      runId: msg.runId,
      progress: 1,
      ts: completedAt,
    });
    await emitEvent({
      type: "backtest-completed",
      runId: msg.runId,
      strategy: msg.strategy,
      pair: msg.pair,
      timeframe: msg.timeframe,
      durationMs: Date.now() - t0,
      actualCostUsd,
      totalSignals: result.metrics.totalSignals,
      ts: completedAt,
    });
  } catch (err) {
    const reason = (err as Error).message ?? String(err);
    console.error(`[runner] run ${msg.runId} failed: ${reason}`);
    await markFailed(msg.runId, reason);
    await emitEvent({
      type: "backtest-failed",
      runId: msg.runId,
      strategy: msg.strategy,
      pair: msg.pair,
      timeframe: msg.timeframe,
      reason,
      ts: new Date().toISOString(),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

/** Decoupled poll-one helper exported for tests. */
export async function pollAndProcessOnce(candleStore: DdbCandleStore): Promise<boolean> {
  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: JOBS_QUEUE_URL,
      MaxNumberOfMessages: RECEIVE_MAX_MESSAGES,
      WaitTimeSeconds: WAIT_TIME_SECONDS,
      VisibilityTimeout: 3600,
    }),
  );

  const messages = received.Messages ?? [];
  if (messages.length === 0) return false;

  for (const m of messages) {
    if (!m.Body || !m.ReceiptHandle) continue;
    let payload: BacktestJobMessage;
    try {
      payload = JSON.parse(m.Body) as BacktestJobMessage;
    } catch (err) {
      console.error(`[runner] unparseable SQS body: ${(err as Error).message}`);
      // Always delete unparseable messages — no point retrying garbage.
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: JOBS_QUEUE_URL,
          ReceiptHandle: m.ReceiptHandle,
        }),
      );
      continue;
    }

    try {
      await handleJob(payload, { candleStore });
    } catch {
      // handleJob already wrote the failed status + event; swallow here so
      // we still delete the SQS message and avoid infinite retries.
    } finally {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: JOBS_QUEUE_URL,
          ReceiptHandle: m.ReceiptHandle,
        }),
      );
    }
  }
  return true;
}

async function mainLoop(): Promise<void> {
  if (!JOBS_QUEUE_URL) {
    console.error("[runner] BACKTEST_JOBS_QUEUE_URL is not set — refusing to start");
    process.exit(1);
  }
  if (!RESULTS_BUCKET) {
    console.error("[runner] BACKTEST_RESULTS_BUCKET is not set — refusing to start");
    process.exit(1);
  }
  console.log(`[runner] starting poll loop — queue=${JOBS_QUEUE_URL} bucket=${RESULTS_BUCKET}`);

  const candleStore = new DdbCandleStore();
  let running = true;
  const stop = (sig: string): void => {
    console.log(`[runner] received ${sig}, draining...`);
    running = false;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (running) {
    try {
      await pollAndProcessOnce(candleStore);
    } catch (err) {
      console.error(`[runner] poll loop error: ${(err as Error).message}`);
      // Brief backoff so a persistent failure doesn't hot-spin.
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  console.log("[runner] drained — exiting cleanly");
}

// Only auto-run when invoked as a script (not when imported by tests).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /runner[/\\]main\.(t|j)s$/.test(process.argv[1]);
if (isMain) {
  mainLoop().catch((err: unknown) => {
    console.error("[runner] fatal:", err);
    process.exit(1);
  });
}

// Export internals for tests.
export { tradesToCsv, mapMode, emitEvent, processJob, buildAndUploadArtifacts };
export type { BacktestJobMessage };
