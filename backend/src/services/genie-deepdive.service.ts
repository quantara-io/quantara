import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  computeCalibration,
  computePerRule,
  computeCoOccurrence,
  computeByVolatility,
  computeByHour,
  type CalibrationBin,
  type PerRuleRow,
  type CoOccurrenceRow,
  type VolatilityBucket,
  type HourBucket,
  type SignalRecord,
} from "./genie-deepdive.math.js";

const REGION = process.env.AWS_REGION ?? "us-west-2";
const PREFIX = process.env.TABLE_PREFIX ?? "quantara-dev-";

const SIGNALS_V2_TABLE = process.env.TABLE_SIGNALS_V2 ?? `${PREFIX}signals-v2`;
const SIGNAL_OUTCOMES_TABLE = process.env.TABLE_SIGNAL_OUTCOMES ?? `${PREFIX}signal-outcomes`;
const INDICATOR_STATE_TABLE = process.env.TABLE_INDICATOR_STATE ?? `${PREFIX}indicator-state`;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ---------------------------------------------------------------------------
// Re-export types for consumers (e.g. admin.ts route handler)
// ---------------------------------------------------------------------------

export type {
  CalibrationBin,
  PerRuleRow,
  CoOccurrenceRow,
  VolatilityBucket,
  HourBucket,
};

export interface GenieDeepDive {
  windowStart: string;
  windowEnd: string;
  calibration: CalibrationBin[];
  rules: {
    perRule: PerRuleRow[];
    coOccurrence: CoOccurrenceRow[];
  };
  regime: {
    byVolatility: VolatilityBucket[];
    byHour: HourBucket[];
  };
}

// ---------------------------------------------------------------------------
// Internal data shapes
// ---------------------------------------------------------------------------

interface OutcomeRecord {
  pair: string;
  signalId: string;
  outcome: "correct" | "incorrect" | "neutral";
}

interface IndicatorItem {
  atr14: number | null;
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

const BLEND_TFS = ["15m", "1h", "4h", "1d"] as const;

async function fetchSignals(
  pairs: readonly string[],
  sinceMs: number,
  untilMs: number,
  timeframe?: string,
): Promise<SignalRecord[]> {
  const tfs: readonly string[] = timeframe ? [timeframe] : BLEND_TFS;
  const rows: SignalRecord[] = [];

  await Promise.all(
    pairs.flatMap((pair) =>
      tfs.map(async (tf) => {
        let lastKey: Record<string, unknown> | undefined;
        do {
          const result = await dynamo.send(
            new QueryCommand({
              TableName: SIGNALS_V2_TABLE,
              KeyConditionExpression: "#pair = :pair AND #sk BETWEEN :lo AND :hi",
              ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
              ExpressionAttributeValues: {
                ":pair": pair,
                ":lo": `${tf}#${sinceMs}`,
                ":hi": `${tf}#${untilMs}`,
              },
              ExclusiveStartKey: lastKey,
            }),
          );
          for (const item of result.Items ?? []) {
            const confidence = item.confidence as number | undefined;
            const rulesFired = item.rulesFired as string[] | undefined;
            const closeTime = item.closeTime as number | undefined;
            if (
              typeof confidence !== "number" ||
              !Array.isArray(rulesFired) ||
              typeof closeTime !== "number"
            ) {
              continue;
            }
            rows.push({
              pair: item.pair as string,
              signalId: (item.signalId as string) ?? "",
              confidence,
              rulesFired,
              closeTime,
              emittingTimeframe: tf,
            });
          }
          lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
        } while (lastKey !== undefined);
      }),
    ),
  );

  return rows;
}

async function fetchOutcomes(
  pairs: readonly string[],
  sinceIso: string,
  untilIso: string,
): Promise<OutcomeRecord[]> {
  const rows: OutcomeRecord[] = [];

  await Promise.all(
    pairs.map(async (pair) => {
      let lastKey: Record<string, unknown> | undefined;
      do {
        const result = await dynamo.send(
          new QueryCommand({
            TableName: SIGNAL_OUTCOMES_TABLE,
            KeyConditionExpression: "#pair = :pair",
            FilterExpression: "#createdAt BETWEEN :since AND :until",
            ExpressionAttributeNames: { "#pair": "pair", "#createdAt": "createdAt" },
            ExpressionAttributeValues: {
              ":pair": pair,
              ":since": sinceIso,
              ":until": untilIso,
            },
            ExclusiveStartKey: lastKey,
          }),
        );
        for (const item of result.Items ?? []) {
          const outcome = item.outcome as string | undefined;
          if (outcome !== "correct" && outcome !== "incorrect" && outcome !== "neutral") continue;
          rows.push({
            pair: item.pair as string,
            signalId: (item.signalId as string) ?? "",
            outcome,
          });
        }
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey !== undefined);
    }),
  );

  return rows;
}

/**
 * Fetch the ATR14 from indicator_state for each unique (pair, tf, closeTime)
 * combination in the signal list.
 * PK = `${pair}#consensus#${tf}`, SK = asOfMs (number, <= closeTime).
 */
async function fetchAtr14ForSignals(
  signals: SignalRecord[],
): Promise<Map<string, number | null>> {
  const atrMap = new Map<string, number | null>();
  const uniqueKeys = new Set(
    signals.map((s) => `${s.pair}#${s.emittingTimeframe}#${s.closeTime}`),
  );

  await Promise.all(
    Array.from(uniqueKeys).map(async (key) => {
      const parts = key.split("#");
      // pair may contain "/" which doesn't appear in tf or closeMs, so split
      // from the right: last part is closeMs, second-to-last is tf,
      // everything before is pair.
      const closeMs = parseInt(parts[parts.length - 1], 10);
      const tf = parts[parts.length - 2];
      const pair = parts.slice(0, parts.length - 2).join("#");
      try {
        const pk = `${pair}#consensus#${tf}`;
        const result = await dynamo.send(
          new QueryCommand({
            TableName: INDICATOR_STATE_TABLE,
            KeyConditionExpression: "#pk = :pk AND #sk <= :closeMs",
            ExpressionAttributeNames: { "#pk": "pk", "#sk": "asOfMs" },
            ExpressionAttributeValues: { ":pk": pk, ":closeMs": closeMs },
            ScanIndexForward: false,
            Limit: 1,
          }),
        );
        const item = result.Items?.[0] as IndicatorItem | undefined;
        atrMap.set(key, item?.atr14 ?? null);
      } catch {
        atrMap.set(key, null);
      }
    }),
  );

  return atrMap;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function getGenieDeepDive(
  since?: string,
  pair?: string,
  timeframe?: string,
): Promise<GenieDeepDive> {
  const windowEnd = new Date().toISOString();
  const windowStart = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { PAIRS } = await import("@quantara/shared");
  const pairs: readonly string[] = pair ? [pair] : PAIRS;

  const sinceMs = new Date(windowStart).getTime();
  const untilMs = new Date(windowEnd).getTime();

  // Fetch signals first, then outcomes and ATR in parallel.
  const signals = await fetchSignals(pairs, sinceMs, untilMs, timeframe);
  const [outcomes, atrMap] = await Promise.all([
    fetchOutcomes(pairs, windowStart, windowEnd),
    fetchAtr14ForSignals(signals),
  ]);

  // Build a fast lookup: signalId → outcome
  const outcomeBySignalId = new Map<string, "correct" | "incorrect" | "neutral">();
  for (const o of outcomes) {
    if (o.signalId) outcomeBySignalId.set(o.signalId, o.outcome);
  }

  return {
    windowStart,
    windowEnd,
    calibration: computeCalibration(signals, outcomeBySignalId),
    rules: {
      perRule: computePerRule(signals, outcomeBySignalId),
      coOccurrence: computeCoOccurrence(signals, outcomeBySignalId),
    },
    regime: {
      byVolatility: computeByVolatility(signals, outcomeBySignalId, atrMap),
      byHour: computeByHour(signals, outcomeBySignalId),
    },
  };
}
