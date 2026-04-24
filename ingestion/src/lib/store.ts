import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { PriceSnapshot } from "../exchanges/fetcher.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PRICES_TABLE = process.env.TABLE_PRICES ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}prices`;

export async function storePriceSnapshots(snapshots: PriceSnapshot[]): Promise<void> {
  // DynamoDB BatchWrite max 25 items per request
  const batches: PriceSnapshot[][] = [];
  for (let i = 0; i < snapshots.length; i += 25) {
    batches.push(snapshots.slice(i, i + 25));
  }

  for (const batch of batches) {
    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [PRICES_TABLE]: batch.map((s) => ({
            PutRequest: {
              Item: {
                pair: s.pair,
                timestamp: s.timestamp,
                exchange: s.exchange,
                symbol: s.symbol,
                price: s.price,
                bid: s.bid,
                ask: s.ask,
                volume24h: s.volume24h,
                stale: s.stale,
                ttl: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 day TTL
              },
            },
          })),
        },
      })
    );
  }

  console.log(`[Store] Wrote ${snapshots.length} price snapshots to ${PRICES_TABLE}`);
}

export async function getLatestPrices(pair: string): Promise<PriceSnapshot[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: PRICES_TABLE,
      KeyConditionExpression: "#pair = :pair",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: { ":pair": pair },
      ScanIndexForward: false,
      Limit: 15, // latest 15 snapshots (3 exchanges × 5 ticks)
    })
  );

  return (result.Items ?? []) as PriceSnapshot[];
}
