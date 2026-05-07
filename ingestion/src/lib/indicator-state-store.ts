import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { IndicatorState } from "@quantara/shared";
import type { Timeframe } from "@quantara/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INDICATOR_STATE_TABLE =
  process.env.TABLE_INDICATOR_STATE ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}indicator-state`;

/** 7-day TTL for indicator snapshots */
const TTL_SECONDS = 86400 * 7;

/**
 * Build the partition key from the three identifying dimensions.
 * Format: "pair#exchange#timeframe" — e.g. "BTC/USDT#binanceus#15m"
 */
function buildPk(pair: string, exchange: string, timeframe: Timeframe): string {
  return `${pair}#${exchange}#${timeframe}`;
}

/**
 * Convert unix-ms asOf to ISO8601 string for use as the sort key.
 */
function asOfToSortKey(asOf: number): string {
  return new Date(asOf).toISOString();
}

/**
 * Persist the latest indicator state snapshot for a pair/exchange/timeframe.
 * Each call writes a new row; old rows expire via TTL (7 days).
 * Does not mutate the input.
 */
export async function putIndicatorState(state: IndicatorState): Promise<void> {
  const pk = buildPk(state.pair, state.exchange, state.timeframe);
  const asOf = asOfToSortKey(state.asOf);
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  await client.send(
    new PutCommand({
      TableName: INDICATOR_STATE_TABLE,
      Item: {
        pk,
        asOf,
        // Denormalized scalar fields for query/readability
        pair: state.pair,
        exchange: state.exchange,
        timeframe: state.timeframe,
        asOfMs: state.asOf,
        barsSinceStart: state.barsSinceStart,
        // Indicator numerics (null → omitted by DynamoDBDocumentClient)
        rsi14: state.rsi14,
        ema20: state.ema20,
        ema50: state.ema50,
        ema200: state.ema200,
        macdLine: state.macdLine,
        macdSignal: state.macdSignal,
        macdHist: state.macdHist,
        atr14: state.atr14,
        bbUpper: state.bbUpper,
        bbMid: state.bbMid,
        bbLower: state.bbLower,
        bbWidth: state.bbWidth,
        obv: state.obv,
        obvSlope: state.obvSlope,
        vwap: state.vwap,
        volZ: state.volZ,
        realizedVolAnnualized: state.realizedVolAnnualized,
        fearGreed: state.fearGreed,
        dispersion: state.dispersion,
        // Ring-buffer history serialized as a DDB Map (DocumentClient handles it)
        history: state.history,
        ttl,
      },
    })
  );
}

/**
 * Retrieve the most-recent indicator state snapshot for a pair/exchange/timeframe.
 * Returns null if no snapshot exists.
 */
export async function getLatestIndicatorState(
  pair: string,
  exchange: string,
  timeframe: Timeframe
): Promise<IndicatorState | null> {
  const pk = buildPk(pair, exchange, timeframe);

  const result = await client.send(
    new QueryCommand({
      TableName: INDICATOR_STATE_TABLE,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: false,
      Limit: 1,
    })
  );

  const item = result.Items?.[0];
  if (!item) return null;

  return {
    pair: item.pair as string,
    exchange: item.exchange as string,
    timeframe: item.timeframe as Timeframe,
    asOf: item.asOfMs as number,
    barsSinceStart: item.barsSinceStart as number,
    rsi14: (item.rsi14 as number | null) ?? null,
    ema20: (item.ema20 as number | null) ?? null,
    ema50: (item.ema50 as number | null) ?? null,
    ema200: (item.ema200 as number | null) ?? null,
    macdLine: (item.macdLine as number | null) ?? null,
    macdSignal: (item.macdSignal as number | null) ?? null,
    macdHist: (item.macdHist as number | null) ?? null,
    atr14: (item.atr14 as number | null) ?? null,
    bbUpper: (item.bbUpper as number | null) ?? null,
    bbMid: (item.bbMid as number | null) ?? null,
    bbLower: (item.bbLower as number | null) ?? null,
    bbWidth: (item.bbWidth as number | null) ?? null,
    obv: (item.obv as number | null) ?? null,
    obvSlope: (item.obvSlope as number | null) ?? null,
    vwap: (item.vwap as number | null) ?? null,
    volZ: (item.volZ as number | null) ?? null,
    realizedVolAnnualized: (item.realizedVolAnnualized as number | null) ?? null,
    fearGreed: (item.fearGreed as number | null) ?? null,
    dispersion: (item.dispersion as number | null) ?? null,
    history: item.history as IndicatorState["history"],
  };
}
