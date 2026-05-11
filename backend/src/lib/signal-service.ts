/**
 * signal-service — backend read path for trading signals.
 *
 * On every fetch, the user record is lazily bootstrapped (getOrCreateUserRecord)
 * so that:
 *  - First-time users get tier="free" + conservative risk defaults automatically.
 *  - Existing users' profiles (including per-pair overrides) are preserved.
 *
 * This is the ONLY place where user-store bootstrap is invoked from the
 * signal read path. It is never called from auth routes or JWT middleware.
 *
 * Read path:
 *   signals_v2 table — PK: pair, SK: emittedAtSignalId (ISO8601#uuid).
 *   Queried with ScanIndexForward: false, Limit: 1 to get the latest signal
 *   for a pair, or Limit: N to get recent signals across all pairs.
 *
 *   The table is written by the indicator Lambda handler (ingestion service).
 *   If the table is empty (no signals emitted yet), these functions return
 *   null / [] — that is the correct empty-state behavior, not a bug.
 *   Once the indicator handler has emitted at least one signal for a pair,
 *   the read path returns it without any further code changes.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { BlendedSignal, IndicatorState, Timeframe, KellyStats } from "@quantara/shared";
import {
  PAIRS,
  type TradingPair,
  attachRiskRecommendation,
  buildInterpretation,
  defaultRiskProfiles,
  defaultBlendProfiles,
  getBlendProfile,
  reblendWithProfile,
} from "@quantara/shared";
import type { z } from "@hono/zod-openapi";

import { BlendedSignalSchema } from "./schemas/genie.js";
import { getOrCreateUserRecord } from "./user-store.js";
import type { SignalHistoryEntry } from "./schemas/genie.js";

export type { TradingPair };
export { PAIRS };

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

const INDICATOR_STATE_TABLE =
  process.env.TABLE_INDICATOR_STATE ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}indicator-state`;

const SIGNAL_OUTCOMES_TABLE =
  process.env.TABLE_SIGNAL_OUTCOMES ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signal-outcomes`;

const CALIBRATION_TABLE =
  process.env.TABLE_CALIBRATION_PARAMS ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}calibration-params`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw DynamoDB item to a BlendedSignal.
 *
 * Validates against BlendedSignalSchema rather than blind-casting — schemas
 * exist to gate trust at the system boundary. If the persisted shape diverges
 * from the schema (e.g. an indicator-handler regression writes garbage),
 * we throw early at parse time with a clear error rather than propagating
 * undefined fields to callers.
 */
function itemToBlendedSignal(item: Record<string, unknown>): BlendedSignal {
  const parsed = BlendedSignalSchema.parse(item);
  // The parsed shape is structurally identical to BlendedSignal; cast through unknown to
  // satisfy TypeScript without a runtime trip (parse already validated).
  const signal = parsed as unknown as BlendedSignal;

  // Phase B2 (#171) — always populate interpretation so clients get a consolidated
  // narrative without having to stitch ratificationVerdict + rulesFired themselves.
  // buildInterpretation is pure and handles all ratificationStatus values including null.
  if (!signal.interpretation) {
    signal.interpretation = buildInterpretation(signal);
  }

  return signal;
}

/**
 * Retrieve the most-recent IndicatorState for a pair/exchange/timeframe from DynamoDB.
 * Returns null when no snapshot exists.
 *
 * This mirrors the ingestion-side getLatestIndicatorState but lives in the backend
 * workspace so the signal-service can import it without crossing workspace boundaries.
 */
async function getLatestIndicatorStateForSignal(
  pair: string,
  exchange: string,
  timeframe: Timeframe,
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
    pair: item["pair"] as string,
    exchange: item["exchange"] as string,
    timeframe: item["timeframe"] as Timeframe,
    asOf: item["asOfMs"] as number,
    barsSinceStart: item["barsSinceStart"] as number,
    rsi14: (item["rsi14"] as number | null) ?? null,
    ema20: (item["ema20"] as number | null) ?? null,
    ema50: (item["ema50"] as number | null) ?? null,
    ema200: (item["ema200"] as number | null) ?? null,
    macdLine: (item["macdLine"] as number | null) ?? null,
    macdSignal: (item["macdSignal"] as number | null) ?? null,
    macdHist: (item["macdHist"] as number | null) ?? null,
    atr14: (item["atr14"] as number | null) ?? null,
    bbUpper: (item["bbUpper"] as number | null) ?? null,
    bbMid: (item["bbMid"] as number | null) ?? null,
    bbLower: (item["bbLower"] as number | null) ?? null,
    bbWidth: (item["bbWidth"] as number | null) ?? null,
    obv: (item["obv"] as number | null) ?? null,
    obvSlope: (item["obvSlope"] as number | null) ?? null,
    vwap: (item["vwap"] as number | null) ?? null,
    volZ: (item["volZ"] as number | null) ?? null,
    realizedVolAnnualized: (item["realizedVolAnnualized"] as number | null) ?? null,
    fearGreed: (item["fearGreed"] as number | null) ?? null,
    dispersion: (item["dispersion"] as number | null) ?? null,
    history: item["history"] as IndicatorState["history"],
  };
}

/**
 * Retrieve Kelly stats for a (pair, timeframe, direction) slice from the
 * calibration-params table written by the calibration-job Lambda (Phase 7/8).
 *
 * Returns null silently when no row exists — the risk path falls back to
 * vol-targeted sizing (pre-Kelly-unlock behavior).
 */
async function getKellyStatsFromCalibration(
  pair: string,
  timeframe: Timeframe,
  direction: "buy" | "sell",
): Promise<KellyStats | null> {
  const pk = `kelly#${pair}#${timeframe}#${direction}`;
  try {
    const result = await client.send(
      new GetCommand({
        TableName: CALIBRATION_TABLE,
        Key: { pk },
      }),
    );
    if (!result.Item) return null;
    const item = result.Item;
    return {
      pair,
      timeframe,
      direction,
      resolved: item["resolved"] as number,
      p: item["p"] as number,
      b: item["b"] as number,
    };
  } catch {
    // Non-fatal: calibration table may not exist yet or be empty in early deployment.
    return null;
  }
}

/**
 * Enrich a BlendedSignal with the user's risk recommendation.
 * Fetches the IndicatorState for the signal's pair/timeframe, then calls
 * attachRiskRecommendation. Also fetches Kelly stats from the calibration-params
 * table (Phase 7/8) so aggressive-profile users get Kelly sizing when unlocked.
 * Silently falls back to the original signal if the IndicatorState is unavailable.
 *
 * @param signal        The BlendedSignal (already re-blended with user's profile).
 * @param riskProfiles  User's per-pair risk profile map.
 */
async function enrichWithRisk(
  signal: BlendedSignal,
  riskProfiles: ReturnType<typeof defaultRiskProfiles>,
): Promise<BlendedSignal> {
  if (signal.type === "hold") {
    // Hold signals get risk: null — no IndicatorState fetch needed.
    return { ...signal, risk: null };
  }

  const state = await getLatestIndicatorStateForSignal(
    signal.pair,
    "consensus",
    signal.emittingTimeframe,
  );

  if (!state) {
    // IndicatorState not yet available (warm-up period) — return signal unchanged.
    return signal;
  }

  // Phase 7 Kelly unlock (§9.3.1): fetch per-(pair, TF, direction) Kelly stats
  // from the calibration-params table. Returns null when absent — falls back to
  // vol-targeted sizing (current behavior preserved for all non-aggressive profiles).
  const direction = signal.type as "buy" | "sell";
  const kellyStats = await getKellyStatsFromCalibration(
    signal.pair,
    signal.emittingTimeframe,
    direction,
  );

  // attachRiskRecommendation expects kellyByPair keyed by pair.
  const kellyByPair: Record<string, KellyStats | undefined> = kellyStats
    ? { [signal.pair]: kellyStats }
    : {};

  return attachRiskRecommendation(signal, state, riskProfiles, kellyByPair);
}

/**
 * Apply the user's BlendProfile to a stored BlendedSignal and re-populate
 * interpretation. Called once per signal on the read path before enrichWithRisk.
 *
 * Storage (signals_v2) always uses the strict profile — canonical blend has one
 * ground truth for calibration / outcome attribution. Profile application is
 * read-only: only the response shape changes.
 *
 * @param signal       The stored BlendedSignal (canonical strict blend).
 * @param pair         The trading pair (used to look up the per-pair blend profile).
 * @param blendProfiles User's per-pair BlendProfileMap (may be absent on old records).
 */
function applyBlendProfile(
  signal: BlendedSignal,
  pair: TradingPair,
  blendProfiles: ReturnType<typeof defaultBlendProfiles> | undefined,
): BlendedSignal {
  const profile = getBlendProfile(blendProfiles, pair);
  // "strict" is the canonical stored blend — no re-blend needed.
  if (profile === "strict") return signal;

  const reblended = reblendWithProfile(signal, profile);
  // Re-derive interpretation after profile re-blend so the narrative reflects
  // the profile-adjusted type/confidence, not the stored strict values.
  return {
    ...reblended,
    interpretation: buildInterpretation(reblended),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the latest signal for a pair, enriching with the user's risk profile.
 * Bootstraps the user record on first call.
 *
 * Returns null when no signal has been emitted for this pair yet — this is
 * normal during early deployment before the indicator handler has processed
 * sufficient candle data for the pair.
 *
 * @param userId  Authenticated user id (AuthContext.userId).
 * @param pair    Trading pair — must be a member of PAIRS.
 * @param email   Optional email from JWT claims passed to bootstrap.
 * @returns       The latest BlendedSignal with risk populated, or null if none available.
 */
export async function getSignalForUser(
  userId: string,
  pair: TradingPair,
  email?: string,
): Promise<BlendedSignal | null> {
  // Lazy bootstrap — creates record with tier="free" on first authenticated request.
  const user = await getOrCreateUserRecord(userId, email);

  // signals-v2 SK is `tf#closeTime` (deterministic dedup key, v6 design).
  // Reverse-scan + Limit=1 alone returns the lexicographically-last (tf, closeTime),
  // which is the alphabetically-last TF — not the most recent across TFs.
  // Query each blended TF separately and pick the latest by closeTime.
  const item = await fetchLatestSignalRow(pair);
  if (!item) return null;

  const raw = itemToBlendedSignal(item);
  const riskProfiles = user.riskProfiles ?? defaultRiskProfiles(user.tier ?? "free");
  // Apply user's blend profile (re-blend on read) before enriching with risk.
  // "strict" is a no-op (stored signal already uses strict); balanced/aggressive
  // re-run the §5.3 math against the persisted perTimeframe votes.
  const profiled = applyBlendProfile(raw, pair, user.blendProfiles);
  return enrichWithRisk(profiled, riskProfiles);
}

const BLEND_TIMEFRAMES: readonly Timeframe[] = ["15m", "1h", "4h", "1d"];

/**
 * Fetch the latest signals-v2 row for `pair` across all blended TFs.
 *
 * Issues one Query per TF (4 total) and returns the row with the highest
 * `closeTime` numeric value. Returns null when no TF has any signal yet.
 *
 * Required because v6 signals-v2 SK = `tf#closeTime`: reverse-scan returns
 * the alphabetically-last TF, not the most recent slot. Per-TF queries
 * then merge-by-time is the correct latest-overall pattern.
 */
async function fetchLatestSignalRow(pair: TradingPair): Promise<Record<string, unknown> | null> {
  // Tie-break authority: at hour/4h/day boundaries multiple TFs share the same
  // closeTime. The higher TF carries more weight in §5.2 (1d > 4h > 1h > 15m),
  // so on equal closeTime, prefer the higher TF rather than letting "first scanned"
  // (15m, alphabetical) win.
  const TF_AUTHORITY: Record<Timeframe, number> = {
    "1m": 0,
    "5m": 1,
    "15m": 2,
    "1h": 3,
    "4h": 4,
    "1d": 5,
  };

  const perTf = await Promise.all(
    BLEND_TIMEFRAMES.map(async (tf) => {
      const r = await client.send(
        new QueryCommand({
          TableName: SIGNALS_V2_TABLE,
          KeyConditionExpression: "#pair = :pair AND begins_with(sk, :tfPrefix)",
          ExpressionAttributeNames: { "#pair": "pair" },
          ExpressionAttributeValues: { ":pair": pair, ":tfPrefix": `${tf}#` },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
      // Defensive: a missing response (test mock not set, network blip)
      // should yield "no signal for this TF" rather than blow up the whole call.
      const item = r?.Items?.[0];
      return item ? { tf, item } : undefined;
    }),
  );

  let best: { tf: Timeframe; item: Record<string, unknown> } | undefined;
  for (const candidate of perTf) {
    if (!candidate) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const candidateAsOf = Number(candidate.item["asOf"] ?? 0);
    const bestAsOf = Number(best.item["asOf"] ?? 0);
    if (candidateAsOf > bestAsOf) {
      best = candidate;
    } else if (candidateAsOf === bestAsOf && TF_AUTHORITY[candidate.tf] > TF_AUTHORITY[best.tf]) {
      // Same close boundary across TFs: prefer the more authoritative TF.
      best = candidate;
    }
  }
  return best?.item ?? null;
}

/**
 * Fetch all latest signals (one per pair), bootstrapping the user record if needed.
 *
 * Returns an empty array when no signals have been emitted yet — correct
 * empty-state behavior while the indicator handler warms up.
 *
 * @param userId  Authenticated user id.
 * @param email   Optional email from JWT claims.
 * @returns       Array of latest BlendedSignals with risk populated (one per pair, empty when none).
 */
export async function getAllSignalsForUser(
  userId: string,
  email?: string,
): Promise<BlendedSignal[]> {
  const user = await getOrCreateUserRecord(userId, email);
  const riskProfiles = user.riskProfiles ?? defaultRiskProfiles(user.tier ?? "free");

  // Fetch the latest signal across all 4 blended TFs for each pair in parallel.
  // See fetchLatestSignalRow above for why per-TF queries are required (v6 SK = tf#closeTime).
  const results = await Promise.all(
    PAIRS.map(async (pair) => {
      const item = await fetchLatestSignalRow(pair);
      if (!item) return null;
      const raw = itemToBlendedSignal(item);
      // Apply user's blend profile (re-blend on read) before enriching with risk.
      const profiled = applyBlendProfile(raw, pair, user.blendProfiles);
      return enrichWithRisk(profiled, riskProfiles);
    }),
  );

  return results.filter((s): s is BlendedSignal => s !== null);
}

// ---------------------------------------------------------------------------
// Signal history (Gap 5) — reads from signal-outcomes table
// ---------------------------------------------------------------------------

export type SignalHistoryEntryType = z.infer<typeof SignalHistoryEntry>;

export interface SignalHistoryResult {
  history: SignalHistoryEntryType[];
  total: number;
  hasMore: boolean;
  /** DynamoDB cursor for the next page — undefined when no more pages. */
  nextCursor?: string;
}

/**
 * Fetch paginated signal history for a user from the signal-outcomes table.
 *
 * Uses DynamoDB LastEvaluatedKey-based cursor pagination — not page-number-based,
 * since DDB doesn't support efficient skip. The cursor is returned as an opaque
 * base64 string the client echoes back.
 *
 * @param userId    Authenticated user id (unused in query, kept for future per-user scoping).
 * @param email     User email (unused in query, kept for bootstrap path).
 * @param options   Pagination options.
 */
export async function getSignalHistoryForUser(
  userId: string,
  email: string | undefined,
  options: { pageSize: number; pair?: string; cursor?: string },
): Promise<SignalHistoryResult> {
  // Bootstrap to ensure user record exists (consistent with other service functions).
  await getOrCreateUserRecord(userId, email);

  const { pageSize, pair, cursor } = options;

  // Decode opaque cursor → DDB ExclusiveStartKey.
  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (cursor) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      // Malformed cursor — ignore and start from beginning.
      exclusiveStartKey = undefined;
    }
  }

  // If pair filter is specified, query by pair PK; otherwise scan all pairs sequentially.
  // Phase 8 writes signal-outcomes with PK=pair, SK=signalId.
  let items: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  if (pair) {
    const result = await client.send(
      new QueryCommand({
        TableName: SIGNAL_OUTCOMES_TABLE,
        KeyConditionExpression: "#pair = :pair",
        ExpressionAttributeNames: { "#pair": "pair" },
        ExpressionAttributeValues: { ":pair": pair },
        ScanIndexForward: false,
        Limit: pageSize,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items = (result.Items ?? []) as Record<string, unknown>[];
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } else {
    // No pair filter: iterate over all known pairs, collecting up to pageSize items total.
    // This is not efficient for large result sets but sufficient for the UI history view
    // which defaults to pageSize=20. Future improvement: add a GSI on resolvedAt.
    for (const p of PAIRS) {
      if (items.length >= pageSize) break;

      const remaining = pageSize - items.length;
      const result = await client.send(
        new QueryCommand({
          TableName: SIGNAL_OUTCOMES_TABLE,
          KeyConditionExpression: "#pair = :pair",
          ExpressionAttributeNames: { "#pair": "pair" },
          ExpressionAttributeValues: { ":pair": p },
          ScanIndexForward: false,
          Limit: remaining,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      const pairItems = (result.Items ?? []) as Record<string, unknown>[];
      items = items.concat(pairItems);
      // Only track cursor for the last pair with a non-null LastEvaluatedKey.
      if (result.LastEvaluatedKey) {
        lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown>;
      } else {
        lastEvaluatedKey = undefined;
      }
    }
  }

  // Map OutcomeRecord → SignalHistoryEntry.
  const history: SignalHistoryEntryType[] = items.map((item) => ({
    signalId: item["signalId"] as string,
    pair: item["pair"] as string,
    type: item["type"] as "buy" | "sell" | "hold",
    confidence: item["confidence"] as number,
    createdAt: item["createdAt"] as string,
    outcome: item["outcome"] as "correct" | "incorrect" | "neutral" | "pending",
    priceAtSignal: item["priceAtSignal"] as number,
    priceAtResolution: (item["priceAtResolution"] as number | null | undefined) ?? null,
  }));

  // Encode cursor for client.
  const nextCursor = lastEvaluatedKey
    ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64")
    : undefined;

  return {
    history,
    total: history.length,
    hasMore: nextCursor !== undefined,
    nextCursor,
  };
}
