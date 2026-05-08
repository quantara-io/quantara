# Admin Dashboard Plan: Signal & Decision Engine Visibility

**Status:** Draft. Captures the gap analysis between the current admin
dashboard and what an operator needs to review the signal engine, plus
a proposed set of additions and a recommended ship order.

**Audience:** Whoever picks up admin-side work next (likely after the
Phase 4–5 ingestion work lands). Pairs with `docs/SIGNALS_AND_RISK.md`,
which is the source of truth for engine semantics.

---

## 1. What the admin dashboard has today

Five pages under `admin/src/pages/`, all reading from DynamoDB via
`/api/admin/*` routes in `backend/src/routes/admin.ts`:

| Page      | What it shows                                                                                                 | Backend       |
| --------- | ------------------------------------------------------------------------------------------------------------- | ------------- |
| Overview  | Table counts, SQS depths, ECS service health, F&G index, last 20 ingestion log lines, Lambda function listing | `getStatus()` |
| Market    | Latest prices per pair (3 exchanges); recent 1m candles for a chosen pair × exchange                          | `getMarket()` |
| News      | Recent news events                                                                                            | `getNews()`   |
| Whitelist | Docs IP allowlist                                                                                             | SSM           |
| Login     | Auth (password, OAuth, MFA, passkey)                                                                          | —             |

This is an **infrastructure** dashboard — useful for "is anything on
fire" but it surfaces nothing the signal engine produces. There is no
visibility into indicators, rules, gates, per-timeframe votes, blended
signals, or signal history.

## 2. What the signal & decision engine produces

From the recent ingestion PRs (#24, #25, #58, #60, #68, #69, #70):

- **`IndicatorState`** — per-bar snapshot, persisted to the
  `indicator_state` DynamoDB table. ~25 fields per pair × timeframe
  (RSI14, MACD line/signal/hist, EMA20/50/200, ATR14, Bollinger
  upper/mid/lower/width, OBV + slope, VWAP, vol-Z, realized vol
  annualized, F&G, dispersion) plus a 5-bar history ring buffer for
  RSI, MACD hist, EMA20/50, close, volume.

- **`TimeframeVote`** — derived in-memory from `scoreTimeframe()` in
  `ingestion/src/signals/score.ts`. Shape:
  `{ type: "buy" | "sell" | "hold", confidence, rulesFired[], bullishScore, bearishScore, volatilityFlag, gateReason, asOf }`.
  Group-max rule selection plus a confluence threshold (`MIN_CONFLUENCE`).

- **`GateResult`** — from `ingestion/src/signals/gates.ts`. Three gates:
  vol (per-pair threshold on realized vol annualized), dispersion
  (3-bar sustained breach > 1%), stale (>=2 of 3 exchanges stale).
  Priority `vol > dispersion > stale`. When any fires, the per-TF vote
  is forced to `hold` with `volatilityFlag` and `gateReason` set.

- **`BlendedSignal`** — persisted to `signals-v2` (PK=`pair`,
  SK=`emittedAt#signalId`, 90-day TTL). Shape:
  `{ pair, type, confidence, perTimeframe (all 6 TFs), weightsUsed, rulesFired (union), gateReason, emittingTimeframe, asOf }`.
  Default weights `{1m:0, 5m:0, 15m:0.15, 1h:0.20, 4h:0.30, 1d:0.35}`
  with single-source damping ×0.7. Threshold T=0.25.

The persistence shape is excellent for review — every blended signal
carries the full per-TF breakdown and weights inline. Nothing is
reading any of it on the admin side yet.

## 3. Gaps an operator can't currently answer

When something looks wrong or surprising on the engine side, an admin
has no way to ask:

1. _Why did BTC/USDT emit a buy at 18:04?_ — which TF voted, which
   rules fired, what the bullish/bearish scores were.
2. _Why is everything stuck on hold?_ — is a gate firing, on which pair,
   since when.
3. _Are warm-ups complete?_ — `barsSinceStart >= requiresPrior` per TF
   per pair. After cold start this should converge in ~24h.
4. _Is the signal mix realistic?_ — buy/sell/hold ratios per pair over
   24h, or are we permanently 95% hold.
5. _Which rules actually fire?_ — there are 50+ rules in the `RULES`
   constant; most might never fire and we wouldn't know.
6. _Which exchanges are going stale?_ — gate inputs in real time.
7. _Is dispersion spiking or sustained?_ — the gate fires on 3-bar
   sustained, but admin can't see the curve.
8. _Are signal changes "trivial" (suppressed by `isTrivialChange`) or
   real?_ — ratio over time.

## 4. Proposed additions

Three new pages plus extensions to two existing ones. Ordered by
estimated value-per-LOC.

### 4.1 Signals page (highest value — new)

The headline "why is signal X what it is right now" view. For a chosen
pair (selector matching Market):

- **Latest BlendedSignal panel.** Big colored header — "BUY 0.62" /
  "HOLD" / "SELL 0.41" — with `emittingTimeframe`, `asOf`, gate reason
  if any, single-source-damped flag.
- **Per-timeframe breakdown grid.** 6 rows × columns: weight used,
  type, confidence, bullishScore, bearishScore, rules fired count, gate
  reason, warm-up status. Click a row → modal with full rules-fired
  list and the indicator snapshot at that bar.
- **Signal history timeline.** Last 24h of signals for this pair,
  scrollable. Sparkline of confidence with type-colored dots, hover for
  tooltip.
- **Trivial-change suppression rate** — small stat at the bottom.

### 4.2 Decision Engine page (mid value — new)

Cross-pair, cross-rule analytics over the last N hours. Five cards:

- **Buy/Sell/Hold mix per pair** (stacked bars). Reveals "we never emit
  buy" or "this pair flips constantly".
- **Rule firing leaderboard** — top 20 rules by fire count, bullish vs
  bearish split. Reveals dead rules and over-firing rules.
- **Gate firing rate** — vol / dispersion / stale, per pair, per hour.
  Reveals "vol gate constantly firing on DOGE".
- **Warm-up status matrix** — pair × timeframe grid showing
  `barsSinceStart` vs the slowest `requiresPrior` for that TF. Green if
  past, red if not.
- **Active rules reference** — current `RULES` constant with name,
  group, direction, strength, appliesTo, requiresPrior, cooldownBars.
  Read-only; just a reference table.

### 4.3 Indicators page (mid value — new)

For a chosen pair × timeframe, show the latest `IndicatorState` (~25
fields) plus a 5-bar history sparkline per indicator. Useful for
sanity-checking when a rule fires unexpectedly: "RSI says overbought
but we emitted buy — let me look at the raw RSI value."

Cheap to build because it's a single DDB `GetItem` against
`indicator_state`.

### 4.4 Extend Market page (low effort)

Add three columns to the Latest Prices table: per-exchange `stale`
(true/false), last-update age in seconds, and current dispersion
(cross-exchange spread for the pair). Same data already drives the
stale gate — surfacing it makes that gate transparent.

### 4.5 Extend Overview page (low effort)

Add a "Signals & Indicators" hero strip: total signals emitted last
24h, buy/sell/hold split, gate-fire rate, count of pairs currently in
warm-up. One grid row, four numbers.

## 5. Backend work this implies

One new admin endpoint suffices for §4.1, §4.2, §4.5:

```
GET /api/admin/signals?pair=...&since=...&limit=...
```

Returns recent signals from `signals-v2` with the full BlendedSignal
shape. Aggregation queries (mix per pair, rule leaderboard, gate-fire
rate) can run client-side over the returned set — no new GSIs or
scans for v1.

For §4.3 and §4.4, extend `getMarket()` to also return
`indicator_state` for the chosen pair × timeframe and the per-exchange
staleness/dispersion derived from `prices`.

### 5.1 IAM policy update (gating change)

The Lambda admin-ops policy added in PR #17 grants `Query` and
`GetItem` on `prices`, `candles`, `news_events`, `ingestion_metadata`.
It does **not** include `signals_v2` or `indicator_state`. Both must
be added to the resource list in
`backend/infra/modules/quantara-backend/lambda.tf` before any of the
new endpoints can read data — otherwise the same silent
`AccessDeniedException` failure mode will repeat.

This is a ~5-line Terraform change. Follow the precedent set in PR #17.

## 6. Recommended ship order

1. **Backend slice.** IAM policy update + new
   `GET /api/admin/signals` route + `getMarket()` extension. ~80 LOC.
   Mergeable independently — no UI change, no user-visible effect, but
   unblocks all subsequent work and validates that the data shape is
   what the UI assumes.
2. **Signals page** (§4.1). Single highest-value addition. ~200 LOC.
3. **Decision Engine page** (§4.2). Done client-side from the same
   `/admin/signals` endpoint with a wider time window. ~250 LOC.
4. **Indicators page** (§4.3) and Overview / Market extensions
   (§4.4, §4.5). Defer until §4.1–§4.2 have been used in anger and
   the actual gaps are known.

## 7. Open questions

- **Aggregation server-side vs client-side.** The first cut leans
  client-side (Query last N signals, aggregate in the browser). Once N
  needs to exceed a few hundred per pair, an admin Lambda doing the
  aggregation server-side becomes worth it. Decide when we hit that.
- **Signal-engine controls.** This plan is read-only. A v2 could add
  controls — e.g. "force re-emit", "override threshold for this pair",
  "disable rule X for 1h". Out of scope here; revisit after the
  read-only view exists.
- **Auth/role gate.** The current `requireAdmin` middleware is enough
  for the read-only view. If we add controls (above), it likely needs
  audit logging — not in scope for this plan.
