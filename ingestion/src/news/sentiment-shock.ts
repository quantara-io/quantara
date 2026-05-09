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

import { PAIRS, type TradingPair } from "@quantara/shared";

import { getRecentShockRatifications, getRecentRatifications } from "../lib/ratification-store.js";
import { getLatestSignal } from "../lib/signal-store.js";
import { ratifySignal } from "../llm/ratify.js";

import type { SentimentAggregate, AggregationWindow } from "./aggregator.js";
import { buildSentimentBundle, type SentimentBundle } from "./bundle.js";

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
    return {
      shouldFire: false,
      reason: "no prior aggregate — first computation for this pair/window",
    };
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
 *
 * Pagination: `getRecentShockRatifications` is asked for `cap + 1` rows so the
 * cap comparison is accurate for any configured cap value (not just <= 20).
 * The helper internally paginates through DDB pages because filtered results
 * (`triggerReason = sentiment_shock`) can be sparser than the per-page Limit.
 */
export async function checkSentimentShockCostGate(
  pair: string,
  nowIso: string,
): Promise<CostGateResult> {
  const cooldownMinutes = getSentimentShockCooldownMinutes();
  const hourlyCapMax = getSentimentShockMaxPerPairPerHour();

  const nowMs = Date.parse(nowIso);

  // The hourly window is the broader window — query back 1 hour.
  const hourAgoIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
  // Ask for cap + 1 so the >= cap comparison is decisive regardless of how
  // the cap is configured. Without this, raising the cap above the helper's
  // default page-size made the gate fail open.
  const recentShocks = await getRecentShockRatifications(pair, hourAgoIso, hourlyCapMax + 1);

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
// Symbol → trading-pair normalization
// ---------------------------------------------------------------------------

/**
 * Map a bare news symbol like `"BTC"` (produced by `tagPairs` and the
 * aggregator's per-pair fan-out) to the trading-pair form `"BTC/USDT"` used
 * as the partition key in `signals-v2` and the broader signal/order pipeline.
 *
 * Returns `null` for symbols Quantara doesn't trade (the news enrichment can
 * tag pairs we have no signal stream for; those should be dropped, not passed
 * to `getLatestSignal` where they'd silently miss every lookup).
 *
 * Also accepts an already-normalized trading pair as input (idempotent), so
 * callers don't have to discriminate between input shapes.
 */
export function symbolToTradingPair(symbol: string): TradingPair | null {
  // Already in trading-pair form?
  if ((PAIRS as readonly string[]).includes(symbol)) {
    return symbol as TradingPair;
  }
  const candidate = `${symbol}/USDT`;
  if ((PAIRS as readonly string[]).includes(candidate)) {
    return candidate as TradingPair;
  }
  return null;
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
 *   3. Symbol normalization (`BTC` → `BTC/USDT`); skip if not a trading pair.
 *   4. Cost gate (paginated DDB query).
 *   5. Fetch latest signal for the trading pair — skip if null or neutral warm-up.
 *   6. Look up previous bar_close ratification's `recordId` for the trace link.
 *   7. Build (or reuse) a sentiment bundle.
 *   8. Fire `ratifySignal` with `triggerReason: "sentiment_shock"` so the single
 *      RatificationRecord it persists carries shock metadata. NO duplicate
 *      put — `ratifySignal` writes the only record for this shock event.
 *
 * @param prev             Prior aggregate for this (pair, window) — null on first run.
 * @param next             Newly-written aggregate.
 * @param precomputedBundle Optional pre-built SentimentBundle. When the caller
 *                         already has aggregates for this pair (e.g. the
 *                         aggregator-handler computes 4h + 24h on every event),
 *                         passing it skips the redundant `recomputeSentimentAggregate`
 *                         calls inside `buildSentimentBundle`.
 */
export async function maybeFireSentimentShockRatification(
  prev: SentimentAggregate | null,
  next: SentimentAggregate,
  precomputedBundle?: SentimentBundle,
): Promise<void> {
  // Step 1: Feature flag — default false (ship dark)
  if (process.env.ENABLE_SENTIMENT_SHOCK_RATIFICATION !== "true") {
    return;
  }

  const { pair: rawSymbol, window } = next;

  // Step 2: Shock detection (pure — no I/O)
  const shockResult = detectSentimentShock(prev, next);
  if (!shockResult.shouldFire) {
    return; // Not a shock — common path; no log spam
  }

  // Step 3: Symbol normalization. The aggregator fan-out keys by bare symbols
  // (e.g. "BTC") via `tagPairs`/`ALL_PAIRS`, but `signals-v2` is keyed by
  // trading pairs ("BTC/USDT"). Without this normalisation `getLatestSignal`
  // misses every shock and the feature is silently broken in production.
  const tradingPair = symbolToTradingPair(rawSymbol);
  if (tradingPair === null) {
    console.info(
      `[SentimentShock] Symbol ${rawSymbol} has no matching trading pair — skipping shock`,
    );
    return;
  }

  const nowIso = new Date().toISOString();
  console.log(
    `[SentimentShock] Shock detected for ${rawSymbol} → ${tradingPair}/${window}: ${shockResult.reason}`,
  );

  // Step 4: Cost gate
  const gateResult = await checkSentimentShockCostGate(tradingPair, nowIso);
  if (!gateResult.allowed) {
    console.log(
      `[SentimentShock] Cost gate suppressed shock for ${tradingPair}: ${gateResult.reason}`,
    );
    return;
  }

  // Step 5: Fetch latest signal
  const latestSignal = await getLatestSignal(tradingPair);

  if (latestSignal === null) {
    console.info(
      `[SentimentShock] No signal yet for ${tradingPair} (cold start) — skipping shock ratification`,
    );
    return;
  }

  // Skip neutral warm-up signals (hold with no rules fired)
  if (latestSignal.type === "hold" && latestSignal.rulesFired.length === 0) {
    console.info(
      `[SentimentShock] Latest signal for ${tradingPair} is neutral warm-up hold — skipping shock ratification`,
    );
    return;
  }

  // Step 6: Find the most-recent bar_close ratification's recordId for the
  // trace link. `RatificationRecord.recordId` is now part of the type; no cast.
  let previousRatificationId: string | undefined;
  try {
    const recentRatifications = await getRecentRatifications(tradingPair, 10);
    const lastBarClose = recentRatifications.find(
      (r) => (r.triggerReason ?? "bar_close") === "bar_close",
    );
    previousRatificationId = lastBarClose?.recordId;
  } catch (err) {
    // Non-fatal: if we can't look up the prior ratification, proceed without linking
    console.warn(
      `[SentimentShock] Could not fetch prior ratification for ${tradingPair}: ${(err as Error).message}`,
    );
  }

  // Step 7: Build a sentiment bundle. Reuse the caller's pre-built bundle when
  // available — it already contains the freshly-computed aggregates we'd
  // otherwise re-read from DDB.
  let sentimentBundle: SentimentBundle;
  if (precomputedBundle) {
    sentimentBundle = precomputedBundle;
  } else {
    try {
      sentimentBundle = await buildSentimentBundle(rawSymbol);
    } catch (err) {
      console.error(
        `[SentimentShock] Failed to build sentiment bundle for ${rawSymbol}: ${(err as Error).message}`,
      );
      return;
    }
  }

  console.log(
    `[SentimentShock] Firing out-of-cycle ratification for ${tradingPair} (previousRatificationId=${previousRatificationId ?? "none"})`,
  );

  // Step 8: Fire ratification. `triggerReason: "sentiment_shock"` flows through
  // `RatifyContext` so the single `RatificationRecord` written by `ratifySignal`
  // is correctly tagged. No second write — duplicate audit rows have been a
  // recurring footgun on this path.
  try {
    const ratifyResult = await ratifySignal(
      {
        pair: tradingPair,
        candidate: latestSignal,
        perTimeframe: latestSignal.perTimeframe,
        sentiment: sentimentBundle,
        whaleSummary: null,
        pricePoints: [],
        fearGreed: {
          value: sentimentBundle.fearGreed.value ?? 50,
          trend24h: sentimentBundle.fearGreed.trend24h ?? 0,
        },
        triggerReason: "sentiment_shock",
        previousRatificationId,
      },
      // No onStage2 callback — the shock ratification creates its own audit
      // record via ratifySignal; it does not update the original signals_v2
      // row (that would require knowing the exact SK of the latest signal).
      undefined,
    );

    if (ratifyResult.kickoffRatification) {
      // Drive the LLM stream to completion. ratifySignal handles the
      // RatificationRecord persistence inside the stream's success/failure
      // branches; this awaits the verdict so the audit row reflects the
      // actual LLM response, not the stage-1 placeholder.
      await ratifyResult.kickoffRatification();
    }

    console.log(
      `[SentimentShock] Shock ratification complete for ${tradingPair}: type=${ratifyResult.signal.type} cacheHit=${ratifyResult.cacheHit}`,
    );
  } catch (err) {
    console.error(
      `[SentimentShock] Shock ratification failed for ${tradingPair}: ${(err as Error).message}`,
    );
    // Non-fatal — the regular bar-close path is unaffected
  }
}
