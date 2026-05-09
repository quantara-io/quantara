# Realtime latency reduction plan

End-to-end latency from candle close at exchange to a buy/sell/hold message arriving on a connected client. Sequenced by impact-vs-effort. Each phase is independently shippable.

For the full signal architecture, see `docs/SIGNALS_AND_RISK.md`. This doc is a cross-cutting plan focused only on latency.

## Latency baseline (today, before any of this work)

| Hop                              | Time         | Notes                                                                                     |
| -------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| Exchange WS → DDB candles        | 50–200ms     | Exchange-side network + Fargate processing + DDB write                                    |
| EventBridge cron tick            | **0–60s**    | **Indicator handler runs every minute; up to 60s wait after a close**                     |
| Compute + signal write           | 500ms–1s     | Indicator math, blend, DDB Put                                                            |
| LLM ratification (when fired)    | 1–3s         | Sonnet 4.6 API call; gates fired or borderline confidence only                            |
| Client polling                   | **0–30s**    | **Web/admin client polls `/api/genie/signals` on its own schedule**                       |
| **End-to-end (non-ratified)**    | **~30–90s**  |                                                                                           |
| **End-to-end (ratified)**        | **~30–95s**  |                                                                                           |

The two big chunks are the 0–60s scheduler lag (cron-driven indicator) and the 0–30s polling lag (client-driven refresh). Everything else is sub-second.

---

## Phase A — Eliminate scheduler + polling lag

**Target latency after Phase A: 3–5s non-ratified, 5–9s ratified.** This matches the v6 SLO in `SIGNALS_AND_RISK.md` §1.

| Issue | Work | Cuts | Status |
| --- | --- | --- | --- |
| **#116** | WebSocket push channel — API Gateway WebSocket + `$connect`/`$disconnect` Lambdas + connection-registry table + signals-fanout Lambda subscribed to `signals` table DDB Streams | ~30s polling lag → ≤1s | dispatched |
| **#117** | Event-driven indicator handler — replace EventBridge `cron(* * * * ? *)` with DDB Streams on `candles` table + close-quorum table + deterministic signals-v2 PK/SK + Candle.source field | 0–60s scheduler lag → ~5s | spec'd, not dispatched |

Both are independent (no file overlap; #116 is backend/infra/web-facing Lambdas; #117 is ingestion + candle-table infra). Can dispatch in parallel.

**Why this lands first:** the v6 design assumes both. Without them, the doc and the code diverge — doc says event-driven WebSocket, code stays cron + polling. This is the foundation; everything later assumes it.

**Acceptance:** end-to-end demo shows a candle close on Binance US producing a WebSocket push to a connected client within 5–8 seconds. (Use the admin Genie demo at #129 to validate visually.)

---

## Phase B — Stream the LLM ratification

**Target latency after Phase B: 3–5s perceived for both paths.** Ratification still happens; the user sees the algo signal before the LLM verdict applies.

### B1 — Stream ratification verdict as a follow-up signal update

**Issue:** to be filed after Phase A lands.

**Today (after Phase A):**
- Algo signal computed in ~1s after quorum
- Ratification waits to complete (1–3s API call) before writing to `signals` table
- WebSocket push fires after ratification finishes
- User sees the signal at ~5–9s post-close

**Phase B1 design:**
- Algo signal writes to `signals` table immediately (with `ratificationStatus: "pending"`)
- WebSocket push fires at ~3s post-close — user sees the algo verdict + reasoning
- Ratification runs async via Anthropic streaming API
- When ratification verdict differs from algo signal (downgrade applies), a second `signals` row update fires; signals-fanout pushes the update to the same client
- Client UI handles two-stage signal display: initial algo signal arrives, then a "verified" or "downgraded" badge applies when the ratification follow-up lands

**Trade-off:** in the rare case ratification downgrades, users briefly see a signal that gets corrected. Mitigation: hold the algo signal at a "tentative" UI state for ratification-eligible signals (gates fired or borderline) until the verdict streams.

**Effort:** 1–2 weeks
- Backend: extend ratification path to use Anthropic streaming API
- Backend: emit second `signals` row update on downgrade
- WebSocket: signals-fanout pushes UPDATE events (#116 v1 only pushes INSERT — extend to UPDATE)
- Client (admin demo + later web): two-stage rendering (tentative → verified/downgraded)

**Cost:** $0 incremental — same LLM call rate, just streamed.

---

## Phase A.5 — Genie admin demo (#129)

After Phase A merges, the admin Genie demo (#129) gets dispatched. It validates the end-to-end flow visually and gives a concrete UI surface to test Phase B1 against.

**Order:** A → A.5 (admin demo) → B1.

The admin demo can ship while B1 is in progress; B1 just adds a second push event the demo handles.

---

## Phase C — Tail-latency fixes

**Target latency after Phase C: 2–3s end-to-end.** Diminishing returns; only file these once Phase A + B are in steady state and you have real p99 metrics showing where the actual tail lives.

### C1 — Lambda provisioned concurrency (warm pools)

**Cuts:** 300ms–2s in cold-start cases (p99 only)

**Effort:** 1 day — Terraform configuration on `IndicatorLambda`, `signals-fanout`, `ws-connect`, `ws-disconnect`

**Cost:** ~$30–100/month per Lambda function depending on configured concurrency

**When to file:** after a week of metrics from Phase A shows cold-start latency in the p99 trace

### C2 — Skip DDB Streams hop #2 (signal-write → fanout)

**Cuts:** 200–500ms on every push

**Today (after Phase A):**
- Final signal writes to `signals` table
- DDB Streams emits event → signals-fanout Lambda → postToConnection per connection

**C2 design:**
- The Lambda that writes the final ratified signal directly calls `postToConnection` for each subscribed client; no separate signals-fanout Lambda

**Trade-off:**
- Tighter coupling: signal-writing Lambda now owns fanout responsibility
- Harder to test: can't test fanout in isolation
- Larger error blast radius: a fanout error in the writer affects signal persistence ordering

**Effort:** 3–5 days

### C3 — Skip DDB Streams hop #1 (Fargate → IndicatorLambda)

**Cuts:** 200–500ms

**Today (after Phase A):**
- MarketStreamManager (Fargate) writes candle to DDB
- DDB Streams emits event → IndicatorLambda invocation

**C3 design:**
- MarketStreamManager directly invokes IndicatorLambda synchronously (or via SQS) after writing the candle; bypasses DDB Streams ingest

**Trade-off:**
- Loses stream-retry idempotency property — if the invocation fails, no automatic retry from the streams subsystem
- Tighter coupling between Fargate ingestion and Lambda computation
- Harder to debug a missed signal: was the candle written? Was the invocation made?

**Effort:** 3–5 days

**Recommendation:** probably not worth it. The 200–500ms savings doesn't justify the loss of stream-retry semantics, which is what makes the v6 quorum design work.

---

## Phase D — Faster ratification model

### D1 — Haiku 4.5 first-pass, Sonnet only on edge cases

**Cuts:** 500ms–1.5s on ratified path

**Effort:** 1 week — model-selection logic, accuracy validation suite to confirm Haiku catches what Sonnet would catch on the gates-fired and borderline cases

**Cost:** reduces ratification spend from $20–150/month to $5–50/month (Haiku 4.5 is ~10× cheaper than Sonnet 4.6)

**Risk:** Haiku may miss subtle context that Sonnet catches. Validation suite needs:
- Backtest against ~100 historical ratification calls
- Compare Haiku verdict vs Sonnet verdict
- Define "Sonnet-must-handle" edge cases by feature pattern (e.g., specific rule combinations, news context, multi-pair correlation)

**When to file:** after Phase B1 is in production for ~2 weeks and we have a representative sample of ratification calls to validate against.

---

## Phase E — Continuous tick-level streaming

**Separate product decision, not a latency optimization.** This rewrites the indicator math from candle-close-aggregated to per-tick rolling-window. The signal model fundamentally changes: continuous-probability signals instead of discrete buy/sell/hold on TF closes.

**Cuts:** ~5s post-close → ~100ms per-tick

**Effort:** months
- Rewrite Phase 1 indicators to rolling-window math (EMA, MACD, RSI all need different update logic)
- Rewrite Phase 2 scoring to emit continuous probabilities
- Rewrite Phase 3 blending — multi-horizon blending of continuous probabilities is a different math problem
- New UX: continuous probability display vs the current discrete card-based UI
- Higher LLM ratification volume — gates fire more often on tick data
- Higher infra cost — more Fargate, more Lambda invocations

**Cost:** significant — per-tick processing is roughly 60× the current per-close volume. LLM costs scale with gate-fire rate, which goes up.

**When to consider:** only if product strategy explicitly wants tick-level signals (different product positioning — closer to algo trading platforms like QuantConnect than retail advisory). Not justified by latency gains alone — Phase A + B + C already gets to ~2-3s end-to-end, which is fine for the advisory product.

---

## Sequence summary

```
Phase A — Foundation (in flight)
  ├─ #116 WebSocket push channel (dispatched)
  └─ #117 Event-driven indicator trigger (spec'd; dispatch when ready)
       │
       ▼
Phase A.5 — Demo
  └─ #129 Admin Genie page (dispatched after A merges)
       │
       ▼
Phase B — Streaming ratification
  └─ B1: stream LLM verdict as follow-up signal update
       │
       ▼  (measure for ~2 weeks; let p99 metrics inform priority)
       │
Phase C — Tail-latency fixes (selective; file as metrics warrant)
  ├─ C1: Lambda provisioned concurrency
  ├─ C2: skip DDB Streams hop #2 (fold fanout into writer)
  └─ C3: skip DDB Streams hop #1 (Fargate → Lambda invoke) — likely skip
       │
       ▼
Phase D — Faster ratification model (cost optimization)
  └─ D1: Haiku 4.5 first-pass with Sonnet edge-case escalation
       │
       ▼  (separate product decision; not latency-driven)
       │
Phase E — Tick-level streaming
  └─ Continuous-probability signal model
```

---

## Latency targets at each phase

| Phase | Non-ratified p99 | Ratified p99 | Notes                                             |
| ----- | ---------------- | ------------ | ------------------------------------------------- |
| Today | ~30–90s          | ~30–95s      | Cron-bound + polling-bound                        |
| A     | 5s               | 9s           | Matches v6 SLO                                    |
| B     | 5s               | 5s           | Ratification streams; perceived latency unified   |
| C     | 2–3s             | 2–3s         | Tail fixes; varies by which of C1/C2/C3 ship      |
| D     | 2–3s             | 2–3s         | Cost win, not latency win                         |
| E     | ~100ms           | ~100ms       | Different product; not committed                  |

---

## What this plan is NOT

- Not a commitment to ship every phase. C/D/E are options gated on metrics and product direction.
- Not a substitute for `docs/SIGNALS_AND_RISK.md`. That doc is the architecture; this is a cross-cutting roadmap.
- Not a deadline schedule. Sequence and dependency only.
