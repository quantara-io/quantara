import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const METADATA_TABLE =
  process.env.TABLE_METADATA ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ingestion-metadata`;

const API_URL = "https://api.alternative.me/fng/?limit=1&format=json";

export interface FearGreedData {
  value: number;
  classification: string;
  timestamp: number;
}

export async function fetchFearGreedIndex(): Promise<FearGreedData | null> {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn(`[FearGreed] API error: ${res.status}`);
      return null;
    }

    const json = await res.json() as {
      data: Array<{ value: string; value_classification: string; timestamp: string }>;
    };

    const entry = json.data?.[0];
    if (!entry) return null;

    const data: FearGreedData = {
      value: parseInt(entry.value, 10),
      classification: entry.value_classification,
      timestamp: parseInt(entry.timestamp, 10) * 1000,
    };

    // Store in ingestion_metadata for downstream consumers
    await client.send(
      new PutCommand({
        TableName: METADATA_TABLE,
        Item: {
          metaKey: "market:fear-greed",
          value: data.value,
          classification: data.classification,
          lastTimestamp: new Date(data.timestamp).toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        },
      })
    );

    console.log(`[FearGreed] Index: ${data.value} (${data.classification})`);
    return data;
  } catch (err) {
    console.warn(`[FearGreed] Error: ${(err as Error).message}`);
    return null;
  }
}
