import { describe, it, expect } from "vitest";
import type { PipelineEvent } from "@quantara/shared";

import { eventKey, BoundedKeySet } from "./activityFeedDedupe";

// Backfill stamps `ts` from a persisted field at fetch time; the live WS
// producer stamps `ts = new Date()` at fanout time. The dedupe key MUST
// collapse those two flavors of the same logical event onto one entry.

describe("eventKey", () => {
  it("collapses backfill+WS for the same signal-emitted bar (different ts, same closeTime)", () => {
    const closeTime = "2026-05-10T12:00:00.000Z";
    const backfill: PipelineEvent = {
      type: "signal-emitted",
      pair: "BTC/USDT",
      timeframe: "1h",
      signalType: "buy",
      confidence: 0.7,
      closeTime,
      ts: "2026-05-10T12:00:01.123Z", // emittedAt from row
    };
    const live: PipelineEvent = {
      type: "signal-emitted",
      pair: "BTC/USDT",
      timeframe: "1h",
      signalType: "buy",
      confidence: 0.7,
      closeTime,
      ts: "2026-05-10T12:05:42.999Z", // new Date() at WS fanout
    };
    expect(eventKey(backfill)).toBe(eventKey(live));
  });

  it("does NOT collapse signal-emitted events that share (type, ts, pair) but differ in timeframe", () => {
    const ts = "2026-05-10T12:00:01.000Z";
    const oneH: PipelineEvent = {
      type: "signal-emitted",
      pair: "BTC/USDT",
      timeframe: "1h",
      signalType: "buy",
      confidence: 0.7,
      // Different bar boundaries → different closeTime — so even on the new
      // identity scheme they diverge. Use the SAME closeTime to make the
      // assertion focus narrowly on the timeframe-in-key requirement.
      closeTime: "2026-05-10T12:00:00.000Z",
      ts,
    };
    const fourH: PipelineEvent = {
      type: "signal-emitted",
      pair: "BTC/USDT",
      timeframe: "4h",
      signalType: "buy",
      confidence: 0.7,
      closeTime: "2026-05-10T12:00:00.000Z",
      ts,
    };
    expect(eventKey(oneH)).not.toBe(eventKey(fourH));
  });

  it("collapses ratification-fired by (pair, timeframe, ts=invokedAt)", () => {
    const ts = "2026-05-10T12:00:05.000Z";
    const a: PipelineEvent = {
      type: "ratification-fired",
      pair: "ETH/USDT",
      timeframe: "1h",
      triggerReason: "bar_close",
      verdict: "ratified",
      latencyMs: 120,
      costUsd: 0.001,
      cacheHit: false,
      ts,
    };
    const b: PipelineEvent = { ...a, latencyMs: 999 }; // payload jitter, same identity
    expect(eventKey(a)).toBe(eventKey(b));
  });

  it("collapses news-enriched by newsId only (ts may drift)", () => {
    const a: PipelineEvent = {
      type: "news-enriched",
      newsId: "n-123",
      mentionedPairs: ["BTC"],
      sentimentScore: 0.4,
      sentimentMagnitude: 0.6,
      ts: "2026-05-10T12:00:00.000Z",
    };
    const b: PipelineEvent = { ...a, ts: "2026-05-10T13:00:00.000Z" };
    expect(eventKey(a)).toBe(eventKey(b));
  });
});

describe("BoundedKeySet", () => {
  it("rejects re-adds and keeps unique keys only", () => {
    const s = new BoundedKeySet(10);
    expect(s.add("a")).toBe(true);
    expect(s.add("a")).toBe(false);
    expect(s.has("a")).toBe(true);
    expect(s.size).toBe(1);
  });

  it("evicts the oldest key once maxSize is exceeded", () => {
    const s = new BoundedKeySet(3);
    s.add("a");
    s.add("b");
    s.add("c");
    s.add("d"); // evicts "a"
    expect(s.has("a")).toBe(false);
    expect(s.has("b")).toBe(true);
    expect(s.has("c")).toBe(true);
    expect(s.has("d")).toBe(true);
    expect(s.size).toBe(3);
  });

  it("promotes re-added keys so they survive eviction", () => {
    const s = new BoundedKeySet(3);
    s.add("a");
    s.add("b");
    s.add("c");
    // Re-adding "a" promotes it to most-recent. Now "b" is the oldest.
    s.add("a");
    s.add("d"); // evicts "b"
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
    expect(s.has("c")).toBe(true);
    expect(s.has("d")).toBe(true);
  });
});

// End-to-end style: simulate the ActivityFeed dedupe path:
// backfill loads N events into the seen-set, then a WS message for the
// SAME logical event arrives — the WS path must reject it.
describe("ActivityFeed dedupe simulation", () => {
  it("WS event for the same (pair, timeframe, closeTime) as a backfill event is rejected", () => {
    const seen = new BoundedKeySet(500);
    const closeTime = "2026-05-10T12:00:00.000Z";
    const backfillEv: PipelineEvent = {
      type: "signal-emitted",
      pair: "BTC/USDT",
      timeframe: "1h",
      signalType: "buy",
      confidence: 0.7,
      closeTime,
      ts: "2026-05-10T12:00:01.000Z",
    };
    seen.add(eventKey(backfillEv));

    const liveEv: PipelineEvent = {
      ...backfillEv,
      ts: "2026-05-10T12:05:42.999Z", // WS fanout time, different from emittedAt
    };
    // The WS handler would call seen.has(key) — must be true → drop.
    expect(seen.has(eventKey(liveEv))).toBe(true);
  });

  it("two events with identical (type, ts, pair) but different timeframe are NOT deduped", () => {
    const seen = new BoundedKeySet(500);
    const ts = "2026-05-10T12:00:01.000Z";
    const a: PipelineEvent = {
      type: "signal-emitted",
      pair: "BTC/USDT",
      timeframe: "1h",
      signalType: "buy",
      confidence: 0.7,
      closeTime: "2026-05-10T12:00:00.000Z",
      ts,
    };
    const b: PipelineEvent = { ...a, timeframe: "4h" };
    expect(seen.add(eventKey(a))).toBe(true);
    expect(seen.add(eventKey(b))).toBe(true); // accepted, not a duplicate
    expect(seen.size).toBe(2);
  });
});
