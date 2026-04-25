# Quantara Storage Redesign

Status: **Phase 0 done (dev stopped), Phase 1c done (coinbase fix deployed), Phase 1 pending**
Last updated: 2026-04-25

## Decisions locked

- **Memory tiers**: 1m candles for *today only* (kept in Fargate process), 1h for last 24h, 1d for the long term. 1m never persisted to DDB.
- **Signal compute lives in Fargate process**: indicator state (RSI, MAs, etc.) is in-memory, recomputed from CCXT REST backfill on restart. Signals fire from the tick loop directly.
- **HA pattern**: active/standby with DDB lease. **In prod**: 2 tasks, leader writes/fires. **In dev**: 1 task only — no standby — to keep cost down.
- **HA-ready properties baked in from day 1** (idempotent writes, deterministic signal IDs, stateless SSE) so the second task is a deploy flag, not a rewrite.
- **No Redis** unless something other than the chart needs cheap latest-price reads. Open Q1 still open; default is no.

## Background

DynamoDB cost is dominated by per-tick writes from the Fargate ingestion service.
Storage is negligible (TTL keeps tables bounded); the bill is almost entirely
`WriteRequestUnits` on the `prices` table.

### Measured cost (us-west-2, on-demand) — quantara-dev account

The ingestion service has only been running since **Apr 19, 2026**. The 30-day
average is misleading because most of that window had nothing running. Steady-state
since Apr 20:

| Component | Per day | Per month | Per year |
|---|---|---|---|
| **DynamoDB writes** (≈$1.06/day) | $1.06 | **~$32** | **~$385** |
| Fargate (0.25 vCPU, 512 MB) | $0.24 | ~$7.20 | ~$87 |
| VPC | $0.12 | ~$3.60 | ~$44 |
| All other services | <$0.001 | ~$0 | ~$0 |
| **Total dev** | **$1.42** | **~$43** | **~$515** |

Reverse-engineering the tick rate from actual cost:
$1.06/day ÷ $1.25/M = ~850K writes/day = **~9.8 writes/sec total** = **~0.66/sec/stream**
across 15 streams. Slower than typical crypto tick rates — partially explained by
the coinbase OHLCV bug (now fixed in Phase 1c) and intermittent kraken streams.

Prod account: $0 in last 30 days (nothing deployed yet).

### Measured table sizes (snapshot)

| Table | Items | Size | TTL | Storage cost |
|---|---|---|---|---|
| **prices** | 8.0 M | 991 MB | ✅ 24h (lagging) | ~$0.25/mo |
| candles | 38 K | 6.6 MB | ✅ tiered by timeframe | ~$0.002/mo |
| news-events | 550 | 0.18 MB | ✅ | negligible |
| Everything else | 0 | 0 | varies | $0 |
| **Total storage** | | **~1 GB** | | **~$0.25/mo (~$3/yr)** |

**Storage is not a meaningful cost.** TTL is doing its job; even 10× growth puts
total storage at ~$3.50/mo. Archiving to S3 for *cost reasons* makes no sense.
After Phase 1, the `prices` table goes away entirely.

### Re-pull the numbers

```bash
aws ce get-cost-and-usage \
  --profile quantara-dev \
  --time-period Start=$(date -u -v-30d +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

## Findings from code audit + DDB scan

What the code does:

- **Live OHLCV stream writes only `1m` candles** (`stream.ts:132` hardcodes
  `timeframe = "1m"`, `stream.ts:157-158` writes only on close).
- **Backfill Lambda writes whatever timeframe is requested**
  (`backfill-handler.ts:16` defaults to `1h`, 90 days).
- **`TTL_SECONDS` table** in `candle-store.ts:11-18` defines TTLs for `5m / 15m / 4h`
  too, but no caller currently writes those. Harmless dead config.

What's actually in DDB `candles` (full scan, 38,800 rows):

| Count | Timeframe | Exchange | % |
|---|---|---|---|
| 37,360 | 1m | binanceus | 96.3% |
| 1,416 | 1m | kraken | 3.6% |
| 24 | 1h | binanceus | 0.06% |
| 0 | (any) | coinbase | 0% (was unsupported by CCXT — fixed in Phase 1c) |

**Reality differed from intent until Phase 1c:**

1. **Coinbase had 0 candles.** `coinbase watchOHLCV() is not supported yet` — CCXT Pro
   library gap. Fixed: feature-detect and skip the loop. Coinbase now runs ticker only.
2. **Kraken contributes only 4%** — stream is intermittent. Not blocking; investigate later.
3. **The `1h` tier is aspirational** — only 24 rows from a one-shot manual backfill.
   Needs scheduled invocation if charts will read it.

## What "real-time chart" actually requires

A candle chart shows *closed* historical bars plus *one* forming bar that updates
tick-by-tick. Only the rightmost bar moves.

```
    ── Historical (closed, immutable) ───────────┬── Forming ──┐
                                                  │             │
    ░░ ▓▓ ░░ ▓▓ ░░ ▓▓ ░░ ▓▓ ░░ ▓▓ ░░ ▓▓ ░░       │     ▒▒↕    │
                                                  │             │
    ──────── one fetch at chart load ─────────────┴── live ─────┘
                                                  ↑
                                        SSE push channel
```

Higher timeframes derive from lower ones — no extra storage needed for the live
view. Today's 1d bar = `aggregate(today's 1m closed candles) + forming 1m`.

## Proposed architecture

### Memory layout in the Fargate process

For each `(exchange, pair)`:

```
   ┌─────────────────────────────────────────────────────────────┐
   │  Per-stream state (~30 KB each, ≪1 MB even at 200 streams)  │
   │  ─────────────────────────────────────────────────────────  │
   │   latestTick:        PriceSnapshot                           │
   │   formingCandle:     Candle  (1m bucket being built)         │
   │   ringBuffer1m:      last N closed 1m candles  (today's qty) │
   │   ringBuffer1h:      last 24 closed 1h candles               │
   │   indicators:        { rsi: ..., emaState: ..., ... }        │
   └─────────────────────────────────────────────────────────────┘
```

### Tick → close → rollup pipeline

```
   ┌──── Fargate (ingestion + signals + SSE) ─────────────────────┐
   │                                                              │
   │  Every tick (watchTicker / watchOHLCV):                      │
   │    1. update latestTick + formingCandle                      │
   │    2. update indicators incrementally                        │
   │    3. evaluate signal rules; if triggered:                   │
   │       deterministic signalId = hash(exch,pair,type,candleTs) │
   │       PutItem signals (ConditionExpression: not_exists)      │
   │    4. emit forming candle on SSE channel                     │
   │                                                              │
   │  On 1m close (every :00 of each minute):                     │
   │    1. push closed candle to ringBuffer1m                     │
   │    2. NO DDB write                                           │
   │    3. emit closed candle on SSE channel                      │
   │                                                              │
   │  On 1h close (every :00 of each hour):                       │
   │    1. aggregate last 60 × 1m → 1h candle                     │
   │    2. push to ringBuffer1h                                   │
   │    3. PutItem candles (timeframe=1h, idempotent)             │
   │                                                              │
   │  On 1d close (UTC midnight):                                 │
   │    1. aggregate today's 24 × 1h → 1d candle                  │
   │    2. PutItem candles (timeframe=1d, idempotent)             │
   │                                                              │
   │  HTTP routes (behind ALB):                                   │
   │    GET /price/:exch/:pair                                    │
   │    GET /stream/:exch/:pair       (SSE — forming + 1m closed) │
   │    GET /candles/:exch/:pair?tf=  (memory or DDB by range)    │
   └──────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    ┌────────────────┐
                    │ DDB candles    │   1h closed (TTL ~30-90d)
                    │                │   1d closed (TTL ~365d)
                    │ DDB signals    │   only when triggered
                    └────────────────┘
                            │
                            ▼
                    Backend Lambda (chart history > memory window)
```

### Timeframe sourcing rule

| Timeframe | Source | Notes |
|---|---|---|
| 1m forming | SSE from Fargate | from in-memory |
| 1m closed (today) | SSE + Fargate ringBuffer1m | served via HTTP/SSE, never persisted |
| 1m beyond today | **not available** — chart falls back to 1h | by design |
| 5m, 15m | aggregate from ringBuffer1m on read | within today's window |
| 1h closed, ≤24h | Fargate ringBuffer1h | in-memory |
| 1h closed, >24h | DDB candles | persisted on each 1h close |
| 4h | aggregate from 1h | trivial rollup |
| 1d (today) | aggregate today's 1m + forming | natural |
| 1d (historical) | DDB candles (1d row) | written at UTC midnight |

### Restart recovery (the main risk)

Fargate restarts on deploys, crashes, scale events. When the task starts:

```
   on Fargate start, for each (exchange, pair):
     1. CCXT REST fetchOHLCV(symbol, '1m', sinceStartOfDay)
        → up to ~1440 bars in 1-2 calls
     2. replay through indicator logic to rebuild signal state
     3. push into ringBuffer1m
     4. fetch last 24 × 1h same way → ringBuffer1h
     5. begin watchTicker / watchOHLCV live streams
```

CCXT REST `fetchOHLCV` returns up to ~1000 bars per call. Backfilling 200 streams
takes ~30s-2min depending on per-exchange rate limits. Acceptable cold-start cost.

**Without this**: signals mis-fire for the first hour after every restart (cold
indicator state). Required for correctness, not just nice-to-have.

### HA-ready single task → active/standby flip

Single-task today, but the design carries these properties so flipping on a second
task is a deploy, not a rewrite:

**1. Idempotent DDB writes.** Every persisted item keyed by natural ID:

```ts
// 1h candle
PutItem({
  Key: { pair, sk: `${exchange}#1h#${openTime}` },
  ConditionExpression: "attribute_not_exists(sk)",
})
// Two tasks both writing → first wins, second's ConditionalCheckFailed is swallowed
```

**2. Deterministic signal IDs.**

```ts
signalId = sha256(`${exchange}|${pair}|${signalType}|${triggerCandleOpenTime}`)
```

Same input on either task → same ID → same conditional write semantics. No dup signals.

**3. Stateless SSE clients.** No server-side session state. On disconnect,
reconnect to any task and resync from current ring buffer. ALB load-balances.

**4. Backfill is task-agnostic.** Either task warms up the same way from CCXT REST.

### Active/standby (when enabled — prod only)

```
   ┌── Fargate Task A ──┐         ┌── Fargate Task B ──┐
   │ subscribes WS       │         │ subscribes WS       │
   │ in-memory state     │         │ in-memory state     │
   │ holds DDB lease     │ ──leader──▶                   │
   │ writes 1h/1d        │         │ NO writes (standby) │
   │ fires signals       │         │ NO signals          │
   │ serves SSE (read)   │         │ serves SSE (read)   │
   └─────────────────────┘         └─────────────────────┘
                            ↓
                    DDB row: { pk: "leader", leaseExpiresAt }
                    Renewed every 10s, TTL 30s, conditional update
```

The lease is one DDB conditional update. ~30 lines of code. If A dies, B's lease
acquire succeeds within 30s and it starts writing.

**Caveats:**
- Both tasks subscribe to exchanges → 2× WebSocket connections per IP. Public
  market data is usually generous (Binance allows ~24/IP) — verify per venue.
- Compute cost doubles: 2× $7/mo Fargate = $14/mo. Trivial in prod, deliberately
  off in dev.

### Dev vs prod

| | Dev | Prod |
|---|---|---|
| Fargate ingestion | 1 task (or 0 when not testing) | 2 tasks (active/standby) |
| Lease enabled | No (single task is implicit leader) | Yes (DDB lease) |
| ALB | Yes (1 target) | Yes (2 targets) |
| Cost (run-rate) | ~$11/mo (1 task + ALB + VPC) | ~$45/mo (2 tasks + ALB + VPC) |

The single-task dev path uses the same code; the leader-election logic short-circuits
when `INGESTION_HA=false` (env var). One config flag toggles it.

## Storage tier decisions

| Data | Access pattern | Today | Proposed | Reason |
|---|---|---|---|---|
| Latest tick / bid-ask | High-write, last-write-wins | DDB `prices` | **In-process Map; SSE for clients** | DDB is wrong shape — only the latest matters. |
| Forming 1m candle | Live-updating | (not exposed) | **SSE from in-memory** | Already in memory; just expose it. |
| 1m closed (today) | Read for chart, signals | DDB `candles` | **In-memory ring buffer; never persisted** | Chart only shows today; signals consume from same buffer. |
| 1m closed (>today) | Range read | DDB `candles` (TTL 7d) | **Not available — chart uses 1h** | Don't store. |
| 1h closed | Range read, chart history | DDB `candles` (sparse) | **DDB on each 1h close (idempotent)** | Persisted from in-memory on rollup. |
| 1d closed | Long-range read, backtests | not stored | **DDB on each 1d close (idempotent)** | Persisted from in-memory on rollup. |
| 5m / 15m / 4h | Derived | not stored | **Aggregate from 1m or 1h on read** | No reason to store. |
| Signals | Triggered events | DDB `signals` (empty) | **DDB on trigger (deterministic ID, idempotent)** | Sparse writes; conditional. |
| News events | Append + dedup | DDB `news-events` | **DDB (unchanged)** | Storage is trivial; archive only if analytics need it. |
| Raw ticks (replay) | Write-only firehose | not stored | **(still don't store)** OR Firehose → S3 if R&D needs it | DDB is wrong store. |

## Implementation phases

### Phase 0 — stop dev Fargate when idle ✅ DONE 2026-04-24

1. Scaled `quantara-dev-ingestion` ECS service to `desired_count=0` via AWS CLI.
2. **Pending durability**: add `ingestion_desired_count` variable to the
   `quantara-backend` module (default `1`, set `0` in `backend/infra/dev/main.tf`)
   so the manual scale-down survives the next `terraform apply`.

### Phase 1c — fix coinbase candles ✅ DEPLOYED 2026-04-24

`stream.ts:52-55, 67-69` — feature-detect `exchange.has?.watchOHLCV` before
starting the OHLCV loop. Coinbase logs one warning at startup and runs ticker only.
Verified: 0 OHLCV errors after deploy.

### Phase 1 — in-memory tiered storage + SSE + signals (the main rewrite)

In rough dependency order:

**1.1** — in-memory ring buffers + rollup logic
- Add `MemoryStore` per `(exchange, pair)` with `latestTick`, `formingCandle`,
  `ringBuffer1m` (today-sized), `ringBuffer1h` (24-sized), `indicators`.
- Tick → update tick + forming + indicators.
- 1m close → push to ringBuffer1m, no DDB write.
- 1h close → aggregate, push to ringBuffer1h, write to DDB (idempotent).
- 1d close → aggregate, write to DDB (idempotent).

**1.2** — startup backfill
- On task start: `CCXT.fetchOHLCV(symbol, '1m', sinceStartOfDay)` per stream.
- Replay through indicator logic to rebuild state.
- Then start `watchTicker` / `watchOHLCV`.

**1.3** — signals as first-class
- Move/build signal evaluation into the per-tick path.
- Deterministic signalId; PutItem `signals` with `ConditionExpression: attribute_not_exists`.
- Emit triggered signals on a `/signals/stream/:pair` SSE channel.

**1.4** — HTTP / SSE server in Fargate (Hono)
- `GET /price/:exch/:pair` — JSON snapshot
- `GET /stream/:exch/:pair` — SSE: forming candle + closed 1m + signals
- `GET /candles/:exch/:pair?tf=1m|5m|15m|1h|1d&from=&to=` — serve from memory or DDB by range

**1.5** — ALB + DNS in front of Fargate
- ALB target group → Fargate task on port 8080.
- Stable hostname (e.g., `ingestion.dev.quantara.aldero.io`) so the chart can connect.

**1.6** — drop the `prices` table
- Once nothing reads it, remove `aws_dynamodb_table.prices` and the writer code.

**1.7** — HA-ready properties (single task, but baked in)
- Idempotent writes: confirmed in 1.1 / 1.3.
- Stateless SSE: confirmed in 1.4.
- Lease logic disabled in dev via env (`INGESTION_HA=false`); active in prod via task count = 2.

### Phase 1b — flip on prod active/standby (later)

When prod ships and reliability matters:

1. Add DDB row `(pk: "leader", leaseExpiresAt, taskId)`. Conditional update every 10s.
2. Wrap the writer/signals path: only run if `isLeader()` returns true.
3. Bump prod ECS `desired_count` from 1 → 2.
4. Verify failover: kill leader task, watch standby take over within ~30s.

### Phase 2 — S3 archiving (only if a use case demands it)

**Not justified by cost.** Build only when:

- Backtests need candles older than the DDB TTL window.
- Compliance/audit retention beyond TTL.
- Analytical queries (Athena/Glue) over years of data.
- Raw tick replay for strategy R&D — Firehose → S3 Parquet, not DDB.

Pattern when triggered: DynamoDB Streams → Firehose → S3 Parquet, partitioned by date.

## Cost delta (current run-rate, dev only)

| | Before | Phase 0 (idle) | Phase 1 dev (single task) | Phase 1 prod (active/standby) |
|---|---|---|---|---|
| DDB `prices` writes | ~$32/mo | $0 | $0 | $0 |
| DDB `candles` writes (1h+1d only) | ~$0.50/mo | $0 | <$0.05/mo | <$0.05/mo |
| DDB `signals` writes | $0 | $0 | <$0.10/mo | <$0.10/mo |
| ALB | $0 | $0 | ~$16/mo | ~$16/mo |
| Fargate | ~$7/mo | $0 | ~$7/mo | ~$14/mo (2 tasks) |
| VPC | ~$3.60/mo | $0 | ~$3.60/mo | ~$3.60/mo |
| **Total** | **~$43/mo** | **~$0/mo** | **~$27/mo** | **~$34/mo** |

Phase 0 is the biggest single dev win (~$515/yr). Phase 1's dev savings vs the
current run-rate are smaller (~$190/yr) because ALB adds a fixed line item — but
Phase 1 is what protects against the **scaling cliff**:

### Prod scaling sensitivity

Current architecture (per-tick PutItem to `prices`) scales linearly with
streams × tick rate:

| Symbols × exchanges | Approx writes/sec | DDB `prices` cost/mo |
|---|---|---|
| 5 × 3 = 15 (today) | ~10/sec | ~$32 |
| 10 × 3 = 30 | ~20/sec | ~$65 |
| 30 × 5 = 150 | ~100/sec | ~$325 |
| 30 × 5, 5 ticks/sec/stream | ~750/sec | ~$2,400 |

After Phase 1, this column is replaced by zero — `prices` table goes away. Only
1h/1d candle and signal writes remain, which are bounded regardless of tick rate
or symbol count.

## Open questions

1. **Besides the chart, who else needs latest-price reads?** If only the chart
   (via SSE), no Redis needed. If a backend Lambda or worker exists outside
   Fargate, add Redis or have it call the Fargate `/price/:exch/:pair` endpoint.
2. **What is "today" exactly for the 1m memory window?** Two options:
   (a) UTC calendar day (resets at 00:00 UTC), (b) trailing 24h. Picking one
   determines the ringBuffer1m sizing rule and the chart fallback boundary.
3. **Do any backtests need raw 1m beyond today?** If yes, an extra tier is needed
   (e.g., write 1m to S3 Parquet on close, separate from DDB). Phase 1 design
   makes this clean to add — just an extra writer in the 1m close handler.
4. **Should the `1h` backfill Lambda run on schedule?** Today only 24 rows exist.
   If charts read >24h of 1h history (i.e., the boundary where memory ends and
   DDB begins), the in-memory rollup will populate it going forward, but the
   first day of the new system has no historical 1h data unless backfilled once.
5. **Why are streams still firing at ~0.7 ticks/sec/stream?** Coinbase OHLCV is
   fixed; kraken intermittent. Worth checking once Phase 1 lands (the redesign
   doesn't depend on this).
