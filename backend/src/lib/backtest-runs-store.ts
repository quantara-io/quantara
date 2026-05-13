/**
 * backtest-runs-store.ts — Phase 4.
 *
 * DynamoDB helpers for the backtest-runs table:
 *   - putRun       — initial insert (status=queued) + SQS enqueue
 *   - getRun       — single-row fetch by runId
 *   - listRuns     — paginated list sorted by submittedAt desc (via list-index GSI)
 *   - getRunDetail — full row + s3 artifact key paths + metrics summary
 *   - updateStatus — atomic status update (running/done/failed) with optional fields
 *
 * Key schema:
 *   PK: runId (UUID with timestamp prefix for sortability)
 *   GSI list-index: listPartition (always "ALL") + submittedAt (ISO-8601)
 *
 * TTL: 90 days, stored in the `ttl` attribute (Unix seconds).
 *
 * Note: presigned S3 URLs require @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner
 * which are not yet in backend/package.json. The store returns S3 key paths instead;
 * the admin UI constructs access via the backend proxy endpoint.
 *
 * Issue #371.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";

const REGION = process.env.AWS_REGION ?? "us-west-2";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sqs = new SQSClient({ region: REGION });

const TABLE =
  process.env.TABLE_BACKTEST_RUNS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}backtest-runs`;

const JOBS_QUEUE_URL = process.env.BACKTEST_JOBS_QUEUE_URL ?? "";

// Sentinel partition key for the list GSI — all admin list queries use "ALL".
const LIST_PARTITION = "ALL";

// 90-day TTL in seconds.
const TTL_SECONDS = 90 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "done" | "failed";

export interface BacktestRunInput {
  strategy: string;
  baseline?: string;
  pair: string;
  timeframe: string;
  from: string;
  to: string;
  ratificationMode: string;
  model?: string;
  estimatedCostUsd: number;
  userId: string;
}

export interface BacktestRun {
  runId: string;
  listPartition: string;
  userId: string;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  status: RunStatus;
  strategy: string;
  baseline?: string;
  pair: string;
  timeframe: string;
  from: string;
  to: string;
  ratificationMode: string;
  model?: string;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  metricsSummary?: Record<string, unknown>;
  s3ResultPrefix?: string;
  ttl: number;
}

// Minimal row shape returned by the list endpoint.
export interface BacktestRunSummary {
  runId: string;
  status: RunStatus;
  strategy: string;
  pair: string;
  timeframe: string;
  from: string;
  to: string;
  submittedAt: string;
  completedAt?: string;
  metricsSummary?: Record<string, unknown>;
  estimatedCostUsd: number;
  actualCostUsd?: number;
}

// Full row + artifact paths (returned by single-run GET).
export interface BacktestRunDetail extends BacktestRun {
  /** S3 key paths for each artifact (relative to BACKTEST_RESULTS_BUCKET). */
  artifactKeys?: {
    summaryMd: string;
    metricsJson: string;
    tradesCsv: string;
    equityCurveCsv: string;
    perRuleAttributionCsv: string;
    calibrationByBinCsv: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a time-sortable run ID: timestamp prefix + UUID suffix. */
function newRunId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14); // YYYYMMDDHHmmss
  return `${ts}-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// putRun
// ---------------------------------------------------------------------------

/**
 * Insert a new backtest-run row with status=queued and return its runId.
 * Also enqueues the job onto the backtest-jobs SQS queue.
 */
export async function putRun(
  input: BacktestRunInput,
): Promise<{ runId: string; estimateUsd: number }> {
  const runId = newRunId();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const s3ResultPrefix = `${runId}/`;

  const item: BacktestRun = {
    runId,
    listPartition: LIST_PARTITION,
    userId: input.userId,
    submittedAt: now,
    status: "queued",
    strategy: input.strategy,
    ...(input.baseline ? { baseline: input.baseline } : {}),
    pair: input.pair,
    timeframe: input.timeframe,
    from: input.from,
    to: input.to,
    ratificationMode: input.ratificationMode,
    ...(input.model ? { model: input.model } : {}),
    estimatedCostUsd: input.estimatedCostUsd,
    s3ResultPrefix,
    ttl,
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(runId)",
    }),
  );

  // Enqueue the job for the Fargate runner.
  if (JOBS_QUEUE_URL) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: JOBS_QUEUE_URL,
        MessageBody: JSON.stringify({
          runId,
          strategy: input.strategy,
          baseline: input.baseline,
          pair: input.pair,
          timeframe: input.timeframe,
          from: input.from,
          to: input.to,
          ratificationMode: input.ratificationMode,
          model: input.model,
          s3ResultPrefix,
        }),
      }),
    );
  } else {
    logger.warn({ runId }, "BACKTEST_JOBS_QUEUE_URL not set — job not enqueued");
  }

  return { runId, estimateUsd: input.estimatedCostUsd };
}

// ---------------------------------------------------------------------------
// getRun
// ---------------------------------------------------------------------------

export async function getRun(runId: string): Promise<BacktestRun | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { runId },
    }),
  );
  return (result.Item as BacktestRun | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// listRuns
// ---------------------------------------------------------------------------

export interface ListRunsOptions {
  limit?: number;
  cursor?: string; // base64url-encoded LastEvaluatedKey
}

export interface ListRunsResult {
  items: BacktestRunSummary[];
  nextCursor: string | null;
}

export async function listRuns(opts: ListRunsOptions = {}): Promise<ListRunsResult> {
  const limit = Math.min(opts.limit ?? 20, 100);
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (opts.cursor) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(opts.cursor, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      // invalid cursor — ignore, start from the beginning
    }
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "list-index",
      KeyConditionExpression: "listPartition = :lp",
      ExpressionAttributeValues: { ":lp": LIST_PARTITION },
      ScanIndexForward: false, // newest first
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const items = (result.Items ?? []).map((row) => {
    const r = row as BacktestRun;
    return {
      runId: r.runId,
      status: r.status,
      strategy: r.strategy,
      pair: r.pair,
      timeframe: r.timeframe,
      from: r.from,
      to: r.to,
      submittedAt: r.submittedAt,
      completedAt: r.completedAt,
      metricsSummary: r.metricsSummary,
      estimatedCostUsd: r.estimatedCostUsd,
      actualCostUsd: r.actualCostUsd,
    } satisfies BacktestRunSummary;
  });

  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url")
    : null;

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// getRunDetail — full row + artifact S3 key paths
// ---------------------------------------------------------------------------

const ARTIFACT_FILES = [
  "summary.md",
  "metrics.json",
  "trades.csv",
  "equity-curve.csv",
  "per-rule-attribution.csv",
  "calibration-by-bin.csv",
] as const;

export async function getRunDetail(runId: string): Promise<BacktestRunDetail | null> {
  const run = await getRun(runId);
  if (!run) return null;

  const detail: BacktestRunDetail = { ...run };

  // When the run is done, attach the S3 key paths for each artifact.
  if (run.status === "done" && run.s3ResultPrefix) {
    const prefix = run.s3ResultPrefix;
    detail.artifactKeys = {
      summaryMd: `${prefix}${ARTIFACT_FILES[0]}`,
      metricsJson: `${prefix}${ARTIFACT_FILES[1]}`,
      tradesCsv: `${prefix}${ARTIFACT_FILES[2]}`,
      equityCurveCsv: `${prefix}${ARTIFACT_FILES[3]}`,
      perRuleAttributionCsv: `${prefix}${ARTIFACT_FILES[4]}`,
      calibrationByBinCsv: `${prefix}${ARTIFACT_FILES[5]}`,
    };
  }

  return detail;
}

// ---------------------------------------------------------------------------
// updateRunStatus (used by the Fargate runner — also callable from tests)
// ---------------------------------------------------------------------------

export async function updateRunStatus(
  runId: string,
  status: RunStatus,
  extra?: {
    startedAt?: string;
    completedAt?: string;
    actualCostUsd?: number;
    metricsSummary?: Record<string, unknown>;
    s3ResultPrefix?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const setExprs: string[] = ["#status = :status", "updatedAt = :now"];
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = { ":status": status, ":now": now };

  if (extra?.startedAt) {
    setExprs.push("startedAt = :startedAt");
    values[":startedAt"] = extra.startedAt;
  }
  if (extra?.completedAt) {
    setExprs.push("completedAt = :completedAt");
    values[":completedAt"] = extra.completedAt;
  }
  if (extra?.actualCostUsd !== undefined) {
    setExprs.push("actualCostUsd = :actualCostUsd");
    values[":actualCostUsd"] = extra.actualCostUsd;
  }
  if (extra?.metricsSummary) {
    setExprs.push("metricsSummary = :metricsSummary");
    values[":metricsSummary"] = extra.metricsSummary;
  }
  if (extra?.s3ResultPrefix) {
    setExprs.push("s3ResultPrefix = :s3ResultPrefix");
    values[":s3ResultPrefix"] = extra.s3ResultPrefix;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { runId },
      UpdateExpression: `SET ${setExprs.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
