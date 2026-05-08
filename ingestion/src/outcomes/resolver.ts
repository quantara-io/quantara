/**
 * Outcome resolver — Phase 8 (§10.3).
 *
 * Pure function: computes whether a blended signal was correct / incorrect /
 * neutral / skipped (invalidated).  No mutation of input records.
 *
 * Rules (§10.3):
 *   - Invalidated signals (invalidatedAt !== null) → excluded, not resolved.
 *   - Gate-driven holds (gateReason !== null) → always neutral.
 *   - hold:  |priceMove| < threshold → correct
 *             |priceMove| > 2×threshold → incorrect
 *             otherwise → neutral
 *   - buy:   priceMove > threshold → correct
 *             priceMove < −threshold → incorrect
 *             otherwise → neutral
 *   - sell:  priceMove < −threshold → correct
 *             priceMove > threshold → incorrect
 *             otherwise → neutral
 */

export type SignalType = "buy" | "sell" | "hold";
export type OutcomeValue = "correct" | "incorrect" | "neutral";

/** Subset of the signals-v2 record needed by the resolver. */
export interface BlendedSignalRecord {
  signalId: string;
  pair: string;
  type: SignalType;
  confidence: number;
  createdAt: string;
  expiresAt: string;
  priceAtSignal: number;
  atrPctAtSignal: number;
  gateReason: string | null;
  rulesFired: string[];
  emittingTimeframe: string;
  invalidatedAt: string | null;
}

/** Persisted outcome record for the signal-outcomes table. */
export interface OutcomeRecord {
  /** Partition key (same as signal PK). */
  pair: string;
  /** Sort key. */
  signalId: string;
  type: SignalType;
  confidence: number;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string;
  priceAtSignal: number;
  priceAtResolution: number;
  priceMovePct: number;
  atrPctAtSignal: number;
  thresholdUsed: number;
  outcome: OutcomeValue;
  rulesFired: string[];
  gateReason: string | null;
  emittingTimeframe: string;
  /** true means this record was skipped due to invalidation (not in resolved count). */
  invalidatedExcluded: boolean;
  /** resolvedAt + 365 days (Unix seconds). */
  ttl: number;
}

const TTL_SECONDS = 86400 * 365;

/**
 * Compute the outcome for a single signal.
 *
 * Does NOT mutate the input signal — returns a new OutcomeRecord.
 *
 * @param signal              The signal record retrieved from signals-v2.
 * @param priceAtResolution   Canonical price at signal expiry.
 * @param atrPctAtSignal      ATR% at the time the signal was emitted.
 * @param nowIso              Current time (ISO8601); defaults to now.
 */
export function resolveOutcome(
  signal: BlendedSignalRecord,
  priceAtResolution: number,
  atrPctAtSignal: number,
  nowIso: string = new Date().toISOString(),
): OutcomeRecord {
  const resolvedAt = nowIso;
  const ttl = Math.floor(new Date(resolvedAt).getTime() / 1000) + TTL_SECONDS;

  // §10.3: invalidated signals are skipped, not resolved.
  if (signal.invalidatedAt !== null) {
    return {
      pair: signal.pair,
      signalId: signal.signalId,
      type: signal.type,
      confidence: signal.confidence,
      createdAt: signal.createdAt,
      expiresAt: signal.expiresAt,
      resolvedAt,
      priceAtSignal: signal.priceAtSignal,
      priceAtResolution,
      priceMovePct: 0,
      atrPctAtSignal,
      thresholdUsed: 0.5 * atrPctAtSignal,
      outcome: "neutral",
      rulesFired: signal.rulesFired,
      gateReason: signal.gateReason,
      emittingTimeframe: signal.emittingTimeframe,
      invalidatedExcluded: true,
      ttl,
    };
  }

  const priceMovePct = (priceAtResolution - signal.priceAtSignal) / signal.priceAtSignal;
  const threshold = 0.5 * atrPctAtSignal;

  let outcome: OutcomeValue;

  // §10.3: gate-driven holds always neutral.
  if (signal.gateReason !== null) {
    outcome = "neutral";
  } else if (signal.type === "hold") {
    if (Math.abs(priceMovePct) < threshold) {
      outcome = "correct";
    } else if (Math.abs(priceMovePct) > 2 * threshold) {
      outcome = "incorrect";
    } else {
      outcome = "neutral";
    }
  } else if (signal.type === "buy") {
    if (priceMovePct > threshold) {
      outcome = "correct";
    } else if (priceMovePct < -threshold) {
      outcome = "incorrect";
    } else {
      outcome = "neutral";
    }
  } else {
    // sell
    if (priceMovePct < -threshold) {
      outcome = "correct";
    } else if (priceMovePct > threshold) {
      outcome = "incorrect";
    } else {
      outcome = "neutral";
    }
  }

  return {
    pair: signal.pair,
    signalId: signal.signalId,
    type: signal.type,
    confidence: signal.confidence,
    createdAt: signal.createdAt,
    expiresAt: signal.expiresAt,
    resolvedAt,
    priceAtSignal: signal.priceAtSignal,
    priceAtResolution,
    priceMovePct,
    atrPctAtSignal,
    thresholdUsed: threshold,
    outcome,
    rulesFired: signal.rulesFired,
    gateReason: signal.gateReason,
    emittingTimeframe: signal.emittingTimeframe,
    invalidatedExcluded: false,
    ttl,
  };
}
