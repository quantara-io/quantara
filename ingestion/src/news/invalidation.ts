/**
 * Phase 6b — Breaking-news invalidation.
 *
 * When a high-magnitude news article lands for a tracked pair, this module
 * marks all active signals for that pair as invalidated so the UI can surface
 * a "Breaking news — refreshing" banner.  Re-ratification happens on the next
 * regular TF close (per §6.7 — the "policy 2" deferred path).
 *
 * Design: §6.7 of docs/SIGNALS_AND_RISK.md
 */

import { findActiveSignalsForPair, markSignalInvalidated } from "../lib/signal-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of a Phase-5a-enriched news event required by this module.
 * Callers (enrichment handler) already have all these fields on the enriched record.
 */
export interface EnrichedNewsEvent {
  /** Unique article identifier. */
  newsId: string;
  /** Article title — used to build the user-facing invalidation reason string. */
  title: string;
  /** ISO-8601 publish time. */
  publishedAt: string;
  /** From Phase 5a pair-tagger. */
  mentionedPairs: string[];
  /** From Phase 5a sentiment classifier. */
  sentiment: {
    score: number;
    /** 0–1; high value means strongly directional. */
    magnitude: number;
    model: string;
  };
  /**
   * From Phase 5a embedding dedup.
   * null = original article; non-null = this is a duplicate of another article.
   */
  duplicateOf: string | null;
}

// ---------------------------------------------------------------------------
// Trigger constants (§6.7)
// ---------------------------------------------------------------------------

/** Sentiment magnitude threshold above which a news event is considered "high-magnitude". */
export const MAGNITUDE_THRESHOLD = 0.7;

/** Articles older than this are ignored (in milliseconds). */
export const FRESHNESS_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Trigger condition check
// ---------------------------------------------------------------------------

/**
 * Returns true when the event satisfies ALL four trigger conditions from §6.7:
 *   1. sentiment.magnitude > MAGNITUDE_THRESHOLD
 *   2. mentionedPairs.length > 0
 *   3. duplicateOf === null (not a duplicate)
 *   4. article is fresh (publishedAt within FRESHNESS_WINDOW_MS of nowMs)
 */
export function shouldTriggerInvalidation(
  event: EnrichedNewsEvent,
  nowMs = Date.now(),
): boolean {
  if (event.sentiment.magnitude <= MAGNITUDE_THRESHOLD) return false;
  if (event.mentionedPairs.length === 0) return false;
  if (event.duplicateOf !== null) return false;

  const publishedMs = Date.parse(event.publishedAt);
  if (isNaN(publishedMs)) return false;
  if (nowMs - publishedMs > FRESHNESS_WINDOW_MS) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface InvalidationResult {
  triggered: boolean;
  /** Pairs that had at least one active signal invalidated. */
  pairsInvalidated: string[];
  /** Total count of signal records stamped as invalidated. */
  signalsInvalidated: number;
}

/**
 * Process one enriched news event for potential signal invalidation.
 *
 * If the trigger conditions are not met the function returns immediately with
 * `triggered: false` and no DynamoDB writes.
 *
 * When triggered, for each pair mentioned in the article:
 *   1. Find all active (TTL not expired, not already invalidated) signals.
 *   2. Stamp each with `invalidatedAt = now` and a user-facing `invalidationReason`.
 *
 * @param event  Enriched news event (post Phase 5a).
 * @param nowMs  Current time in unix milliseconds — injectable for tests.
 */
export async function processNewsEventForInvalidation(
  event: EnrichedNewsEvent,
  nowMs = Date.now(),
): Promise<InvalidationResult> {
  if (!shouldTriggerInvalidation(event, nowMs)) {
    return { triggered: false, pairsInvalidated: [], signalsInvalidated: 0 };
  }

  const nowIso = new Date(nowMs).toISOString();
  // User-facing banner copy — kept to ≤70 chars for mobile readability.
  const reason = `Breaking news: ${event.title}`.slice(0, 120);

  const pairsInvalidated: string[] = [];
  let signalsInvalidated = 0;

  for (const pair of event.mentionedPairs) {
    const activeSignals = await findActiveSignalsForPair(pair);
    if (activeSignals.length === 0) continue;

    for (const sig of activeSignals) {
      await markSignalInvalidated(sig.pair, sig.emittedAtSignalId, reason, nowIso);
      signalsInvalidated++;
    }

    pairsInvalidated.push(pair);
    console.log(
      `[Invalidation] Invalidated ${activeSignals.length} signal(s) for ${pair} — "${reason.slice(0, 60)}..."`,
    );
  }

  return { triggered: true, pairsInvalidated, signalsInvalidated };
}
