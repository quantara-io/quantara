import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Candle, Timeframe } from "@quantara/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CANDLES_TABLE =
  process.env.TABLE_CANDLES ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}candles`;

// TTL by timeframe: 1m = 7d, 5m/15m = 30d, 1h+ = 90d
const TTL_SECONDS: Record<Timeframe, number> = {
  "1m": 86400 * 7,
  "5m": 86400 * 30,
  "15m": 86400 * 30,
  "1h": 86400 * 90,
  "4h": 86400 * 90,
  "1d": 86400 * 365,
};

function buildSortKey(exchange: string, timeframe: string, timestamp: string): string {
  return `${exchange}#${timeframe}#${timestamp}`;
}

export async function storeCandles(candles: Candle[]): Promise<void> {
  const batches: Candle[][] = [];
  for (let i = 0; i < candles.length; i += 25) {
    batches.push(candles.slice(i, i + 25));
  }

  for (const batch of batches) {
    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [CANDLES_TABLE]: batch.map((c) => ({
            PutRequest: {
              Item: {
                pair: c.pair,
                sk: buildSortKey(c.exchange, c.timeframe, new Date(c.openTime).toISOString()),
                exchange: c.exchange,
                symbol: c.symbol,
                timeframe: c.timeframe,
                openTime: c.openTime,
                closeTime: c.closeTime,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
                isClosed: c.isClosed,
                ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS[c.timeframe as Timeframe],
              },
            },
          })),
        },
      }),
    );
  }

  console.log(`[CandleStore] Wrote ${candles.length} candles to ${CANDLES_TABLE}`);
}

export async function getCandles(
  pair: string,
  exchange: string,
  timeframe: string,
  limit = 100,
): Promise<Candle[]> {
  const prefix = `${exchange}#${timeframe}#`;
  const result = await client.send(
    new QueryCommand({
      TableName: CANDLES_TABLE,
      KeyConditionExpression: "#pair = :pair AND begins_with(#sk, :prefix)",
      ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
      ExpressionAttributeValues: { ":pair": pair, ":prefix": prefix },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );

  return (result.Items ?? []) as Candle[];
}
