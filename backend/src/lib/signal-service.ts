/**
 * signal-service — read-time signal fetch + risk attachment for the Genie routes.
 *
 * Persisted BlendedSignal records always have risk: null. This service fetches
 * them from DynamoDB and attaches a per-user RiskRecommendation at read time
 * using the authenticated user's effective risk profiles and (in a future phase)
 * their Kelly stats.
 *
 * Design: Phase 7 follow-up (issue #87) — Correction 1 (read-time attach).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  BlendedSignal,
  IndicatorState,
  UserProfile,
  RiskProfileMap,
} from "@quantara/shared";
import {
  attachRiskRecommendation,
  getEffectiveRiskProfiles,
  PAIRS,
} from "@quantara/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

const INDICATOR_STATE_TABLE =
  process.env.TABLE_INDICATOR_STATE ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}indicator-state`;

// ---------------------------------------------------------------------------
// DynamoDB reads
// ---------------------------------------------------------------------------

/**
 * Fetch the latest signal for a single pair. Returns null if none found.
 * The returned signal has risk: null (as persisted).
 */
async function fetchLatestSignalForPair(
  pair: string,
): Promise<(BlendedSignal & { signalId: string; emittedAt: string }) | null> {
  const result = await client.send(
    new QueryCommand({
      TableName: SIGNALS_V2_TABLE,
      KeyConditionExpression: "#pair = :pair",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: { ":pair": pair },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const item = result.Items?.[0];
  if (!item) return null;
  return mapSignalItem(item);
}

/**
 * Fetch the N most recent signals for a pair, newest first.
 * Exported for use by the history route (Phase 8).
 */
export async function fetchRecentSignalsForPair(
  pair: string,
  limit = 20,
): Promise<Array<BlendedSignal & { signalId: string; emittedAt: string }>> {
  const result = await client.send(
    new QueryCommand({
      TableName: SIGNALS_V2_TABLE,
      KeyConditionExpression: "#pair = :pair",
      ExpressionAttributeNames: { "#pair": "pair" },
      ExpressionAttributeValues: { ":pair": pair },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (result.Items ?? []).map(mapSignalItem);
}

function mapSignalItem(
  item: Record<string, unknown>,
): BlendedSignal & { signalId: string; emittedAt: string } {
  return {
    pair: item.pair as string,
    type: item.type as BlendedSignal["type"],
    confidence: item.confidence as number,
    volatilityFlag: item.volatilityFlag as boolean,
    gateReason: item.gateReason as BlendedSignal["gateReason"],
    rulesFired: item.rulesFired as string[],
    perTimeframe: item.perTimeframe as BlendedSignal["perTimeframe"],
    weightsUsed: item.weightsUsed as BlendedSignal["weightsUsed"],
    asOf: item.asOf as number,
    emittingTimeframe: item.emittingTimeframe as BlendedSignal["emittingTimeframe"],
    // risk is always null as persisted; will be replaced at read time below
    risk: null,
    signalId: item.signalId as string,
    emittedAt: item.emittedAt as string,
  };
}

/**
 * Fetch the indicator state for a pair on its emitting timeframe.
 * Used to compute risk at read time. Returns null if not available.
 */
async function fetchIndicatorState(
  pair: string,
  timeframe: string,
  exchange = "consensus",
): Promise<IndicatorState | null> {
  const pk = `${pair}#${exchange}#${timeframe}`;
  const result = await client.send(
    new QueryCommand({
      TableName: INDICATOR_STATE_TABLE,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const item = result.Items?.[0];
  if (!item) return null;

  return {
    pair: item.pair as string,
    exchange: item.exchange as string,
    timeframe: item.timeframe as IndicatorState["timeframe"],
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the latest signal for each monitored pair, enriched with a per-user
 * risk recommendation computed at read time.
 *
 * If the indicator state for a signal is unavailable, the signal is still
 * returned but risk remains null (graceful degradation).
 *
 * @param user  The authenticated user's profile (may or may not have riskProfiles).
 */
export async function getSignalsForUser(
  user: UserProfile,
): Promise<Array<BlendedSignal & { signalId: string; emittedAt: string }>> {
  const riskProfiles = getEffectiveRiskProfiles(user);

  // Fetch latest signal for each pair in parallel
  const signalResults = await Promise.all(
    PAIRS.map((pair) => fetchLatestSignalForPair(pair)),
  );

  const signals = signalResults.filter(
    (s): s is BlendedSignal & { signalId: string; emittedAt: string } => s !== null,
  );

  // Fetch indicator state for each signal in parallel (for risk computation)
  const withRisk = await Promise.all(
    signals.map(async (signal) => {
      return attachRiskAtReadTime(signal, riskProfiles);
    }),
  );

  return withRisk;
}

/**
 * Fetch the latest signal for a specific pair, enriched with a per-user
 * risk recommendation.
 *
 * @param pair  Trading pair, e.g. "BTC/USDT".
 * @param user  The authenticated user's profile.
 */
export async function getSignalForPair(
  pair: string,
  user: UserProfile,
): Promise<(BlendedSignal & { signalId: string; emittedAt: string }) | null> {
  const riskProfiles = getEffectiveRiskProfiles(user);
  const signal = await fetchLatestSignalForPair(pair);
  if (!signal) return null;
  return attachRiskAtReadTime(signal, riskProfiles);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attach a per-user risk recommendation to a single signal.
 * Fetches the indicator state; falls back gracefully if unavailable.
 */
async function attachRiskAtReadTime(
  signal: BlendedSignal & { signalId: string; emittedAt: string },
  riskProfiles: RiskProfileMap,
): Promise<BlendedSignal & { signalId: string; emittedAt: string }> {
  // hold signals never get a risk recommendation
  if (signal.type === "hold") {
    return { ...signal, risk: null };
  }

  const state = await fetchIndicatorState(signal.pair, signal.emittingTimeframe);
  if (!state) {
    // Indicator state not available (warm-up or missing) — return signal with risk: null
    return { ...signal, risk: null };
  }

  // Phase 8 will populate KellyStats; for now pass undefined (graceful fallback
  // to vol-targeted sizing, per issue #87 out-of-scope note)
  const enriched = attachRiskRecommendation(signal, state, riskProfiles, undefined);
  return { ...enriched, signalId: signal.signalId, emittedAt: signal.emittedAt };
}
