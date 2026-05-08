import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

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
