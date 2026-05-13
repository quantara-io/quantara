/**
 * Pure dedupe helpers for ActivityFeed.
 *
 * Extracted into a standalone module so the dedupe identity and the bounded
 * LRU "seen" set can be unit-tested without spinning up a DOM/WebSocket.
 *
 * Identity scheme — chosen so the same logical event seen via REST backfill
 * (where `ts` is derived from a persisted field at fetch time) and via the
 * live WebSocket (where `ts = new Date().toISOString()` is stamped at fanout
 * time) collapses to a single entry. We key on stable, source-of-truth
 * fields per event type:
 *
 *   signal-emitted          → signal:<pair>:<timeframe>:<closeTime>
 *   ratification-fired      → ratify:<pair>:<timeframe>:<invokedAt(=ts)>
 *   indicator-state-updated → indicator:<pair>:<timeframe>:<asOf(=ts)>
 *   news-enriched           → news:<newsId>
 *   quorum-failed           → quorum:<pair>:<timeframe>:<closeTime>
 *   sentiment-shock-detected → shock:<pair>:<ts>   // no closeTime in payload
 *
 * Notes:
 *  - For ratification-fired and indicator-state-updated the WS producer and
 *    the backfill agree on `ts` (invokedAt / asOf are persisted on the row),
 *    so `ts` is part of the key and the collapse still happens.
 *  - For signal-emitted and quorum-failed the WS producer's `ts` differs from
 *    the persisted emittedAt, so we use `closeTime` instead — that field is
 *    deterministic from the bar boundary and identical on both sides.
 *  - Including `timeframe` in pair-based keys prevents 1h vs 4h collisions.
 */

import type { PipelineEvent } from "@quantara/shared";

/**
 * Stable, per-event-type dedupe identity. See module doc for rationale.
 */
export function eventKey(ev: PipelineEvent): string {
  switch (ev.type) {
    case "signal-emitted":
      return `signal:${ev.pair}:${ev.timeframe}:${ev.closeTime}`;
    case "ratification-fired":
      return `ratify:${ev.pair}:${ev.timeframe}:${ev.ts}`;
    case "indicator-state-updated":
      return `indicator:${ev.pair}:${ev.timeframe}:${ev.ts}`;
    case "news-enriched":
      return `news:${ev.newsId}`;
    case "quorum-failed":
      return `quorum:${ev.pair}:${ev.timeframe}:${ev.closeTime}`;
    case "sentiment-shock-detected":
      return `shock:${ev.pair}:${ev.ts}`;
    // Backtest lifecycle — Phase 4 finding 3. Stable key = type + runId + ts;
    // progress events use the progress fraction so 25%/50%/75%/100% don't
    // collide on the same runId.
    case "backtest-queued":
    case "backtest-started":
    case "backtest-completed":
    case "backtest-failed":
      return `${ev.type}:${ev.runId}`;
    case "backtest-progress":
      return `backtest-progress:${ev.runId}:${ev.progress.toFixed(2)}`;
  }
}

/**
 * Bounded LRU-ish set used by ActivityFeed to track event keys it has
 * already accepted. Caps at `maxSize` entries; oldest insertion wins
 * eviction. Re-adding an existing key promotes it to most-recent.
 *
 * Uses a Map under the hood because Map iteration order = insertion order,
 * giving us O(1) eviction of the oldest entry.
 */
export class BoundedKeySet {
  private map = new Map<string, true>();

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) throw new Error("BoundedKeySet maxSize must be > 0");
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /**
   * Add `key`. Returns true if the key was newly added, false if it was
   * already present (in which case it is promoted to most-recent).
   */
  add(key: string): boolean {
    const wasPresent = this.map.has(key);
    if (wasPresent) {
      // Promote to most-recent.
      this.map.delete(key);
      this.map.set(key, true);
      return false;
    }
    this.map.set(key, true);
    if (this.map.size > this.maxSize) {
      // Map iteration order is insertion order, so the first key is the oldest.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.map.size;
  }
}
