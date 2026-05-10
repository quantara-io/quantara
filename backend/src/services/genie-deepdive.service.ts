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

export type { CalibrationBin, PerRuleRow, CoOccurrenceRow, VolatilityBucket, HourBucket };

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
 *
 * The indicator_state table is keyed `pk = pair#consensus#tf`, `sk = asOf`
 * (ISO8601 string — verified in `dynamodb.tf:377`). The PR's first cut used
 * `asOfMs` as the sort key, which is a non-key attribute, so the Query
 * always returned zero rows in production.
 *
 * Batching: we group the requested signals by (pair, tf) and issue ONE
 * Query per group with `BETWEEN windowStart AND windowEnd` on the asOf
 * range key. Each group's rows are then sorted in-memory and matched to
 * each signal's closeTime via `largest asOf <= closeTime` (the original
 * intent — capture the indicator-state snapshot at the bar's close).
 *
 * For a 30-day window across 5 pairs × 4 timeframes, this is ~20 Queries
 * total instead of one per unique signal (which could be thousands and
 * caused throttling / per-call latency overhead).
 */
async function fetchAtr14ForSignals(
  signals: SignalRecord[],
  windowStartIso: string,
  windowEndIso: string,
): Promise<Map<string, number | null>> {
  const atrMap = new Map<string, number | null>();

  // Group signals by (pair, tf) so we issue one Query per group.
  const grouped = new Map<string, SignalRecord[]>();
  for (const s of signals) {
    const groupKey = `${s.pair}#${s.emittingTimeframe}`;
    const list = grouped.get(groupKey);
    if (list) list.push(s);
    else grouped.set(groupKey, [s]);
  }

  await Promise.all(
    Array.from(grouped.entries()).map(async ([groupKey, groupSignals]) => {
      const sep = groupKey.lastIndexOf("#");
      const pair = groupKey.slice(0, sep);
      const tf = groupKey.slice(sep + 1);
      const pk = `${pair}#consensus#${tf}`;

      try {
        // One Query per (pair, tf) — fetch all indicator-state rows in the
        // request window, then in-memory match each signal to its row.
        const rows: { asOf: string; atr14: number | null }[] = [];
        let lastKey: Record<string, unknown> | undefined;
        do {
          const result = await dynamo.send(
            new QueryCommand({
              TableName: INDICATOR_STATE_TABLE,
              KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :since AND :until",
              ExpressionAttributeNames: { "#pk": "pk", "#sk": "asOf" },
              ExpressionAttributeValues: {
                ":pk": pk,
                ":since": windowStartIso,
                ":until": windowEndIso,
              },
              ExclusiveStartKey: lastKey,
            }),
          );
          for (const item of result.Items ?? []) {
            const asOf = item.asOf as string | undefined;
            if (typeof asOf !== "string") continue;
            const atr14 = (item as IndicatorItem).atr14 ?? null;
            rows.push({ asOf, atr14 });
          }
          lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
        } while (lastKey !== undefined);

        // Sort ascending by asOf so we can find the largest asOf ≤ a signal's
        // closeTime via a single linear scan per signal. (For 30 days × 4 tfs
        // we expect ~hundreds of rows max — linear is fine.)
        rows.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));

        for (const s of groupSignals) {
          const closeIso = new Date(s.closeTime).toISOString();
          const key = `${s.pair}#${s.emittingTimeframe}#${s.closeTime}`;
          // Largest asOf ≤ closeIso — walk back from the end.
          let found: number | null = null;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i].asOf <= closeIso) {
              found = rows[i].atr14;
              break;
            }
          }
          atrMap.set(key, found);
        }
      } catch {
        // On Query failure, mark every signal in this group as null so the
        // regime breakdown still produces partial results for other groups.
        for (const s of groupSignals) {
          const key = `${s.pair}#${s.emittingTimeframe}#${s.closeTime}`;
          atrMap.set(key, null);
        }
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
    fetchAtr14ForSignals(signals, windowStart, windowEnd),
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
