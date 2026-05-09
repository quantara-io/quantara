import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

export interface IngestionCursor {
  metaKey: string;
  lastTimestamp: string;
  status: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export async function getCursor(metaKey: string): Promise<IngestionCursor | null> {
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey },
    }),
  );
  return (result.Item as IngestionCursor) ?? null;
}

export async function saveCursor(cursor: IngestionCursor): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: METADATA_TABLE,
      Item: {
        ...cursor,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// LLM usage tracking (per-day bucketed for low write volume)
// ---------------------------------------------------------------------------

/**
 * Atomically accumulate token + call counts for one Bedrock invocation into
 * the ingestion-metadata table under `metaKey: llm_usage#YYYY-MM-DD`.
 *
 * Counters are decoupled by design:
 *   - `calls` increments on every invocation (1 InvokeModel = 1 call)
 *   - `articlesEnriched` increments only when the caller signals this call
 *     completes a fully-enriched article (Phase 5a may invoke twice per
 *     article — pair-tag + sentiment — so the per-call invokeHaiku helper
 *     must NOT count itself as an article)
 *
 * Day-bucketing means callers asking for "last 24h" usage actually get
 * "today + yesterday" near midnight UTC. Callers/UIs should label the
 * window as day-grain accordingly.
 *
 * Best-effort: failures log and return; never block the calling LLM path.
 */
export async function recordLlmUsage(opts: {
  modelTag: string;
  inputTokens: number;
  outputTokens: number;
  /** True when this call completes a fully-enriched article (avoids double-counting). */
  countAsArticle: boolean;
}): Promise<void> {
  const { modelTag, inputTokens, outputTokens, countAsArticle } = opts;
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  // Build UpdateExpression conditionally so we don't ADD 0 to articlesEnriched
  // for non-article-boundary calls (which would be a no-op but pollutes the
  // expression).
  const articlePart = countAsArticle ? ", articlesEnriched :one" : "";
  const articleValue = countAsArticle ? { ":one": 1 } : {};
  try {
    await client.send(
      new UpdateCommand({
        TableName: METADATA_TABLE,
        Key: { metaKey: `llm_usage#${dateKey}` },
        UpdateExpression: `SET modelTag = :model ADD calls :one_call, totalInputTokens :inp, totalOutputTokens :out${articlePart}`,
        ExpressionAttributeValues: {
          ":model": modelTag,
          ":one_call": 1,
          ":inp": inputTokens,
          ":out": outputTokens,
          ...articleValue,
        },
      }),
    );
  } catch (err) {
    console.error(`[metadata-store] recordLlmUsage failed: ${(err as Error).message}`);
  }
}
