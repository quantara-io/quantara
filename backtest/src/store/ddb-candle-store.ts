import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Candle, Timeframe } from "@quantara/shared";

import type { HistoricalCandleStore } from "./candle-store.js";

export interface DdbCandleStoreOptions {
  /**
   * Explicit table name. When omitted, reads TABLE_CANDLES or falls back to
   * `${TABLE_PREFIX}candles` (mirrors ingestion candle-store convention).
   */
  tableName?: string;
}

function resolveTableName(opts: DdbCandleStoreOptions): string {
  if (opts.tableName) return opts.tableName;
  return process.env.TABLE_CANDLES ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}candles`;
}

/**
 * DynamoDB implementation of HistoricalCandleStore.
 *
 * Phase 1: queries the production `candles` table (90-day TTL window).
 * Phase 2+: will accept `--source=archive` to query `candles-archive`.
 *
 * SK format: `${exchange}#${timeframe}#${openTimeISO}` — same as candle-store.ts.
 * Date-range query uses BETWEEN on the composite SK with lexicographic ordering
 * (ISO8601 dates are lexicographically sortable).
 */
export class DdbCandleStore implements HistoricalCandleStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(opts: DdbCandleStoreOptions = {}) {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this.tableName = resolveTableName(opts);
  }

  async getCandles(
    pair: string,
    exchange: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Candle[]> {
    const prefix = `${exchange}#${timeframe}#`;
    const skFrom = `${prefix}${from.toISOString()}`;
    const skTo = `${prefix}${to.toISOString()}`;

    const items: Candle[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "#pair = :pair AND #sk BETWEEN :skFrom AND :skTo",
          ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pair": pair,
            ":skFrom": skFrom,
            ":skTo": skTo,
          },
          ScanIndexForward: true,
          ExclusiveStartKey: lastKey,
        }),
      );

      if (result.Items) {
        for (const item of result.Items) {
          items.push(item as Candle);
        }
      }

      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey !== undefined);

    return items;
  }
}
