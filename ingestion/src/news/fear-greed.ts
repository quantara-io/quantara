import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

const API_URL = "https://api.alternative.me/fng/?limit=1&format=json";

/** Bounded ring-buffer size. At hourly cadence this keeps 2 full days. */
export const HISTORY_LIMIT = 48;

export interface FearGreedData {
  value: number;
  classification: string;
  timestamp: number;
}

export interface FearGreedHistoryEntry {
  value: number;
  classification: string;
  timestamp: string; // ISO-8601
}

export async function fetchFearGreedIndex(): Promise<FearGreedData | null> {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn(`[FearGreed] API error: ${res.status}`);
      return null;
    }

    const json = (await res.json()) as {
      data: Array<{ value: string; value_classification: string; timestamp: string }>;
    };

    const entry = json.data?.[0];
    if (!entry) return null;

    const data: FearGreedData = {
      value: parseInt(entry.value, 10),
      classification: entry.value_classification,
      timestamp: parseInt(entry.timestamp, 10) * 1000,
    };

    const newEntry: FearGreedHistoryEntry = {
      value: data.value,
      classification: data.classification,
      timestamp: new Date(data.timestamp).toISOString(),
    };

    // Step 1: append the new entry and update scalar fields atomically.
    // list_append(if_not_exists(...)) handles the first write when history doesn't exist yet.
    await client.send(
      new UpdateCommand({
        TableName: METADATA_TABLE,
        Key: { metaKey: "market:fear-greed" },
        UpdateExpression: [
          "SET #v = :v,",
          "#c = :c,",
          "lastTimestamp = :lastTimestamp,",
          "updatedAt = :updatedAt,",
          "#status = :status,",
          "#h = list_append(if_not_exists(#h, :empty), :newEntry)",
        ].join(" "),
        ExpressionAttributeNames: {
          "#v": "value",
          "#c": "classification",
          "#status": "status",
          "#h": "history",
        },
        ExpressionAttributeValues: {
          ":v": data.value,
          ":c": data.classification,
          ":lastTimestamp": new Date(data.timestamp).toISOString(),
          ":updatedAt": new Date().toISOString(),
          ":status": "active",
          ":empty": [],
          ":newEntry": [newEntry],
        },
      }),
    );

    // Step 2: read back and prune to the last HISTORY_LIMIT entries.
    // We do a read-modify-write here because DynamoDB has no native "trim list to tail N"
    // expression. At hourly cadence (max 1 write/hour) this is safe and cheap.
    await pruneHistory();

    console.log(`[FearGreed] Index: ${data.value} (${data.classification})`);
    return data;
  } catch (err) {
    console.warn(`[FearGreed] Error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Read the current history list and, if it exceeds HISTORY_LIMIT, remove
 * leading (oldest) entries so only the last HISTORY_LIMIT are kept.
 *
 * Uses individual REMOVE list[i] expressions — DynamoDB does not support
 * slicing a list in a single UpdateExpression.
 */
export async function pruneHistory(): Promise<void> {
  const result = await client.send(
    new GetCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: "market:fear-greed" },
      ProjectionExpression: "#h",
      ExpressionAttributeNames: { "#h": "history" },
    })
  );

  const history = (result.Item?.history as FearGreedHistoryEntry[] | undefined) ?? [];
  const excess = history.length - HISTORY_LIMIT;
  if (excess <= 0) return;

  // Build REMOVE expression: REMOVE history[0], history[1], ... history[excess-1]
  const removeExpressions = Array.from({ length: excess }, (_, i) => `history[${i}]`);
  const removeExpression = `REMOVE ${removeExpressions.join(", ")}`;

  await client.send(
    new UpdateCommand({
      TableName: METADATA_TABLE,
      Key: { metaKey: "market:fear-greed" },
      UpdateExpression: removeExpression,
    })
  );
}
