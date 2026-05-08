import type { IndicatorState, GateResult } from "@quantara/shared";
import type { TradingPair } from "@quantara/shared";
import { PAIRS, VOL_GATE_THRESHOLDS } from "@quantara/shared";

// GateResult and GateReason are declared in @quantara/shared (packages/shared/src/types/rules.ts).
// Re-exported here so callers that import directly from gates.ts get the same types.
export type { GateResult } from "@quantara/shared";
export type { GateReason } from "@quantara/shared";

const NOT_FIRED: GateResult = { fired: false, reason: null };

/**
 * Fail-closed pair narrowing. Throws if the input string is not a valid TradingPair.
 * Use this at trust boundaries (e.g. when reading IndicatorState from DDB) before
 * passing pair to gate functions.
 */
export function narrowPair(input: string): TradingPair {
  if ((PAIRS as readonly string[]).includes(input)) {
    return input as TradingPair;
  }
  throw new Error(`Unknown trading pair: "${input}". Valid pairs are: ${PAIRS.join(", ")}`);
}

/**
 * Volatility gate. Fires if realized annualized vol exceeds the per-pair threshold.
 *
 * Type-safe pair lookup: takes pair: TradingPair (not string). Caller must
 * narrow IndicatorState.pair to TradingPair before calling — see narrowPair() helper.
 *
 * Returns { fired: false } when realizedVolAnnualized is null, NaN, Infinity, or negative
 * (warm-up or bad data — do not gate). The non-firing path also covers cases where threshold
 * lookup returns undefined; the caller's narrowPair() must already have rejected unknown pairs.
 */
export function gateVolatility(state: IndicatorState, pair: TradingPair): GateResult {
  const vol = state.realizedVolAnnualized;

  // Reject null, NaN, Infinity, and negative values — do not gate on bad data
  if (vol === null || !Number.isFinite(vol) || vol < 0) {
    return NOT_FIRED;
  }

  const threshold = VOL_GATE_THRESHOLDS[pair];
  if (threshold === undefined) {
    return NOT_FIRED;
  }

  if (vol > threshold) {
    return { fired: true, reason: "vol" };
  }

  return NOT_FIRED;
}

/**
 * Cross-exchange dispersion gate. Fires when ALL of the most recent 3 dispersion values
 * exceed 0.01 (1%) — sustained breach, not a single-bar spike.
 *
 * dispersionHistory MUST be ordered most-recent-first (length >= 3 to fire; if shorter,
 * gate does not fire). Asserts at runtime that it has at least 3 entries before evaluation.
 *
 * Returns { fired: false } when state.dispersion is null, NaN, Infinity, or negative.
 */
export function gateDispersion(state: IndicatorState, dispersionHistory: number[]): GateResult {
  const disp = state.dispersion;

  // Reject null, NaN, Infinity, and negative values — do not gate on bad data
  if (disp === null || !Number.isFinite(disp) || disp < 0) {
    return NOT_FIRED;
  }

  // Need at least 3 history entries for sustained-breach logic
  if (dispersionHistory.length < 3) {
    return NOT_FIRED;
  }

  const DISPERSION_THRESHOLD = 0.01;

  // Fire only if ALL of the 3 most recent values exceed the threshold (most-recent-first ordering)
  const recentThree = dispersionHistory.slice(0, 3);
  if (recentThree.every((v) => v > DISPERSION_THRESHOLD)) {
    return { fired: true, reason: "dispersion" };
  }

  return NOT_FIRED;
}

/**
 * Stale-data gate. Fires if >=2 of EXACTLY 3 exchanges have stale=true.
 * Throws if the input map does not have exactly 3 entries — keeps the
 * ">= 2 of 3" semantic explicit.
 */
export function gateStale(exchangeStaleness: Record<string, boolean>): GateResult {
  const keys = Object.keys(exchangeStaleness);
  if (keys.length !== 3) {
    throw new Error(
      `gateStale requires exactly 3 exchanges, got ${keys.length}. The ">= 2 of 3" threshold is only valid with exactly 3 inputs.`,
    );
  }

  const staleCount = keys.filter((k) => exchangeStaleness[k]).length;
  if (staleCount >= 2) {
    return { fired: true, reason: "stale" };
  }

  return NOT_FIRED;
}

/**
 * Combine the three gates. Returns the first reason that fires, in order: vol, dispersion, stale.
 * Returns { fired: false, reason: null } if none fire.
 */
export function evaluateGates(
  state: IndicatorState,
  pair: TradingPair,
  dispersionHistory: number[],
  exchangeStaleness: Record<string, boolean>,
): GateResult {
  const vol = gateVolatility(state, pair);
  if (vol.fired) return vol;

  const dispersion = gateDispersion(state, dispersionHistory);
  if (dispersion.fired) return dispersion;

  const stale = gateStale(exchangeStaleness);
  if (stale.fired) return stale;

  return NOT_FIRED;
}
