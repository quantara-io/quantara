/**
 * calibration/calibration-store.ts — DynamoDB helpers for the calibration_params table.
 *
 * Row shapes:
 *   Platt:  { pk: "platt#{pair}#{TF}", a, b, n, eceBefore, eceAfter, updatedAt }
 *   Kelly:  { pk: "kelly#{pair}#{TF}#{direction}", p, b, resolved, updatedAt }
 *
 * No TTL — calibration params are reference data. The job re-fits daily so rows
 * are naturally overwritten.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

import type { PlattCoeffs, KellyResult } from "./math.js";

// ---------------------------------------------------------------------------
// DDB client
// ---------------------------------------------------------------------------

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CALIBRATION_TABLE =
  process.env.TABLE_CALIBRATION_PARAMS ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}calibration-params`;

// ---------------------------------------------------------------------------
// Platt row
// ---------------------------------------------------------------------------

export interface PlattRow {
  pk: string;
  a: number;
  b: number;
  n: number;
  eceBefore: number;
  eceAfter: number;
  updatedAt: string;
}

function plattPk(pair: string, timeframe: string): string {
  return `platt#${pair}#${timeframe}`;
}

/** Persist Platt scaling coefficients for a (pair, TF) slice. */
export async function putPlattRow(
  pair: string,
  timeframe: string,
  coeffs: PlattCoeffs,
  now: string = new Date().toISOString(),
): Promise<void> {
  const item: PlattRow = {
    pk: plattPk(pair, timeframe),
    a: coeffs.a,
    b: coeffs.b,
    n: coeffs.n,
    eceBefore: coeffs.eceBefore,
    eceAfter: coeffs.eceAfter,
    updatedAt: now,
  };
  await client.send(new PutCommand({ TableName: CALIBRATION_TABLE, Item: item }));
}

/** Retrieve Platt coefficients for a (pair, TF) slice. Returns null when absent. */
export async function getPlattRow(pair: string, timeframe: string): Promise<PlattRow | null> {
  const result = await client.send(
    new GetCommand({
      TableName: CALIBRATION_TABLE,
      Key: { pk: plattPk(pair, timeframe) },
    }),
  );
  return (result.Item as PlattRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Kelly row
// ---------------------------------------------------------------------------

export interface KellyRow {
  pk: string;
  p: number;
  b: number;
  resolved: number;
  updatedAt: string;
}

function kellyPk(pair: string, timeframe: string, direction: "buy" | "sell"): string {
  return `kelly#${pair}#${timeframe}#${direction}`;
}

/** Persist Kelly stats for a (pair, TF, direction) slice. */
export async function putKellyRow(
  pair: string,
  timeframe: string,
  direction: "buy" | "sell",
  stats: KellyResult,
  now: string = new Date().toISOString(),
): Promise<void> {
  const item: KellyRow = {
    pk: kellyPk(pair, timeframe, direction),
    p: stats.p,
    b: stats.b,
    resolved: stats.resolved,
    updatedAt: now,
  };
  await client.send(new PutCommand({ TableName: CALIBRATION_TABLE, Item: item }));
}

/** Retrieve Kelly stats for a (pair, TF, direction) slice. Returns null when absent. */
export async function getKellyRow(
  pair: string,
  timeframe: string,
  direction: "buy" | "sell",
): Promise<KellyRow | null> {
  const result = await client.send(
    new GetCommand({
      TableName: CALIBRATION_TABLE,
      Key: { pk: kellyPk(pair, timeframe, direction) },
    }),
  );
  return (result.Item as KellyRow | undefined) ?? null;
}
