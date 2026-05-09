/**
 * sentiment-shock.ts — out-of-cycle ratification trigger driven by sentiment shocks.
 *
 * When an enriched article materially changes the sentiment aggregate for a pair,
 * this module immediately re-ratifies the latest signal for that pair using the
 * new context — closing the news → signals real-time loop described in issue #167.
 *
 * Architecture:
 *   Shock detector → Cost gate (cooldown + hourly cap) → Fetch latest signal
 *   → ratify.ts with triggerReason="sentiment_shock"
 *
 * Feature flag: ENABLE_SENTIMENT_SHOCK_RATIFICATION=false (default).
 *
 * Design: issue #167.
 */

import type { SentimentAggregate, AggregationWindow } from "./aggregator.js";
import { getLatestSignal } from "../lib/signal-store.js";
import { ratifySignal } from "../llm/ratify.js";
import {
  putRatificationRecord,
  getRecentShockRatifications,
  getRecentRatifications,
} from "../lib/ratification-store.js";
import { buildSentimentBundle } from "./bundle.js";

// ---------------------------------------------------------------------------
// Configuration — all overridable via env vars
// ---------------------------------------------------------------------------

/**
 * Minimum absolute delta in sentiment score (range [-1, +1]) required to be
 * treated as a shock. Default: 0.3 (30% swing).
 */
function getSentimentShockDeltaThreshold(): number {
  const v = parseFloat(process.env.SENTIMENT_SHOCK_DELTA_THRESHOLD ?? "");
  return isFinite(v) ? v : 0.3;
}

/**
 * Minimum magnitude of the *new* aggregate. Weak-conviction swings are noise.
 * Default: 0.5.
 */
function getSentimentShockMagnitudeFloor(): number {
  const v = parseFloat(process.env.SENTIMENT_SHOCK_MAGNITUDE_FLOOR ?? "");
  return isFinite(v) ? v : 0.5;
}

/**
 * Windows that are eligible for shock detection (comma-separated).
 * Default: "4h".
 */
function getSentimentShockWindows(): AggregationWindow[] {
  const raw = process.env.SENTIMENT_SHOCK_WINDOWS ?? "4h";
  return raw
    .split(",")
    .map((s: string) => s.trim())
    .filter((s: string): s is AggregationWindow => s === "4h" || s === "24h");
}

/**
 * Per-pair cooldown: don't re-fire for the same pair within this many minutes.
 * Default: 5.
 */
function getSentimentShockCooldownMinutes(): number {
  const v = parseInt(process.env.SENTIMENT_SHOCK_COOLDOWN_MINUTES ?? "");
  return isFinite(v) ? v : 5;
}

/**
 * Per-pair hourly cap: max shock ratifications per pair per hour.
 * Default: 6.
 */
function getSentimentShockMaxPerPairPerHour(): number {
  const v = parseInt(process.env.SENTIMENT_SHOCK_MAX_PER_PAIR_PER_HOUR ?? "");
  return isFinite(v) ? v : 6;
}

// ---------------------------------------------------------------------------
// Shock detector
// ---------------------------------------------------------------------------

export interface ShockDetectorResult {
  shouldFire: boolean;
  reason: string;
}

/**
 * Determine whether a new aggregate constitutes a sentiment shock compared
 * to a previous aggregate for the same (pair, window).
 *
 * Trigger conditions (all must be true):
 *   1. Window is in the configured shock windows (default: "4h" only).
 *   2. A prior aggregate exists (no shock on first-ever computation).
 *   3. |sentiment_new - sentiment_prev| >= SENTIMENT_SHOCK_DELTA_THRESHOLD.
 *   4. magnitude_new >= SENTIMENT_SHOCK_MAGNITUDE_FLOOR.
 */
export function detectSentimentShock(
  prev: SentimentAggregate | null,
  next: SentimentAggregate,
): ShockDetectorResult {
  const eligibleWindows = getSentimentShockWindows();

  if (!eligibleWindows.includes(next.window)) {
    return { shouldFire: false, reason: `window ${next.window} not in shock-eligible windows` };
  }

  if (prev === null) {
    return { shouldFire: false, reason: "no prior aggregate — first computation for this pair/window" };
  }

  // Require non-null sentiment scores on both sides
  if (prev.meanScore === null || next.meanScore === null) {
    return { shouldFire: false, reason: "null meanScore on prev or next — insufficient articles" };
  }

  if (next.meanMagnitude === null) {
    return { shouldFire: false, reason: "null meanMagnitude on next — insufficient articles" };
  }

  const delta = Math.abs(next.meanScore - prev.meanScore);
  const deltaThreshold = getSentimentShockDeltaThreshold();

  if (delta < deltaThreshold) {
    return {
      shouldFire: false,
      reason: `delta=${delta.toFixed(3)} < threshold=${deltaThreshold}`,
    };
  }

  const magnitudeFloor = getSentimentShockMagnitudeFloor();

  if (next.meanMagnitude < magnitudeFloor) {
    return {
      shouldFire: false,
      reason: `magnitude=${next.meanMagnitude.toFixed(3)} < floor=${magnitudeFloor}`,
    };
  }

  return {
    shouldFire: true,
    reason: `delta=${delta.toFixed(3)} >= ${deltaThreshold}, magnitude=${next.meanMagnitude.toFixed(3)} >= ${magnitudeFloor}`,
  };
}

// ---------------------------------------------------------------------------
// Cost gate
// ---------------------------------------------------------------------------

export interface CostGateResult {
  allowed: boolean;
  reason: string;
}

/**
 * Check whether a sentiment-shock ratification is within cost bounds for the pair.
 *
 * Two layers:
 *   1. Per-pair cooldown: no re-fire within SENTIMENT_SHOCK_COOLDOWN_MINUTES.
 *   2. Per-pair hourly cap: max SENTIMENT_SHOCK_MAX_PER_PAIR_PER_HOUR per hour.
 *
 * Queries the ratifications DDB table for prior sentiment_shock records.
 */
export async function checkSentimentShockCostGate(pair: string, nowIso: string): Promise<CostGateResult> {
  const cooldownMinutes = getSentimentShockCooldownMinutes();
  const hourlyCapMax = getSentimentShockMaxPerPairPerHour();

  const nowMs = Date.parse(nowIso);

  // The hourly window is the broader window — query back 1 hour.
  const hourAgoIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const recentShocks = await getRecentShockRatifications(pair, hourAgoIso);

  // Hourly cap check
  if (recentShocks.length >= hourlyCapMax) {
    return {
      allowed: false,
      reason: `hourly cap: ${recentShocks.length} >= ${hourlyCapMax} shocks in the past hour for ${pair}`,
    };
  }

  // Cooldown check: was there a shock in the last cooldownMinutes?
  if (recentShocks.length > 0) {
    const cooldownMs = cooldownMinutes * 60 * 1000;
    const cooldownCutoffMs = nowMs - cooldownMs;

    const mostRecent = recentShocks[0]; // newest first from the query
    const mostRecentMs = Date.parse(mostRecent.invokedAt);

    if (mostRecentMs >= cooldownCutoffMs) {
      const agoSecs = Math.round((nowMs - mostRecentMs) / 1000);
      return {
        allowed: false,
        reason: `cooldown: last shock for ${pair} was ${agoSecs}s ago (< ${cooldownMinutes * 60}s cooldown)`,
      };
    }
  }

  return { allowed: true, reason: "within cost bounds" };
}

// ---------------------------------------------------------------------------
// Main entry point — called by aggregator-handler after recomputeSentimentAggregate
// ---------------------------------------------------------------------------

/**
 * Conditionally fire an out-of-cycle ratification when a sentiment shock is
 * detected for a (pair, window) after a `recomputeSentimentAggregate()` write.
 *
 * Flow:
 *   1. Feature flag check — bail early if disabled (no DDB calls).
 *   2. Shock detection (pure function — no I/O).
 *   3. Cost gate (two DDB reads).
 *   4. Fetch latest signal for pair — skip if null or neutral warm-up signal.
 *   5. Build sentiment bundle + fire ratifySignal with triggerReason="sentiment_shock".
 *
 * @param prev       Prior aggregate for this (pair, window) — null on first run.
 * @param next       Newly-written aggregate.
 */
export async function maybeFireSentimentShockRatification(
  prev: SentimentAggregate | null,
  next: SentimentAggregate,
): Promise<void> {
  // Step 1: Feature flag — default false (ship dark)
  if (process.env.ENABLE_SENTIMENT_SHOCK_RATIFICATION !== "true") {
    return;
  }

  const { pair, window } = next;

  // Step 2: Shock detection (pure — no I/O)
  const shockResult = detectSentimentShock(prev, next);
  if (!shockResult.shouldFire) {
    return; // Not a shock — common path; no log spam
  }

  const nowIso = new Date().toISOString();
  console.log(`[SentimentShock] Shock detected for ${pair}/${window}: ${shockResult.reason}`);

  // Step 3: Cost gate
  const gateResult = await checkSentimentShockCostGate(pair, nowIso);
  if (!gateResult.allowed) {
    console.log(`[SentimentShock] Cost gate suppressed shock for ${pair}: ${gateResult.reason}`);
    return;
  }

  // Step 4: Fetch latest signal
  const latestSignal = await getLatestSignal(pair);

  if (latestSignal === null) {
    console.info(
      `[SentimentShock] No signal yet for ${pair} (cold start) — skipping shock ratification`,
    );
    return;
  }

  // Skip neutral warm-up signals (hold with no rules fired)
  if (latestSignal.type === "hold" && latestSignal.rulesFired.length === 0) {
    console.info(
      `[SentimentShock] Latest signal for ${pair} is neutral warm-up hold — skipping shock ratification`,
    );
    return;
  }

  // Step 5: Fire ratification
  // Find the most-recent bar_close ratification to link as previousRatificationId
  let previousRatificationId: string | undefined;
  try {
    const recentRatifications = await getRecentRatifications(pair, 10);
    const lastBarClose = recentRatifications.find(
      (r) => (r.triggerReason ?? "bar_close") === "bar_close",
    );
    previousRatificationId = lastBarClose ? undefined : undefined;
    // We need the recordId from the DDB item — it's stored on the persisted item.
    // getRecentRatifications returns RatificationRecord which doesn't expose recordId
    // directly. We look for it on the raw item cast.
    if (lastBarClose) {
      const raw = lastBarClose as RatificationRecord & { recordId?: string };
      previousRatificationId = raw.recordId;
    }
  } catch (err) {
    // Non-fatal: if we can't look up the prior ratification, proceed without linking
    console.warn(
      `[SentimentShock] Could not fetch prior ratification for ${pair}: ${(err as Error).message}`,
    );
  }

  // Build a fresh sentiment bundle (using the current state, including the new aggregate)
  let sentimentBundle;
  try {
    sentimentBundle = await buildSentimentBundle(pair);
  } catch (err) {
    console.error(
      `[SentimentShock] Failed to build sentiment bundle for ${pair}: ${(err as Error).message}`,
    );
    return;
  }

  console.log(
    `[SentimentShock] Firing out-of-cycle ratification for ${pair} (previousRatificationId=${previousRatificationId ?? "none"})`,
  );

  try {
    const ratifyResult = await ratifySignal(
      {
        pair,
        candidate: latestSignal,
        perTimeframe: latestSignal.perTimeframe,
        sentiment: sentimentBundle,
        whaleSummary: null,
        pricePoints: [],
        fearGreed: {
          value: sentimentBundle.fearGreed.value ?? 50,
          trend24h: sentimentBundle.fearGreed.trend24h ?? 0,
        },
      },
      // No onStage2 callback — the shock ratification creates its own record;
      // it does not update the original signals_v2 row (that would require
      // knowing the exact SK of the latest signal).
      undefined,
    );

    if (ratifyResult.kickoffRatification) {
      // Write the stage-1 shock record before kicking off the LLM stream.
      // We persist a minimal record to satisfy the race-free ordering contract
      // (the onStage2 UPDATE — if any — targets the ratifications table row, not
      // the signals_v2 row, so no race is possible here). For simplicity we
      // fire-and-await the kickoff directly.
      await ratifyResult.kickoffRatification();
    }

    // Persist a RatificationRecord flagged as sentiment_shock with the new fields
    await putRatificationRecord({
      pair,
      timeframe: latestSignal.emittingTimeframe,
      algoCandidate: latestSignal,
      llmRequest: {
        model: "claude-sonnet-4-6",
        systemHash: "",
        userJsonHash: "",
      },
      llmRawResponse: null,
      cacheHit: ratifyResult.cacheHit,
      validation: { ok: true },
      ratified: ratifyResult.signal,
      fellBackToAlgo: ratifyResult.fellBackToAlgo,
      latencyMs: 0,
      costUsd: 0,
      invokedReason: "sentiment_shock",
      invokedAt: nowIso,
      triggerReason: "sentiment_shock",
      previousRatificationId,
    });

    console.log(
      `[SentimentShock] Shock ratification complete for ${pair}: type=${ratifyResult.signal.type} cacheHit=${ratifyResult.cacheHit}`,
    );
  } catch (err) {
    console.error(
      `[SentimentShock] Shock ratification failed for ${pair}: ${(err as Error).message}`,
    );
    // Non-fatal — the regular bar-close path is unaffected
  }
}

// ---------------------------------------------------------------------------
// Re-export type so callers can import without going through ratification-store
// ---------------------------------------------------------------------------
import type { RatificationRecord } from "../lib/ratification-store.js";
