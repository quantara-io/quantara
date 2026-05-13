/**
 * backtest-artifact-stream.ts — Phase 4 follow-up.
 *
 * Streams a backtest artifact (summary.md / metrics.json / *.csv) from the
 * backtest-results S3 bucket directly back to the admin caller. Implements
 * the proxy endpoint the `BacktestRun.tsx` download links hit.
 *
 * Resolves PR #376 review finding 4 (artifact download links 404'd because
 * no backend route served them). Presigned URLs were deferred to a future PR
 * because they require @aws-sdk/s3-request-presigner; the proxy approach is
 * acceptable for the internal admin UI.
 *
 * Issue #371.
 */

import { GetObjectCommand, S3Client, NoSuchKey } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

const s3 = new S3Client({});

const BACKTEST_RESULTS_BUCKET =
  process.env.BACKTEST_RESULTS_BUCKET ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}backtest-results`;

/**
 * Whitelist of artifact filenames the proxy will serve. Locked down so a
 * caller can't probe the S3 bucket with arbitrary keys (e.g. ../../).
 * Matches the files written by backtest/src/runner/main.ts.
 */
const ALLOWED_ARTIFACTS = new Set([
  "summary.md",
  "metrics.json",
  "trades.csv",
  "equity-curve.csv",
  "per-rule-attribution.csv",
  "calibration-by-bin.csv",
]);

/** Strict allow-list check — used by the route handler to 400 unknown names. */
export function isAllowedArtifactName(name: string): boolean {
  return ALLOWED_ARTIFACTS.has(name);
}

/** Best-effort Content-Type mapping — keeps the browser/CSV download UX sane. */
function contentTypeFor(name: string): string {
  if (name.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  if (name.endsWith(".csv")) return "text/csv; charset=utf-8";
  return "application/octet-stream";
}

export interface StreamedArtifact {
  /** Raw body — either a string (small text artifacts) or a Buffer. */
  body: string;
  contentType: string;
  contentLength: number;
}

/**
 * Read the artifact from S3 and return its content + metadata. Throws
 * `ArtifactNotFoundError` when the key doesn't exist (route maps to 404).
 *
 * Artifacts are bounded in size by the backtest harness (worst case ~5MB
 * per CSV for very long runs) so reading the full body into memory is
 * acceptable for v1. If we ever produce larger artifacts, swap to the
 * stream-pipe pattern via Web Streams API.
 */
export async function streamBacktestArtifact(
  runId: string,
  name: string,
): Promise<StreamedArtifact> {
  if (!isAllowedArtifactName(name)) {
    throw new ArtifactNotFoundError(`Artifact "${name}" is not in the allow-list`);
  }
  const key = `${runId}/${name}`;

  let result;
  try {
    result = await s3.send(
      new GetObjectCommand({
        Bucket: BACKTEST_RESULTS_BUCKET,
        Key: key,
      }),
    );
  } catch (err) {
    if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey") {
      throw new ArtifactNotFoundError(`s3://${BACKTEST_RESULTS_BUCKET}/${key} not found`);
    }
    throw err;
  }

  if (!result.Body) {
    throw new ArtifactNotFoundError(`s3://${BACKTEST_RESULTS_BUCKET}/${key} returned empty body`);
  }

  const body = await streamToString(result.Body as Readable);
  return {
    body,
    contentType: contentTypeFor(name),
    contentLength: body.length,
  };
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export class ArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}
