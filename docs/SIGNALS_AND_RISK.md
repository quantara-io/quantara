# Signals & Risk Management — Design Doc

**Status:** Draft for review
**Owner:** TBD
**Related code:** `backend/src/lib/schemas/genie.ts`, `backend/src/routes/genie.ts`, `packages/shared/src/types/signals.ts`, `ingestion/src/exchanges/{stream,backfill}.ts`, `ingestion/src/lib/candle-store.ts`
**Related docs:** `docs/STORAGE_REDESIGN.md`, `docs/WHALE_MONITORING.md`

---

## 1. Goals & non-goals

### Goals

- Produce a deterministic, backtestable, multi-horizon signal stream (`buy` / `sell` / `hold` + confidence) for the five tracked pairs (BTC, ETH, SOL, XRP, DOGE) across the three exchanges (Binance US, Coinbase, Kraken).
- Blend three input streams: technical indicators (candles), market sentiment (news + Fear & Greed), and — eventually — on-chain whale flow.
- Produce **risk management recommendations** alongside each signal (suggested position size, stop-loss, take-profit) calibrated to the user's tier/risk profile.
- Track signal outcomes and surface accuracy metrics; use them to tune weights over time.
- **Confidence numbers must be calibrated.** A signal emitted at `confidence: 0.8` should resolve correct ~80% of the time over the outcome window. Track Brier score and expected calibration error (ECE) per pair / timeframe — not just hit rate. Without calibration, the confidence number is decorative.
- **Reasoning quality is a first-class output**, not compliance text. The `reasoning` string is what users read on mobile; treat it as product UX. Measurable dimensions: cites specific evidence (named indicators, news headlines, levels), narrative-coherent, length-appropriate (1–3 sentences for the headline; longer on-demand).
- Stay an **advisory** product — Genie never executes trades. (`ADVISORY_DISCLAIMER` is hard-coded into every response.)

### Non-goals

- High-frequency / sub-second signal generation. Tickers stream in real time, but signals emit on candle-close boundaries.
- Cross-exchange arbitrage signals **for Genie**. Arb is execution-bound; an advisory arb signal is either too late to act on or just commentary. Dislocations may surface in a separate **"Market Intelligence"** panel as observational content (e.g. "BTC is $40 wider on Kraken vs Binance right now") — different product surface, separate schema, no buy/sell type.
- Pair-to-pair relative strength signals (BTC vs ETH). Future work.
- Order routing, slippage modeling, or trade execution. Out of scope by product definition.

### Latency SLO

> **v4 update (codex finding Fix #4 / PR #123):** Non-ratified p99 raised from 6s → 7s (Option B) to match the realistic per-segment sum. Ratified p99 stays at 10s.

| Path                     | p50  | p99    |
| ------------------------ | ---- | ------ |
| Non-ratified (algo only) | < 2s | **7s** |
| Ratified (algo + LLM)    | < 5s | 10s    |

Per-segment budget (non-ratified):

| Segment                               | Budget   |
| ------------------------------------- | -------- |
| Candle write → DDB Streams emit       | ≤ 2s     |
| Streams → Lambda invoke (cold + warm) | ≤ 2s     |
| Indicator compute + scoring           | ≤ 1.5s   |
| Blended signal write to DDB           | ≤ 0.2s   |
| Push channel (WebSocket emit)         | ≤ 1s     |
| **Total**                             | **6.7s** |

The sum is 6.7s, rounded up to 7s p99 to give realistic headroom. Raising to 7s is more honest than tightening individual segments to produce a contractual 6s target that real infrastructure will miss.

### Architectural commitment: Hybrid (Option C)

Decision recorded: **algo proposes, LLM ratifies**.

- A deterministic indicator engine emits `{type, confidence, indicators_fired}` on each candle close.
- An LLM ratification layer can **downgrade** (`buy` → `hold`, lower confidence) but never invent a new direction.
- LLM is opt-in per signal — only invoked when the algo confidence and recent news flow justify the cost.
- If the LLM call fails, the algo signal passes through unchanged (graceful degradation).

---

## 2. Inputs available today

| Input                           | Source                                                   | Frequency                          | Storage                                            |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| 1m closed OHLCV candles         | Fargate `MarketStreamManager` (CCXT Pro WebSocket)       | Per minute, per `(exchange, pair)` | DDB `quantara-dev-candles`, 7d TTL                 |
| 5m / 15m / 1h / 4h / 1d candles | `quantara-dev-backfill` Lambda (REST `fetchOHLCV`)       | On-demand backfill, archived to S3 | DDB + S3 archive, TTL 30d / 30d / 90d / 90d / 365d |
| Real-time tickers               | Fargate `watchTicker`                                    | Multi-tick / second                | DDB `quantara-dev-prices`, 7d TTL                  |
| 5-min ticker snapshots          | `quantara-dev-ingestion` Lambda (EventBridge schedule)   | 5 min                              | Same prices table                                  |
| Fear & Greed Index              | `alternative.me/fng` REST poll                           | 1 hour                             | DDB metadata `market:fear-greed`                   |
| News articles                   | Alpaca News API + RSS (CoinTelegraph, Decrypt, CoinDesk) | 2 min                              | DDB `news-events`, 30d TTL                         |
| Sentiment-classified news       | News enrichment Lambda (SQS-driven)                      | Per article                        | DDB `news-events` (enriched fields)                |
| Whale flows                     | **Not yet wired**                                        | —                                  | See `docs/WHALE_MONITORING.md`                     |

### Data-quality gaps to fix before this lands

1. **Higher-timeframe candles (5m / 15m / 1h / 4h / 1d) need a scheduled REST poll on close.**
   EventBridge → Lambda calls `fetchOHLCV(pair, timeframe)` on each close boundary for all three exchanges. Reuses the existing `fetchOHLCV` path (same as backfill). Works for Coinbase (which lacks `watchOHLCV`). Total volume: ~1200 calls/hour, well within rate limits.
   The 1m stream from `MarketStreamManager` continues to drive real-time tickers and intra-bar updates; closed higher-TF candles come from the scheduled poller. WebSocket per-TF subscriptions remain a future option for hot pairs (e.g. BTC) once load is observed.

1a. **`Candle` type must include `source: "live" | "backfill"` (Fix #2-v6).**

All `storeCandles` write paths must populate this field:

| Write path                                | `source` value |
| ----------------------------------------- | -------------- |
| `MarketStreamManager` (live WebSocket)    | `"live"`       |
| Scheduled higher-TF poller (gap #1 above) | `"live"`       |
| Backfill Lambda (`fetchOHLCV` historical) | `"backfill"`   |

The DDB Streams FilterCriteria on the `IndicatorLambda` event source mapping filters on `source.S = "live"`. If any write path omits the field, DDB Streams does not emit a `source.S` attribute — the filter silently rejects the event (no live signal fires, but no incorrect signal either). Validate `source` at write time to catch omissions early.

This is a code change (Candle type + three write paths) that accompanies this design doc. Tracked as a coordinated implementation issue after v6 doc lands.

2. **News-to-pair linking via regex + LLM classifier (union).**
   - Layer 1: regex / word-boundary match for `BTC|XBT|Bitcoin`, `ETH|Ethereum|Ether`, `SOL|Solana`, `XRP|Ripple`, `DOGE|Dogecoin`. Cheap, deterministic, catches ~80% of cases.
   - Layer 2: LLM classifier (Haiku, JSON mode) for affected-but-not-mentioned cases (e.g. "Coinbase SEC pressure on staking" → affects ETH). ~$0.0005/article × ~50 articles/day ≈ **$0.75/month**.
   - Persist as `mentionedPairs: string[]` on the news event. Union of both layers' results.

3. **Per-exchange price canonicalization: median of three with stale exclusion, plus a dispersion metric.**
   - Filter out exchanges with `stale: true`.
   - Take the median of the remainder.
   - Compute `dispersion = (max − min) / median` and persist it.
   - When `dispersion > Xσ` of its 24h average, flag as a volatility-gate input (force `hold` until normalized). Catches flash crashes on a single venue, exchange outages, and real arbitrage events without requiring per-event detection logic.

### X / Twitter sentiment — out of scope for v1

Decided: skip Twitter/X sentiment for v1. Revisit after Phase 8 outcome tracking exposes a measurable gap that X coverage would close. Reasoning: API cost and brittleness are real, signal quality is bot-influenced, and we don't yet know how much our existing news inputs miss.

### Rejected alternatives for higher-timeframe candle ingestion

> **NOT IN ANY PHASE.** Recorded for context only. Do not file issues against these.

| Option                                              | Behavior                                                       | Why rejected for v1                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **WebSocket `watchOHLCV` per timeframe (Option B)** | Subscribe to 5m/15m/1h/4h on the Fargate streamer              | Doesn't solve Coinbase (no `watchOHLCV` support); 4× more WS connections per pair; harder to monitor than Lambda |
| **Aggregate from the 1m stream (Option A)**         | Roll up 1m candles into higher TFs                             | Depends on 1m stream being unbroken (gaps → bad aggregations); doesn't help Coinbase since we have no 1m there   |
| **Chosen: scheduled REST poll (Option C)**          | EventBridge → Lambda calls `fetchOHLCV` on each close boundary | All three exchanges, Lambda monitoring, ~1200 calls/hour, reuses backfill code                                   |

WebSocket per-TF subscription remains a **future option** for hot pairs (e.g. BTC) once production load is observed. Track in §14 Open Questions, not as a v1 phase.

---

## 3. Indicator stack

Indicators are computed per `(exchange, pair, timeframe)` combination, then reduced across exchanges (median) before scoring. All indicators below are standard formulations — listed here so the implementation matches a known reference and we can validate against TradingView / TA-Lib.

### 3.1 Trend indicators

| Indicator                 | Formula                                                                     | Use                                      |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| **EMA(N)**                | `EMA[t] = α·close[t] + (1-α)·EMA[t-1]`, `α = 2/(N+1)`                       | Trend direction at multiple speeds       |
| **MACD(12, 26, 9)**       | `MACD = EMA(12) − EMA(26)`; `signal = EMA(MACD, 9)`; `hist = MACD − signal` | Trend reversals via histogram zero-cross |
| **EMA-stack (20/50/200)** | Bullish if `EMA(20) > EMA(50) > EMA(200)`; bearish inverse                  | Trend regime classification              |

### 3.2 Momentum indicators

| Indicator                | Formula                                                          | Use                              |
| ------------------------ | ---------------------------------------------------------------- | -------------------------------- |
| **RSI(14)**              | `RSI = 100 − 100/(1 + RS)`, `RS = avg_gain(14) / avg_loss(14)`   | Overbought (>70), oversold (<30) |
| **Stochastic(14, 3, 3)** | `%K = 100·(close − low_N) / (high_N − low_N)`; `%D = SMA(%K, 3)` | Oscillator — sharper than RSI    |
| **ROC(N)**               | `(close[t] − close[t-N]) / close[t-N]`                           | Raw momentum strength            |

### 3.3 Volatility indicators

| Indicator              | Formula                                                                                  | Use                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **ATR(14)**            | `TR = max(high − low, abs(high − close[-1]), abs(low − close[-1]))`; `ATR = SMA(TR, 14)` | **Stop-loss sizing.** ATR defines "normal" volatility.                     |
| **Bollinger(20, 2σ)**  | `mid = SMA(20)`, `upper/lower = mid ± 2·stdev(20)`                                       | Bandwidth = squeeze detection; price-touching = mean-reversion candidate   |
| **Realized vol (24h)** | `stdev(returns_1m, last 1440 bars) · sqrt(525600)` (annualized)                          | Trigger the `volatilityFlag` if > threshold (forces all signals to `hold`) |

### 3.4 Volume indicators

| Indicator                | Formula                                                           | Use                                                     |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------- |
| **OBV**                  | `OBV[t] = OBV[t-1] + sign(close[t] − close[t-1]) · volume[t]`     | Confirms or contradicts price moves                     |
| **VWAP** (intraday only) | `Σ(typical_price · volume) / Σ(volume)` reset at session boundary | Reference for intraday signals; institutional benchmark |
| **Volume z-score**       | `(volume[t] − SMA(volume, 20)) / stdev(volume, 20)`               | Spot abnormal volume; gates breakouts                   |

### 3.5 Structural indicators — deferred to v2

Structural / pivot detection (higher highs / lower lows, swing-high/low proximity, support/resistance) is **out of v1 algo rules**. Robust pivot detection requires a ZigZag-style minimum-move filter and its own tunable threshold; not worth the implementation surface for the first cut.

The LLM ratification layer (§7) can still comment qualitatively on structure ("price bounced off the 4h support that held three times in March") because it has chart-style narrative context.

### 3.6 What's deliberately omitted (and why)

- **Ichimoku Cloud** — high explanatory power, but adds 5 lines of indicator output without independent information from the EMA stack + ATR.
- **Fibonacci retracements** — subjective anchor points; brittle without manual chart marking.
- **Elliott Wave / Harmonic patterns** — not robustly automatable; LLM ratification can do the qualitative version if needed.

### 3.7 Smoothing convention — Wilder's RMA (not SMA)

RSI and ATR canonically use **Wilder's smoothing** (sometimes called RMA — Running Moving Average):

```
avg[t] = (avg[t-1] · (N − 1) + current[t]) / N
```

Match TradingView and every standard charting tool. Avoids "why does your RSI not match TradingView?" support tickets. Mixing Wilder's smoothing for RSI/ATR with SMA for other indicators in the codebase is a common silent-bug source — keep them separate and named explicitly (`wilderSmooth(...)` vs `sma(...)`).

### 3.8 VWAP session boundary — UTC midnight reset

VWAP resets at **00:00 UTC daily**. Simple, cross-exchange consistent, standard convention for 24/7 crypto markets. VWAP only computed for `15m` and `1h` timeframes (see §3.4); not meaningful on `4h`/`1d`.

### 3.9 Numerical & implementation guidance

Codified as test fixtures and sanity bars to hit in Phase 1:

1. **Test against a TradingView reference** for each indicator on a fixed 200-bar fixture. Tolerance: `1e-4` absolute error on RSI/Stoch/MACD; `1e-6` on EMA/SMA/ATR.
2. **Pure functions:** `(candles, params) → indicator series`. No mutation of input arrays.
3. **Aligned series:** if the indicator can't compute for the first `N` bars (warm-up), return `null` for those slots. Do not shift indices.
4. **Single-bar update parity:** `update(state, newCandle)` must produce the same result as full recomputation. Critical for the indicator-state cache (§12). Unit test should bash both paths.
5. **Division-by-zero guards:**
   - Stochastic: if `high_N == low_N`, return `%K = 50`.
   - Bollinger Bands: if `stdev == 0`, set band-width to a small epsilon.
   - True Range: bar 0 uses `high − low` (no previous close).
   - Volume z-score: if `stdev(volume, N) == 0`, return 0.
6. **Warm-up:** treat the first `3·N` bars as no-signal in backtests. EMA/Wilder's smoothing have a long warm-up tail.

### 3.10 Recommended library

Implement formulas in TypeScript directly in `ingestion/src/indicators/` rather than depending on `technicalindicators` npm. Reasons:

- The dependency is unmaintained (last release ~2 years ago at time of writing).
- The formulas above are <50 lines each. We need them auditable.
- Avoids a `package.json` change, which is a tripwire under the agent workflow.

### 3.11 Per-indicator implementation hazards

For Phase 1 implementers — concrete traps to handle, with the right answer.

| Indicator          | Hazard                                                                                           | Handling                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **EMA**            | Naive recursion `EMA[0] = close[0]` is biased low for ~3·N bars                                  | Seed `EMA[N-1] = SMA(close, N)`, then recurse from bar `N`. Ignore first 3·N bars in backtests.           |
| **RSI**            | Two valid avg-gain/loss methods (Wilder's RMA vs SMA) produce different numbers                  | Use **Wilder's RMA** to match TradingView. Document explicitly in code.                                   |
| **RSI**            | First N values undefined                                                                         | Return `null` (not 50) for warm-up bars; treat as no-signal                                               |
| **Stochastic**     | When `high_N == low_N` (perfectly flat bar), formula divides by zero                             | If range is zero, return `%K = 50`                                                                        |
| **ATR**            | Bar 0 has no previous close → True Range undefined                                               | Use `high − low` for bar 0 only                                                                           |
| **ATR**            | Mixing Wilder's smoothing for ATR with SMA elsewhere causes silent number drift                  | Use **Wilder's RMA** explicitly; name helpers `wilderSmooth(...)` vs `sma(...)`                           |
| **Bollinger**      | Standard deviation: divide by N or N-1?                                                          | Divide by N (population stdev — Bollinger's original spec, TradingView default)                           |
| **Bollinger**      | During calm periods, BB width approaches zero, "touch" rule fires constantly                     | Rules using band touches must also check `bbWidth > Yth percentile` over a window                         |
| **OBV**            | Cumulative and unbounded — comparing OBV value across pairs is invalid                           | Use OBV **slope** (linear regression over last 10 bars) as the actual signal                              |
| **VWAP**           | Crypto trades 24/7 — no natural session boundary                                                 | Reset at **00:00 UTC** daily. Compute only for 15m / 1h timeframes.                                       |
| **Volume z-score** | Volume has strong time-of-day pattern; flat z-score over 20 bars compares 03:00 UTC to 14:00 UTC | Acceptable noise for v1. Time-of-day-bucketed z-score is **deferred to v2**.                              |
| **Volume z-score** | If `stdev(volume, N) == 0`, division explodes                                                    | Guard: return 0                                                                                           |
| **Realized vol**   | Annualization factor depends on timeframe                                                        | `bars_per_year = {1m: 525600, 5m: 105120, 15m: 35040, 1h: 8760, 4h: 2190, 1d: 365}`                       |
| **Realized vol**   | First N log-returns include NaN if any candle has zero close                                     | Skip bars with zero or null close; require ≥N valid returns before emitting                               |
| **All**            | Single-bar-update path may diverge from full-recomputation path                                  | Phase 1 acceptance: unit test asserts `update(state, candle) ≡ recompute(allCandles)` for every indicator |

---

## 4. Per-timeframe scoring

Each timeframe produces an independent vote `{type, confidence, evidence}` using a **rule-confluence** model. Chosen over decision trees and ML approaches because (a) it ships with zero training data, (b) `rulesFired[]` is naturally explainable in the reasoning string, and (c) it migrates cleanly to logistic regression after Phase 8 outcome data exists.

### Rejected scoring approaches

> **NOT IN ANY PHASE.** Recorded for context only.

| Approach                                        | Why rejected for v1                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Decision tree** (hand-coded if/else nesting)  | Brittle — one rule change reshapes outputs; hard to maintain                                       |
| **Logistic regression on indicators → outcome** | Needs ~6 months of labeled outcomes per pair × TF before fitting; can't ship without training data |
| **Random forest / gradient-boosted trees**      | Same data dependency; opaque attribution; harder to audit                                          |
| **Fuzzy logic (membership functions, T-norms)** | More expressive but harder to debug; team needs to build fuzzy-logic literacy first                |

**Forward path:** rule confluence today, logistic regression replaces hand-tuned strengths in a future phase once Phase 8 attribution data is rich enough. The rule structure stays; only the strengths become learned. Track as a future-phase candidate, not a v1 issue.

### 4.1 Rule structure

```ts
interface Rule {
  name: string;
  direction: "bullish" | "bearish" | "gate";
  strength: number; // contribution to score on fire
  when: (state: IndicatorState) => boolean;

  appliesTo: Timeframe[]; // TFs the rule runs on
  group?: string; // mutually-exclusive group
  cooldownBars?: number; // suppress re-fire for N bars
  requiresPrior: number; // bars of warm-up before eligible
}
```

Each non-trivial field prevents a specific class of bug:

- **`appliesTo`** — not every rule makes sense on every timeframe. `bollinger-touch-lower` is meaningful on 4h/1d, noise on 15m. `vwap-cross` is intraday only. Without this, rules double-count on shorter timeframes.
- **`group`** — solves rule overlap. Tiered thresholds (`rsi < 30`, `rsi < 20`, `rsi < 15`) share `group: "rsi-oversold"`; the scorer picks the highest-strength fired rule per group.
- **`cooldownBars`** — anti-spam. `macd-cross-bull` on a choppy bar can fire, reset, fire again. Cooldown of 3 bars prevents flip-flop signal emission.
- **`requiresPrior`** — warm-up safety. EMA(200) needs ~600 bars before it stabilizes. Rules depending on `ema200` carry `requiresPrior: 600` so they don't fire on cold-start junk values.

Selection logic:

```ts
function scoreRules(state: IndicatorState, rules: Rule[]): FiredRule[] {
  const fired = rules.filter(
    (r) =>
      r.when(state) &&
      r.appliesTo.includes(state.tf) &&
      state.barsSinceStart >= r.requiresPrior &&
      state.barsSinceLastFire(r) >= (r.cooldownBars ?? 0),
  );
  const byGroup = groupBy(fired, (r) => r.group ?? r.name);
  return Object.values(byGroup).map((group) =>
    group.reduce((max, r) => (r.strength > max.strength ? r : max)),
  );
}
```

Maintain the rule list in `packages/shared/src/constants/signals.ts`. See Appendix A.

### 4.2 IndicatorState shape

State carries current indicator values plus a 5-bar history ring buffer for cross/divergence rules.

```ts
interface IndicatorState {
  pair: string;
  exchange: string; // or "consensus" for canonicalized
  timeframe: Timeframe;
  asOf: number; // unix ms of latest closed candle
  barsSinceStart: number; // for requiresPrior gating

  // current bar
  rsi14: number;
  ema20: number;
  ema50: number;
  ema200: number;
  macdLine: number;
  macdSignal: number;
  macdHist: number;
  atr14: number;
  bbUpper: number;
  bbMid: number;
  bbLower: number;
  bbWidth: number;
  obv: number;
  obvSlope: number; // slope over last 10 bars
  vwap: number | null; // null on TFs other than 15m/1h
  volZ: number;
  realizedVolAnnualized: number;
  fearGreed: number; // overlay, refreshed hourly
  dispersion: number; // cross-exchange spread / median

  // 5-bar history (most recent first)
  history: {
    rsi14: number[];
    macdHist: number[];
    ema20: number[];
    ema50: number[];
    close: number[];
    volume: number[];
  };
}
```

### 4.3 Scoring formula

```
bullish_score = Σ strength of fired bullish rules (after group-max)
bearish_score = Σ strength of fired bearish rules (after group-max)

if any gate fired (vol / dispersion / stale):
    type = "hold"
    confidence = 0.5
    volatilityFlag = true (if vol or dispersion); gateReason populated
elif bullish_score > bearish_score AND bullish_score >= MIN_CONFLUENCE:
    type = "buy"
    confidence = sigmoid(bullish_score − bearish_score)
elif bearish_score > bullish_score AND bearish_score >= MIN_CONFLUENCE:
    type = "sell"
    confidence = sigmoid(bearish_score − bearish_score)
else:
    type = "hold"
    confidence = 0.5 + 0.1 · abs(bullish_score − bearish_score)
```

Constants (per-pair tunable post-Phase-8):

- `MIN_CONFLUENCE = 1.5` — one strong rule (≥1.5) or two corroborating weak rules.
- `sigmoid(x) = 1 / (1 + exp(-x/2))` — bounded [0, 1], saturates above ±5.

### 4.4 Confidence is ordinal in v1

The hand-tuned strengths produce a `confidence` number that is **ordinally meaningful** (higher = more bullish/bearish) but **not a calibrated probability**. The UI must not promise it as one before Phase 8.

After Phase 8 (≥30 resolved signals per pair × timeframe), replace the raw sigmoid with **Platt scaling** fit per `(pair, timeframe)`:

```
calibrated_confidence = sigmoid(a · raw_score + b)
```

where `(a, b)` are fit by minimizing log loss on the actual outcome history. Produces actually-calibrated confidence. Track expected calibration error (ECE) and Brier score as the primary signal-quality metrics.

### 4.5 Three terminal states (not two)

| State                                                      | Meaning       | When                                                            |
| ---------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| `signal: {type, confidence, ...}`                          | Normal output | Rules fire above threshold, no gates                            |
| `signal: {type: "hold", volatilityFlag: true, gateReason}` | Gated hold    | Vol / dispersion / stale-data gate fired                        |
| `null`                                                     | No opinion    | Warm-up, missing required indicators, exchange data unavailable |

`null` is distinct from `hold`. `hold` means "I have an opinion: stay out." `null` means "I don't have an opinion." UIs must surface the distinction (e.g. greyed-out vs. yellow `hold` chip).

### 4.6 Gate spec (volatility / dispersion / stale)

Three independent gates, any of which forces `type = "hold"`:

**Volatility gate** — per-pair absolute annualized-vol thresholds for v1. Migrate to 30-day z-score in v2 once history exists.

| Pair      | Vol gate threshold (annualized) |
| --------- | ------------------------------- |
| BTC/USDT  | 150%                            |
| ETH/USDT  | 200%                            |
| SOL/USDT  | 300%                            |
| XRP/USDT  | 250%                            |
| DOGE/USDT | 350%                            |

Computed from log returns of the timeframe in question:

```
log_returns = ln(close[t] / close[t-1])  // last N bars
realized_vol = stdev(log_returns) · sqrt(bars_per_year)
```

`bars_per_year = {1m: 525600, 5m: 105120, 15m: 35040, 1h: 8760, 4h: 2190, 1d: 365}`

**Dispersion gate** — cross-exchange agreement check. Decided in §2: drop stale exchanges, take median, compute `dispersion = (max − min) / median` across remainder. Gate when `dispersion > 0.01` (1%) sustained for 3 consecutive bars on the timeframe in question. Catches single-venue flash crashes and exchange-specific glitches.

**Stale gate** — if ≥2 of 3 exchanges flag `stale: true` on their latest tick, gate `hold` until ≥2 are fresh again.

Existing constant:

```ts
// packages/shared/src/constants/signals.ts (already shipped)
export const VOLATILITY_BANNER =
  "High market volatility detected. All signals set to HOLD. Exercise caution.";
```

The banner copy may need expansion when the gate reason is dispersion or stale, not vol. Suggest `gateReason: "vol" | "dispersion" | "stale"` on the signal so the UI can show the right copy.

### 4.7 Per-rule timeframe applicability

Direct input to Appendix A. Each rule declares `appliesTo: Timeframe[]`.

| Rule (from Appendix A)                     | 15m | 1h  | 4h  | 1d  |
| ------------------------------------------ | --- | --- | --- | --- |
| `rsi-oversold-strong` / `rsi-oversold`     | ✅  | ✅  | ✅  | ✅  |
| `rsi-overbought-strong` / `rsi-overbought` | ✅  | ✅  | ✅  | ✅  |
| `ema-stack-bull` / `ema-stack-bear`        | ❌  | ❌  | ✅  | ✅  |
| `macd-cross-bull` / `macd-cross-bear`      | ❌  | ✅  | ✅  | ✅  |
| `bollinger-touch-lower` / `-upper`         | ❌  | ❌  | ✅  | ✅  |
| `volume-spike-bull` / `-bear`              | ✅  | ✅  | ✅  | ✅  |
| `fng-extreme-greed` / `-extreme-fear`      | ✅  | ✅  | ✅  | ✅  |
| `vwap-cross-bull` / `-bear` (future)       | ✅  | ✅  | ❌  | ❌  |

Rationale for the `❌` cells: `ema-stack` and `bollinger-touch` rules fire too frequently on shorter timeframes during quiet periods, producing false-positive signals that the user has to filter out. `macd-cross-bull` on 15m bars is similarly noisy. VWAP is intraday-only by definition (§3.8).

### 4.8 Worked example

Anchor the formula in something concrete. **BTC/USDT on 1h timeframe**, hypothetical state:

```
state = {
  rsi14: 24,                                  // oversold
  ema20: 79500, ema50: 79800, ema200: 80100,  // bearish stack
  macdHist: 0.4, macdHist[t-1]: -0.1,         // just crossed up
  atr14: 280, bbLower: 79100,
  close: 79280, open: 79300,                  // bearish bar
  volZ: 2.3,                                  // volume spike
  fearGreed: 22,                              // extreme fear
  realizedVolAnnualized: 0.85,                // 85% — under BTC gate of 150%
  dispersion: 0.0008,                         // 0.08% — under gate
}
```

Rules fired (after group-max selection, after `appliesTo` filter):

| Rule                                      | Direction                         | Strength |
| ----------------------------------------- | --------------------------------- | -------- |
| `rsi-oversold` (group: rsi-oversold-tier) | bullish                           | +1.0     |
| `macd-cross-bull`                         | bullish                           | +1.0     |
| `fng-extreme-fear`                        | bullish                           | +0.3     |
| `ema-stack-bear`                          | bearish                           | +0.8     |
| `volume-spike-bull`                       | — (close < open, condition fails) | —        |

Score:

```
bullish = 1.0 + 1.0 + 0.3 = 2.3
bearish = 0.8

bullish ≥ MIN_CONFLUENCE (1.5)? Yes.
bullish > bearish? Yes.
type = "buy"
confidence = sigmoid(2.3 − 0.8) = sigmoid(1.5) = 1/(1+exp(-1.5/2)) = 1/(1+exp(-0.75)) ≈ 0.68
volatilityFlag = false (no gate fired)
```

Reasoning string the algo emits (LLM ratification then refines):

> _"Oversold RSI plus fresh MACD bullish cross on the 1h, with extreme fear sentiment supporting a contrarian bounce. Daily-style EMA stack remains bearish — keeps confidence moderate. Bounce candidate, not a trend reversal."_

This is the kind of signal the algo emits cleanly. Mean-reversion buy against the longer-term trend is a valid setup at lower confidence — precisely what the formula expresses.

---

## 5. Multi-horizon blending

The user picked multi-horizon: compute on 15m / 1h / 4h / 1d, blend into one signal per pair.

### 5.1 Why multi-horizon

- 1d catches regime; 4h catches trend; 1h catches setup; 15m catches entry timing.
- Disagreement between horizons is itself informative — "bullish on 1d, bearish on 1h" is a "hold for now, watch the 1h reversal" signal, not a buy or a sell.
- Makes confidence better calibrated: when _all_ horizons agree, confidence is high; when they conflict, confidence drops.

### 5.2 Weighting

Default weights (tunable per-pair after calibration):

| Timeframe | Weight | Rationale                                       |
| --------- | ------ | ----------------------------------------------- |
| 1d        | 0.35   | Regime — most predictive over multi-day windows |
| 4h        | 0.30   | Trend                                           |
| 1h        | 0.20   | Setup                                           |
| 15m       | 0.15   | Entry timing                                    |

5m and 1m are **not used for the headline signal**. They drive the streaming UI, not Genie's recommendation, because the noise-to-signal ratio is brutal at those timeframes for an advisory product.

### 5.3 Blending formula

Map each per-timeframe vote to a scalar in `[-1, +1]`:

- `buy` → `+confidence`
- `sell` → `-confidence`
- `hold` → `0`

Then:

```
blended = Σ(weight_tf · scalar_tf)
type = "buy"  if blended > +T
       "sell" if blended < −T
       "hold" otherwise

confidence = min(1, abs(blended) · 1.2)  // small upscale, then clamp
volatilityFlag = OR of per-tf volatility gates
```

`T = 0.25` recommended — i.e. need a clear majority across weighted horizons before committing to a direction. With four timeframes weighted as above, this means at least two timeframes must agree with non-trivial confidence.

### 5.4 Disagreement handling

If `1d` says `buy` and `1h` says `sell`, the blended scalar might still be bullish but with low magnitude — naturally resolves to `hold` via the threshold `T`. The reasoning string should call this out explicitly: _"Daily trend is up but the 1h is rolling over. Wait for confirmation."_

**Decision: keep the 3-type schema (`buy / sell / hold`). Do not add a `conflict` type in v1.** The reasoning string is the right surface for inter-TF disagreement. Adding a 4th type would touch the `Signal.type` enum, signal history, accuracy scoring, and the UI chip set — too much change for nuance the LLM can express in prose. Revisit if user research shows the distinction matters.

### 5.5 Time alignment — when do we re-blend?

**Policy: re-blend on every per-TF close. Suppress the user-visible signal change if it's trivial.**

Each TF closes at its own boundary (15m every 15 min, 1h every hour, 4h every 4 hours, 1d at 00:00 UTC). Whenever any per-TF vote updates, the blender re-runs against the current set of cached votes from all four TFs.

Suppression rule for UI emit (does not affect internal storage — every blend run is persisted to DDB):

```
if  blended.type === previous_blended.type
AND |blended.confidence − previous_blended.confidence| < 0.05
AND blended.volatilityFlag === previous_blended.volatilityFlag
AND blended.gateReason === previous_blended.gateReason
then: silent update — no notification, no UI badge change
else: emit user-visible change
```

This gives freshness internally (every minute matters for backtest replay and audit) while keeping the user-visible signal stable.

**Compute cost:** 5 pairs × ~96 closes/day across the 4 TFs (15m=96, 1h=24, 4h=6, 1d=1; sum = 127 per pair/day) ≈ 635 blend runs/day. Lambda + DDB write ≈ negligible (~$5/month).

### 5.6 Per-TF `null` (no opinion) handling

When a per-TF vote returns `null` (warm-up, missing required indicator), drop that TF from the blend and **re-normalize** the remaining weights proportionally.

Example: `1d` is `null` (still warming up the 200-bar EMA). Remaining TFs:

```
{15m: 0.15, 1h: 0.20, 4h: 0.30}
total = 0.65
renormalized = {15m: 0.231, 1h: 0.308, 4h: 0.461}
```

The blend proceeds with reduced confidence (one fewer source of agreement). If **all four** TFs are `null`, the blend itself returns `null` and the UI shows "warming up — no signal yet." Distinct from `hold` (which means "I have an opinion: stay out").

Rationale: a multi-day silence on cold-start is a worse UX than a slightly-noisier early-stage signal. Honesty comes through naturally — fewer voting TFs → lower blended magnitude → lower confidence → harder to cross threshold `T`.

### 5.7 Per-pair weights — single vector for v1

Default weights `(15m: 0.15, 1h: 0.20, 4h: 0.30, 1d: 0.35)` apply uniformly across all 5 pairs in v1.

Per-pair tuning (e.g. DOGE may benefit from a 15m-heavier vector since it lacks BTC's regime persistence) **lands as a Phase 8 deliverable** once outcome attribution data per `(pair, TF)` exists. Tuning without data is just guessing twice.

### 5.8 Edge cases — explicit table

| Case                                                | Recommended behavior                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| All 4 TFs vote `null`                               | Blend returns `null`. UI: "warming up — no signal yet."                                                               |
| All 4 TFs vote `hold` (no gates)                    | Blend returns `hold` at confidence 0.5.                                                                               |
| 3 TFs `null`, 1 TF votes                            | Re-normalized weight = 1.0 on the voting TF. Blend confidence multiplied by 0.7 to reflect single-source uncertainty. |
| Any TF has `volatilityFlag: true`                   | Blend forces `type = "hold"`, `volatilityFlag: true`, `gateReason: "vol"`. Confidence = 0.5.                          |
| Any TF has `gateReason = "dispersion"` or `"stale"` | Blend forces `type = "hold"`, propagates the gateReason. Confidence = 0.5.                                            |
| Mixed gates (e.g. 4h `vol`-gated, 1h `stale`-gated) | Priority: `vol` > `dispersion` > `stale`. Blend's `gateReason` is the highest-priority one fired on any TF.           |

### 5.9 Event-driven trigger — 2-phase collect-then-compute (v5 design)

> **v6 design (supersedes v5). v4 fixes retained: Fix #1-v4 (P1 — drop claimedBy), Fix #2-v4 (P2 — FilterCriteria timeframe), Fix #3-v4 (P2 — TTL epoch seconds). Traced to codex review of PR #123.**
>
> **v5 fixes retained. Traced to codex review of PR #125 (comment #4409943828):**
>
> - **Fix #1-v5 (P1):** Eliminate mark-then-emit race — drop `processed-close-store` entirely; use `signals-v2` conditional Put as the sole dedup mechanism.
> - **Fix #2-v5 (P1):** Drop `source` filter from FilterCriteria — existing candle writers did not persist a `source` attribute. Superseded by Fix #2-v6 below.
> - **Fix #5-v5 (P3):** Rename `exchange` (singular) → `exchanges` (plural) in pseudo-code to match the schema and quorum-check logic.
>
> **v6 fixes (this doc). Traced to codex review of PR #127 (issue #128):**
>
> - **Fix #1-v6 (P1):** Change `signals-v2` to deterministic PK/SK (`pair` + `closeTime#tf`). Conditional Put with `attribute_not_exists(pair)` is now the dedup. Eliminates the `signalKey` non-key attribute; two concurrent handlers with the same PK+SK cannot both win.
> - **Fix #2-v6 (P1):** Re-add `source = "live"` to FilterCriteria (write-side fix: `Candle` type gains `source: "live" | "backfill"`; all `storeCandles` paths populate it). Prevents backfill candles from triggering live signal computation.
> - **Fix #3-v6 (P2):** Rename `candles-v2` → `candles` in Phase 4 (typo).

#### Trigger architecture

The indicator handler is a Lambda subscribed to a DDB Streams event source mapping on the `quantara-{env}-candles` table. Each new candle write emits a stream event; the handler accumulates exchange writes into a `close-quorum` row, and any handler that observes full quorum computes and commits the blended signal.

**Event source mapping FilterCriteria (Fix #2-v4 + Fix #2-v6 — timeframe allowlist + source = "live"):**

```json
{
  "Filters": [
    {
      "Pattern": "{ \"dynamodb\": { \"NewImage\": { \"timeframe\": { \"S\": [\"15m\", \"1h\", \"4h\", \"1d\"] }, \"source\": { \"S\": [\"live\"] } } } }"
    }
  ]
}
```

Why both filters (Fix #2-v6): the timeframe allowlist excludes 1m/5m candles as before. The `source = "live"` filter excludes backfill candles from triggering signal computation — without it, any historical candle written after the stream is enabled passes the timeframe filter and causes the indicator handler to emit a "live" signal for a historical slot. This is a correctness issue, not just overhead: historical slots without a pre-existing `signals-v2` row would produce a live signal that fans out to WebSocket subscribers.

The `source` field is now mandatory on all `Candle` writes (Fix #2-v6). See §2 for the updated `Candle` type and `storeCandles` paths that populate it. v5 deferred this as optional cleanup; v6 promotes it to a P1 fix because the correctness risk is real.

#### Step 1 — Collect exchanges (string set ADD)

On each filtered stream event, the handler writes to `close-quorum`:

```
PK: pair#timeframe#closeTime  (e.g. "BTC/USDT#1h#1746576000000")
exchanges: string set ADD { exchange }   // Fix #5: plural "exchanges" — atomic ADD, idempotent on retry
ttl: Math.floor(closeTimeMs / 1000) + 86_400   // epoch SECONDS (Fix #3-v4 — see note below)
```

**TTL conversion note (Fix #3-v4):** DynamoDB TTL is interpreted as Unix epoch seconds. `Candle.closeTime` is epoch milliseconds. The conversion is:

```ts
// Option A — explicit:
ttl: Math.floor((closeTimeMs + 86_400_000) / 1000);

// Option B — equivalent, clearer intent:
ttl: Math.floor(closeTimeMs / 1000) + 86_400;
```

Both are correct. Do NOT write `closeTimeMs + 86_400_000` as the TTL value — that produces a value ~1000× too large (year ~57000) and the row will never expire.

#### Step 2 — Check quorum

After the ADD, the handler reads the current `close-quorum` item and checks:

```
item.exchanges.size >= REQUIRED_EXCHANGE_COUNT
```

If quorum is not reached, stop. (Another handler will complete the slot when the remaining exchanges write.)

#### Step 3 — Check signals-v2 for prior processing (Fix #1-v5 retained, Fix #1-v6 — deterministic PK/SK)

Read `signals-v2` with `PK = pair`, `SK = closeTime#tf` (e.g. `"1715187600000#15m"`). If the item exists, this slot was already processed by a prior handler (possibly a retried invocation). Skip.

**Why deterministic PK/SK (Fix #1-v6):** v5 used `signalKey = pair#tf#closeTime` as a non-key attribute and issued a conditional Put with `attribute_not_exists(signalKey)`. Two parallel handlers each generated a unique `signalId` SK, so each Put targeted a _different_ item in `signals-v2`. `attribute_not_exists(signalKey)` was true for both — the dedup did not fire, and both signals fanned out. With a deterministic SK (`closeTime#tf`), two parallel handlers Put the _same item_. DynamoDB serializes concurrent Puts on the same PK+SK; only the first wins the conditional check.

**Why this replaces `processed-close-store` (Fix #1-v5 retained):** v4 used a separate `processed-close-store` table as a marker: write the marker first, then emit the signal. If the handler crashed between the marker write (won) and the signal-v2 write, the retried stream event saw the marker present, skipped the slot, and the signal was permanently lost — the same class of race as the v3 `claimedBy` bug, just inverted.

v5 **drops `processed-close-store` entirely**. There is now only one persistence step: the conditional Put on `signals-v2` (Step 4). Crash recovery: any handler that has not yet completed the conditional Put will retry the entire flow (Steps 1–4) on stream re-delivery. No orphaned marker can block recovery.

#### Step 4 — Compute + conditional Put on signals-v2

Compute the indicators and blended signal, then write with a **conditional Put** on the deterministic `PK = pair`, `SK = closeTime#tf`:

```
ConditionExpression: attribute_not_exists(pair)
```

- **First handler to succeed** writes the signal to `signals-v2`. Done.
- **Other concurrent handlers** (rare race) attempt a Put on the same PK+SK → DynamoDB serializes; their conditional Put fails with `ConditionalCheckFailedException` → they discard the result. No duplicate signal ever reaches `signals-v2`.
- **Handler that crashed before the Put** left no trace → DDB Streams retries the event → a fresh handler runs Steps 1–4 again and completes normally.

#### No `claimedBy` field (Fix #1-v4 retained)

v3 used a 3-phase `claimedBy` pattern: collect → claim → compute → mark-processed. If the handler set `claimedBy` but crashed before writing `processedAt`, the slot was permanently unrecoverable (retries skipped it because `claimedBy` was present).

v4 **dropped `claimedBy` entirely**. v5 dropped the separate `processed-close-store` marker. v6 makes the `signals-v2` key deterministic, so the conditional Put is now the single-winner, single-persistence-step mechanism:

- No orphaned slots — crash recovery is automatic via stream retry
- Race-window cost: in the rare case where 2+ handlers run concurrently for the same slot, both do the compute work, but only one succeeds at the Put (same PK+SK → DDB serializes). Wasted compute is bounded (compute is 500ms–2s; stream events are mostly serialized per slot via DDB Streams batching)
- Correctness guarantee: a signal is written to `signals-v2` exactly once per slot, by the first handler to win the conditional Put on the deterministic PK+SK

#### Summary of collect-then-compute flow

```
Stream event (filtered: timeframe in [15m,1h,4h,1d] AND source = "live")
  │
  ├─ Step 1: ADD exchange to close-quorum row (exchanges field, idempotent)
  │
  ├─ Step 2: read close-quorum; exchanges.size >= REQUIRED_EXCHANGE_COUNT? if not → stop
  │
  ├─ Step 3: read signals-v2 by PK=pair, SK=closeTime#tf; if exists → stop (already processed)
  │
  └─ Step 4: compute indicators + blended signal
             conditional Put on signals-v2 (PK=pair, SK=closeTime#tf)
             with attribute_not_exists(pair)
             if Put succeeds: done
             if Put fails (ConditionalCheckFailed): discard (another handler won)
```

### 5.10 Design decision: BLEND_THRESHOLD_T = 0.25 makes 15m and 1h directional signals mathematically impossible to surface alone

**Status: accepted by design for v1. Revisit when calibration data is available.**

#### The math

With default weights and `BLEND_THRESHOLD_T = 0.25`, the maximum blended scalar a single timeframe can contribute (at perfect confidence = 1.0) is:

| Timeframe | Weight | Max contribution (conf = 1.0) | Can cross T = 0.25 alone? |
| --------- | ------ | ----------------------------- | ------------------------- |
| 15m       | 0.15   | ±0.15                         | No                        |
| 1h        | 0.20   | ±0.20                         | No                        |
| 4h        | 0.30   | ±0.30                         | Yes                       |
| 1d        | 0.35   | ±0.35                         | Yes                       |

When 4h and 1d both vote `hold` — the common case in quiet markets where those rules require longer history — no amount of conviction on 15m or 1h alone produces a directional blended signal. For example, a textbook 1h RSI-overbought + volume-spike-bear setup at confidence 0.679 contributes only `−0.136` to the blended scalar, which stays inside the `[−0.25, +0.25]` hold band.

#### Why this is intentional (for now)

The threshold design reflects a deliberate stance: **short-TF directional firing is treated as noise unless it co-occurs with a longer-TF vote.** The 1d and 4h frames capture regime and trend; 1h and 15m capture setup and entry timing. The framework rewards multi-TF agreement and penalizes whipsaw signals by requiring weight-weighted consensus before committing to a direction.

The alternative — lowering `T` to 0.20 or reweighting 1h to 0.30 — would let short-TF votes surface more often, at the cost of more emissions and likely more noise at the current (pre-calibration) product stage.

#### When to revisit

Once the Performance page Calibration section (tracked in issues #226/#227) has enough outcome data, compare:

- **Win rate of 1h-directional signals that were blended through** (i.e. co-occurred with a 4h or 1d directional vote)
- **Win rate of 1h-directional signals that were suppressed** (i.e. 4h and 1d were both hold)

If the suppressed cohort shows meaningful edge, revisit one of:

- **(B)** Lower `BLEND_THRESHOLD_T` to 0.20 so a max-confidence 1h vote can cross.
- **(D)** Reweight to `{15m: 0.10, 1h: 0.30, 4h: 0.30, 1d: 0.30}` so 1h crosses T at full confidence.
- **(C)** Add a "minority report" override: if any single TF votes directional with confidence > 0.70, route the blend to that TF's verdict regardless of weight math.

Do not change `BLEND_THRESHOLD_T` or the weights without empirical data. See also `ingestion/src/signals/blend.ts` comments near `DEFAULT_TIMEFRAME_WEIGHTS` and `BLEND_THRESHOLD_T`.

---

## 6. Sentiment integration

### 6.1 What we ingest today

- **News articles** via Alpaca + 3 RSS feeds (every 2 min). Each article has title, body, and an `enrichment` job that runs sentiment classification.
- **Fear & Greed Index** (hourly): a single value 0–100 with classification (`extreme fear` … `extreme greed`).

### 6.2 What needs to be added

1. **Pair entity extraction** in the enrichment Lambda — regex + LLM classifier union per the §2 decision. Tag each article with the symbol(s) it mentions or affects.
2. **Sentiment polarity** per article: `{score: -1..+1, magnitude: 0..1}`. **Classifier: Haiku in JSON mode** (decision below).
3. **Aggregated sentiment** per pair over a rolling window:
   - `last 4h` and `last 24h` windows
   - Stored in a derived metadata key, e.g. `sentiment:BTC:4h = {score, magnitude, articleCount, sourceCounts, computedAt}`
   - Recomputed when new news lands or every 5 min on a schedule.

### 6.3 How sentiment enters the signal

Sentiment is **not** treated as an algo rule. It enters at the LLM ratification step (§7). Why:

- Sentiment is qualitative. Trying to express "Coinbase delisting rumor" as `+0.8` on a fixed rule is a brittle hack.
- The LLM is already good at reading a 200-word headline and deciding _"this materially changes my view of the next 4h."_
- Keeping sentiment out of the algo preserves backtestability — algo signals are deterministic from candles alone. Sentiment overlays are tracked separately for attribution.

The Fear & Greed Index _is_ a hard rule (it's a single number, well-defined): when the index is in `extreme greed` (>75), apply a small bearish bias; in `extreme fear` (<25), apply a small bullish bias (contrarian, well-supported empirically). Magnitude: ±0.3 confidence shift, never enough to flip direction.

### 6.4 Sentiment classifier — Haiku in JSON mode

**Decision: classify per-article sentiment via Claude Haiku 4.5 in JSON mode.**

```ts
// Per-article enrichment call
const result = await anthropic.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 200,
  system: `Classify the sentiment of a crypto news article. Return JSON only.
  Schema: { score: -1..+1, magnitude: 0..1, topic: string, mentionedPairs: string[] }`,
  messages: [{ role: "user", content: `Title: ${title}\n\nBody: ${body.slice(0, 2000)}` }],
});
```

Reasons over self-hosted FinBERT-style classifier:

- Zero model hosting / dependency overhead
- Updatable without redeploying (system prompt change → behavior change)
- Crypto vocab stays current (FinBERT was trained pre-2023; vocabulary lags)
- Cost: ~$0.0005/article × 50 articles/day ≈ **$0.75/month**
- Same model as ratification — consistent reasoning style

Migrate to a self-hosted classifier only if (a) news volume scales 100×, or (b) we need offline batch sentiment scoring on years of historical news.

### 6.5 Aggregation — equal-weight simple mean

**Decision: aggregate the rolling window with a simple mean of `score`.** No magnitude weighting, no recency decay in v1.

```
sentiment_4h = {
  score: mean(article.score for article in window),
  magnitude: mean(article.magnitude for article in window),
  articleCount: len(window),
  sourceCounts: { alpaca: N, coindesk: N, ... },
  computedAt: now
}
```

Trade-off accepted: one off-magnitude article can swing the window. The cleaner math + simpler invariants outweigh the precision loss for v1. Source weighting and recency decay are deferred to **Phase 8** (after attribution data exists), at which point the aggregation can be retuned without breaking the metadata schema (the `sourceCounts` field is already tracked).

### 6.6 Deduplication — embedding similarity

**Decision: dedup via embedding similarity, cosine > 0.85, within a 24h window.**

```
for each new article:
  embed(title + first 200 chars of body) → vector
  if cosine_similarity(vector, any cached vector from last 24h) > 0.85:
    mark as duplicate of the earlier article (do not score sentiment again)
  else:
    add to dedup cache (TTL 24h)
```

Provider: Bedrock **Amazon Titan Text Embeddings v2** (`amazon.titan-embed-text-v2:0`), 1024-dim, normalized. Direct foundation model invocation (no inference profile needed). Cost ~$0.0001/article × 50/day ≈ ~$0.15/mo. Authenticated via the Lambda's IAM role — no external API keys, no outbound to non-AWS endpoints.

> **Migration note (2026-05):** embedding provider migrated from OpenAI `text-embedding-3-small` (1536 dim) to Bedrock Titan v2 (1024 dim) in PR #173. The embedding cache was empty at migration time, so no historical vectors needed re-embedding. See PR #173 and issue #175 for full audit trail.

**Caveat — backtest determinism:** embedding models version (e.g. `titan-embed-text-v2` ≠ `v1` ≠ Cohere ≠ OpenAI). Backtests against historical news will produce different dedup decisions if rerun on a different embedding model version. **Mitigation:**

- Pin the embedding model version in code (e.g. `amazon.titan-embed-text-v2:0` exactly), and require a deliberate migration when bumping
- Persist the embedding model version alongside each cached vector in DDB (`{vector, model: "amazon.titan-embed-text-v2:0", articleId, expiresAt}`)
- For backtests, reuse the persisted vectors rather than re-embedding (the historical articles already have their decision baked in)

If embedding cost or determinism becomes a real problem, fall back to **title-hash dedup within a 6h window** (deterministic, cheaper, but misses paraphrases).

### 6.7 Realtime invalidation — deferred to Phase 6

**Decision: signals refresh on next TF close. No breaking-news invalidation banner in v1.**

Worst-case staleness when a major news event hits mid-bar: 7 minutes (between 15m closes). For an advisory product where users don't trade in seconds, this is acceptable.

The breaking-news invalidation mechanism (high-magnitude article → mark active signals as `invalidated`, force LLM re-ratify on next close, banner UI) lands as part of **Phase 6 (LLM ratification)**, where the infrastructure to trigger off news events naturally fits.

### 6.8 Sentiment shape at the LLM ratification layer

§7 will spell out the full prompt; here's the bundle §6 produces for it:

```ts
type SentimentBundle = {
  pair: string;
  windows: {
    "4h": { score: number; magnitude: number; articleCount: number };
    "24h": { score: number; magnitude: number; articleCount: number };
  };
  recentArticles: Array<{
    title: string; // for the LLM to read and quote
    sentiment: number; // -1..+1
    magnitude: number; // 0..1
    source: string; // "alpaca" | "coindesk" | "cointelegraph" | "decrypt"
    publishedAt: string; // ISO8601
    url: string; // for citation in reasoning string
  }>; // top 5 most recent + most magnitude-weighted, deduped, last 24h
  fearGreed: { value: number; trend24h: number };
};
```

The LLM gets aggregated numbers (windows) plus the **top 5 specific articles** so it can quote one in the reasoning string. Quoting matters for product trust: _"the Coinbase staking news at 14:12 keeps confidence below 0.6"_ is much better UX than _"sentiment-adjusted hold."_

5 articles × ~200 chars each = ~1KB of additional prompt — cheap.

### 6.9 What §6 explicitly defers

| Topic                                                   | Phase                                              |
| ------------------------------------------------------- | -------------------------------------------------- |
| Per-source weighting (Alpaca vs RSS reliability)        | Phase 8 (need attribution data)                    |
| Recency decay / magnitude weighting in aggregation      | Phase 8                                            |
| Migration off Haiku JSON mode to self-hosted classifier | Phase 9+ (only if scale or backtest needs justify) |
| Real-time news invalidation banner                      | Phase 6 (LLM ratification's natural feature)       |
| X/Twitter sentiment                                     | Post-Phase-8 (already non-goal in §2)              |

---

## 7. LLM ratification layer (Option C)

### 7.1 When to invoke

Only when **all** of:

- Algo confidence ≥ 0.6 (we don't ratify weak signals; they stay weak)
- One of the following is true:
  - There has been ≥1 article tagged for this pair in the last 30 minutes (sentiment context exists)
  - Volatility flag is set on any of the input timeframes (defer to qualitative judgment in chaos)
  - Fear & Greed has shifted by ≥10 points in 24h (regime indicator)
- Time since last LLM ratification for this pair ≥ 5 minutes (rate limit)

In typical conditions this gates ~10–20% of algo signals into LLM review. At 5 pairs × 4 timeframes (each closing at different cadences) the total LLM call volume should sit around **300–800 calls/day**, well under $10/month at Haiku pricing.

### 7.2 Prompt structure

Minimal, structured, JSON-mode. Pseudocode:

```ts
const prompt = {
  system: `You are a risk-aware market analyst for Quantara, an advisory product.
You receive a candidate trading signal produced by a deterministic algorithm.
You may DOWNGRADE the signal (lower confidence, or change to "hold") if news, sentiment,
or market context warrants caution. You MAY NOT invent a new direction.
Forbidden transformations: hold → buy, hold → sell, buy → sell, sell → buy.
Allowed transformations: buy → hold, sell → hold, lowering confidence on any type.
Output JSON only.`,

  user: {
    candidate: { type: "buy", confidence: 0.78, indicators_fired: [...] },
    perTimeframe: { "15m": {...}, "1h": {...}, "4h": {...}, "1d": {...} },
    recentNews: [
      { title: "...", sentiment: 0.6, publishedAt: "..." },
      ...
    ],
    fearGreed: { value: 28, classification: "fear", trend24h: -8 },
    pricePoints: [...] // current cross-exchange snapshot
  },

  responseSchema: z.object({
    type: z.enum(["buy", "sell", "hold"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().max(500),
    downgraded: z.boolean(),
    downgradeReason: z.string().nullable(),
  })
};
```

Validate the response server-side: if `type` violates the allowed-transformations rule, log it as a guardrail breach and use the algo signal verbatim. This enforces the "downgrade-only" contract at the code level, not just in the prompt.

### 7.3 Model choice — Sonnet 4.6 from v1

**Decision: Claude Sonnet 4.6 from day one.**

Trade-off: Haiku 4.5 (~$0.001/call) vs Sonnet 4.6 (~$0.012/call). Sonnet picked because **reasoning quality is a stated v1 goal (§1)** and the unit cost difference is small in absolute terms. The `reasoning` string is product UX; better narrative quality directly improves user trust.

**Cost envelope:**

- Per-pair daily cap (§7.5): 100/pair × 5 pairs = **500/day maximum**
- Realistic average given §7.5 gating: 300–800/day
- Sonnet 4.6: **$3.60–9.60/day average; ~$6/day at the per-pair cap ceiling**
- Monthly: **~$90–300 expected; ~$180 at hard cap**

Migrate to Haiku-only or per-slice routing only if Phase 8 attribution shows the cost is not pulling its weight on `reasoning` quality.

### 7.4 Allowed transformations — full table

| From   | To                   | Allowed? | Reason                                        |
| ------ | -------------------- | -------- | --------------------------------------------- |
| `buy`  | `hold`               | ✅       | Downgrade — bearish context cancels           |
| `buy`  | `sell`               | ❌       | Sign flip bypasses algo's deterministic rules |
| `buy`  | `buy` (lower conf)   | ✅       | Confidence reduction                          |
| `buy`  | `buy` (higher conf)  | ❌       | LLM can't be more bullish than algo           |
| `sell` | `hold`               | ✅       | Downgrade                                     |
| `sell` | `buy`                | ❌       | Sign flip                                     |
| `sell` | `sell` (lower conf)  | ✅       | Confidence reduction                          |
| `sell` | `sell` (higher conf) | ❌       | LLM can't be more bearish than algo           |
| `hold` | `buy`                | ❌       | LLM can't invent direction                    |
| `hold` | `sell`               | ❌       | Same                                          |
| `hold` | `hold` (any conf)    | ✅       |                                               |

**Confidence increases are forbidden.** Calibration consistency outweighs catching the rare confirming-news case (e.g. "BTC ETF approved" landing during an algo `buy 0.7` — LLM cannot push it to 0.9). Revisit only if Phase 8 attribution shows the algo systematically under-weights confirming news.

### 7.5 Cost gating — when NOT to invoke

Gating conditions (must satisfy all):

- Algo confidence ≥ 0.6 (don't ratify weak signals — let them stay weak)
- AT LEAST ONE OF:
  - ≥1 article tagged for this pair in the last 30 minutes (sentiment context exists)
  - Volatility flag set on any input timeframe (defer to qualitative judgment in chaos)
  - Fear & Greed shifted ≥10 points in 24h (regime indicator)

Plus rate limits:

- **Per-(pair, TF) rate limit:** max 1 ratification per `(pair, TF)` per 5 minutes
- **Per-pair daily cap:** 100 ratification calls per pair per day. Above the cap, only ratify when ALL gating conditions fire simultaneously (rare extreme cases).

Per-pair caps (rather than a global cap) chosen so a single noisy pair (e.g. DOGE during a meme storm) can't starve attention from the other four. Total system ceiling: 500/day = ~$6/day at Sonnet pricing.

### 7.6 Caching — bin-and-hash, 5-min TTL

LLM responses are not bit-deterministic, but stable UX requires "same input → same output" within a window.

```
key = hash(
  pair +
  timeframe +
  candidate.type +
  bin(candidate.confidence, 0.02) +
  bin(sentiment.score, 0.05) +
  bin(sentiment.magnitude, 0.05) +
  sentiment.articleCount +
  fearGreed.value
)
```

Bins are coarse enough that trivial state drift (confidence 0.781 vs 0.783) lands in the same bucket. Cache stored in DDB `ratification-cache` table, TTL = 5 min, matches the per-(pair, TF) rate limit.

Cache hit returns the prior response without calling the LLM (cost = $0). Cache miss calls the LLM and writes the result.

### 7.7 Server-side validation guardrail

Validate every LLM response server-side before applying. Code shape:

```ts
function validateRatification(
  candidate: TimeframeVote,
  llmResponse: { type; confidence; reasoning; downgraded; downgradeReason },
): { ok: boolean; reason?: string; ratified?: TimeframeVote } {
  // 1. Type transformation rules (§7.4 table)
  if (candidate.type === "hold" && llmResponse.type !== "hold") {
    return { ok: false, reason: "hold→non-hold not allowed" };
  }
  if (candidate.type === "buy" && llmResponse.type === "sell") {
    return { ok: false, reason: "buy→sell sign flip" };
  }
  if (candidate.type === "sell" && llmResponse.type === "buy") {
    return { ok: false, reason: "sell→buy sign flip" };
  }

  // 2. Confidence bound (no increases)
  if (llmResponse.confidence > candidate.confidence + 1e-6) {
    return { ok: false, reason: "confidence increase forbidden" };
  }

  // 3. Schema bounds
  if (llmResponse.confidence < 0 || llmResponse.confidence > 1) {
    return { ok: false, reason: "confidence out of [0, 1]" };
  }

  // 4. Reasoning sanity
  if (
    !llmResponse.reasoning ||
    llmResponse.reasoning.length < 20 ||
    llmResponse.reasoning.length > 600
  ) {
    return { ok: false, reason: "reasoning length out of bounds" };
  }

  return {
    ok: true,
    ratified: {
      ...candidate,
      type: llmResponse.type,
      confidence: llmResponse.confidence,
      reasoning: llmResponse.reasoning,
    },
  };
}
```

On validation failure: **fall back to the algo signal unchanged** and log the failure with the LLM raw response. Failures > 1% over 24h → page (prompt drift or model regression).

### 7.8 Failure modes & fallback

All map to fallback ("use algo signal verbatim"); only the log action differs.

| Failure                                     | Action                                        |
| ------------------------------------------- | --------------------------------------------- |
| LLM call times out (> 3s p99)               | Fallback. Log latency.                        |
| LLM returns invalid JSON                    | Fallback. Log raw.                            |
| LLM violates type transform (hold→buy etc.) | Fallback. Log + alert if rate > 1%/day.       |
| LLM increases confidence                    | Fallback. Log raw.                            |
| Reasoning < 20 or > 600 chars               | Fallback. Log raw.                            |
| LLM provider outage                         | Fallback. Algo signals continue to flow.      |
| Daily cap exceeded for pair                 | Skip ratification (cost gating, not failure). |

The system never depends on the LLM being up. Algo is the source of truth; LLM is an opt-in refinement.

### 7.9 Output shape — every ratification persisted

Persist every ratification call (success, failure, cache hit) to a `ratifications` DDB table, TTL 30 days. Critical for Phase 8 attribution and prompt iteration.

```ts
type RatificationRecord = {
  pair: string;
  timeframe: Timeframe;
  algoCandidate: TimeframeVote; // input
  llmRequest: { model; systemHash; userJsonHash }; // for replay
  llmRawResponse: object | null; // before validation; null on cache hit
  cacheHit: boolean;
  validation: { ok: boolean; reason?: string };
  ratified: TimeframeVote | null; // post-validation; null if fellback
  fellBackToAlgo: boolean;
  latencyMs: number;
  costUsd: number; // 0 on cache hit
  invokedReason: "news" | "vol" | "fng-shift" | "all";
  invokedAt: string;
};
```

Phase 8 reads this table to compute: ratification accuracy delta vs algo-only, cost-per-improved-signal, downgrade hit rate, model-version regression detection.

---

## 8. Whale signal integration

This section is the **consumer-side** spec — how `whale_events` produced by the system in `docs/WHALE_MONITORING.md` feed the signal engine. The producer side (Alchemy WebSocket, watchlist, classification, schema, per-asset detection thresholds) lives there.

### 8.1 Source-of-truth ownership

| Concern                                                                      | Owner                 |
| ---------------------------------------------------------------------------- | --------------------- |
| Architecture (Alchemy, Fargate `WhaleMonitor`, classifier, DDB schema)       | `WHALE_MONITORING.md` |
| Watchlist sourcing and curation                                              | `WHALE_MONITORING.md` |
| Per-asset detection thresholds (ETH 100, WBTC 5, USDT $500K, other $250K)    | `WHALE_MONITORING.md` |
| Raw signal-type taxonomy (deposit/withdrawal/stablecoin-inflow/dormant/etc.) | `WHALE_MONITORING.md` |
| Aggregation shape consumed by the signal engine (this `WhaleSummary`)        | **§8**                |
| LLM ratification prompt shape for whale context                              | **§8**                |
| When/whether whale flow becomes an algo hard rule                            | **§8**                |
| Cross-chain coverage policy and graceful degradation                         | **§8**                |

The two docs reference each other but do not contradict. Per-asset thresholds were duplicated/conflicting in earlier drafts (§8 said `>$1M`, WHALE_MONITORING.md had per-asset values). **Per-asset thresholds in WHALE_MONITORING.md are authoritative.**

### 8.2 Cross-chain coverage — v1 = ETH / Polygon only

`WHALE_MONITORING.md` targets ETH + Polygon via Alchemy. Coverage map for our 5 tracked pairs:

| Pair      | Native chain | v1 whale coverage                                                        |
| --------- | ------------ | ------------------------------------------------------------------------ |
| BTC/USDT  | Bitcoin      | **Partial** — WBTC on ETH only (~5% of BTC supply moves through wrapped) |
| ETH/USDT  | Ethereum     | **Full**                                                                 |
| SOL/USDT  | Solana       | **None** — Solana not monitored in v1                                    |
| XRP/USDT  | XRPL         | **None**                                                                 |
| DOGE/USDT | Dogecoin     | **None**                                                                 |

For SOL / XRP / DOGE, the LLM ratification prompt receives an explicit "whale data unavailable for this pair" marker (rather than `null` that the LLM might silently misinterpret). Reasoning strings for those pairs cannot speculate about whale flow.

**Phase 9 candidate:** add Solana RPC monitoring (QuickNode/Alchemy Solana free tier) to cover SOL/USDT. Trigger: ETH whale signals show measurable predictive value in Phase 8 attribution.

### 8.3 Aggregation — `WhaleSummary` per pair

The signal engine reads aggregated `WhaleSummary` objects, not raw `whale_events`. Aggregator runs whenever a new whale event lands for a tracked pair, refreshing the relevant pair's summary in DDB.

```ts
type WhaleSummary = {
  pair: string;
  coverage: "full" | "partial" | "none"; // per §8.2 coverage map
  windows: {
    "1h": WhaleWindow;
    "4h": WhaleWindow;
    "24h": WhaleWindow;
  };
  recentEvents: Array<{
    txHash: string;
    valueUsd: number;
    signalType:
      | "exchange_deposit"
      | "exchange_withdrawal"
      | "stablecoin_inflow"
      | "large_transfer"
      | "dormant_activation";
    direction: "bullish" | "bearish" | "neutral";
    fromLabel: string | null; // e.g. "binance", "jump_trading", "dormant_2y"
    toLabel: string | null;
    timestamp: string;
  }>; // top 5 by valueUsd within last 24h, deduped by txHash
  computedAt: string;
};

type WhaleWindow = {
  netFlowUsd: number; // bullish-positive: outflows − inflows
  exchangeInflowUsd: number;
  exchangeOutflowUsd: number;
  eventCount: number;
  bullishEventCount: number;
  bearishEventCount: number;
  dormantActivations: number;
  correlatedMoves: number; // ≥3 whales same direction in 30min
};
```

Stored in DDB `whale_summaries` table, key `pair`, TTL 24h (recompute on every whale event). Same row pattern as `sentiment` aggregates from §6.

### 8.4 LLM ratification consumption — what the prompt sees

The §7 ratification prompt receives:

```ts
whaleSummary: {
  ...WhaleSummary,
  staleness: "fresh" | "stale" | "unavailable"
}
```

- `fresh`: `computedAt` < 5 min ago
- `stale`: `computedAt` between 5 min and 1h ago
- `unavailable`: no `WhaleSummary` exists for this pair, or `coverage === "none"`

The LLM is instructed to:

- Ignore whale flow when `coverage === "none"` (no speculation)
- Note staleness in `reasoning` if `staleness !== "fresh"` ("whale flow data is stale by 18 minutes")
- Quote a specific event from `recentEvents` when one is materially relevant ("100 ETH moved from a dormant 2-year wallet to Coinbase 12 minutes ago")

### 8.5 Algo path: whale flow stays out (v1)

Same backtestability rationale as sentiment (§6): whale data does not enter the algo's deterministic rule confluence in v1. It enters only the LLM ratification step.

This preserves:

- Backtestability — algo signals reproducible from candles alone
- Attribution clarity — whale-derived value can be measured separately by toggling LLM ratification on/off in offline replays
- Compliance defensibility — "the algorithm fired on RSI + MACD; the LLM downgraded based on whale flow context"

### 8.6 Hard-rule promotion — Phase 8+ criteria

A whale-derived hard rule earns its slot in the algo only when, over **≥30 resolved signals per `(pair, TF)`** (per §10's outcome tracking):

- Adding the rule increases directional accuracy by ≥3 percentage points, AND
- Incremental contribution > 0 (the signal isn't already captured by an existing rule's correlation with whale flow)

Concrete candidate hard rules to evaluate post-Phase-8:

| Candidate                      | Condition                                                   | Effect                                       |
| ------------------------------ | ----------------------------------------------------------- | -------------------------------------------- |
| `whale-net-inflow-extreme`     | `exchangeInflowUsd / 24h_average > 5`                       | Force `hold` (overrides bullish algo signal) |
| `whale-net-outflow-confirming` | `exchangeOutflowUsd > $5M in 4h` AND algo signal is bullish | +0.4 strength bullish (confluence boost)     |
| `whale-dormant-activation`     | dormant wallet activation in last 1h                        | Force `hold` (uncertainty pre-news)          |

None of these ship in v1. Track the data; let attribution decide.

### 8.7 Graceful degradation — whale monitor unavailability

When the whale monitor is unavailable (Alchemy outage, Fargate restart, Etherscan rate-limited):

- `WhaleSummary.computedAt` ages past the 5-min freshness threshold → `staleness` flips to `stale`, then `unavailable`
- LLM ratification continues with stale-tagged data, falling back to "no whale context" if the data is too old to be informative
- **Algo path is unaffected.** Algo signals continue to flow regardless of whale monitor state.

This matches the LLM/sentiment pattern: advisory inputs gracefully degrade; the algo is the source of truth.

### 8.8 Privacy / compliance

- Don't store user wallet addresses (we have no on-chain user identity to begin with)
- Don't surface specific wallet addresses in user-facing reasoning strings — use labels (e.g. _"a known Coinbase wallet"_) rather than `0xabc...`
- Don't republish the watchlist externally (it's a derivative work of public attribution sources; safer to keep internal)
- Internal storage of wallet addresses with labels is fine — only the user-facing reasoning string is sanitized

### 8.9 What §8 explicitly defers

| Topic                                             | Phase                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| SOL / XRP / DOGE whale monitoring                 | Phase 9 (Solana first if ETH proves predictive)                                |
| Native BTC node monitoring (vs WBTC proxy)        | Phase 9+                                                                       |
| Hard-rule promotion of any whale signal           | Phase 8 attribution (≥30 resolved signals)                                     |
| Multi-chain DEX swap detection (vs CEX-flow only) | Phase 10+                                                                      |
| Real-time correlated-whale-move detection         | Phase 9 (correlated-moves field exists in summary; detector lives in producer) |

---

## 9. Risk management

Risk recommendations are emitted **alongside** each non-`hold` signal. They are advisory and parameterized by the user's per-pair risk profile.

### 9.1 Account size — percentage-only output

**Decision: outputs are `%` of the user's account; user does dollar conversion.** Quantara does not store account balances or integrate with exchange APIs in v1. Reasons:

- Simplest path; no PII or balance storage
- Most defensible for compliance ("not financial advice — based on user-supplied risk preferences")
- Avoids the security/key-management burden of exchange API integration
- "Advisory not executor" line stays bright

User-supplied account balance (with `%` + `$` displayed side-by-side) lands in a future UI iteration if survey data shows users want $ amounts. Exchange API integration is **explicitly never** — defeats the advisory-only product line.

### 9.2 Risk profile — per-pair, defaulted by tier

**Decision: per-pair risk profile.** A user can mark BTC as `conservative` and DOGE as `aggressive` independently. Defaults derive from tier:

- Free tier → `conservative` for all pairs
- Paid tier → `moderate` for all pairs
- User overrides per pair in settings

Stored on the user record as a map: `riskProfiles: Record<TradingPair, "conservative" | "moderate" | "aggressive">`.

Per-pair (rather than single global) because crypto pairs behave very differently — a user happy taking 3× ATR stops on DOGE may want 1.5× ATR on BTC. The cost is one extra onboarding step (per-pair sliders) and a slightly larger user record. Math at recommendation time is unchanged — just key by `(user.riskProfiles[pair])` instead of `user.riskProfile`.

### 9.3 Position sizing — three models

| Model                   | Formula                                                         | Default for                                                     |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| **Fixed-fractional**    | `sizePct = risk_pct[profile]` (e.g. 0.5% / 1% / 2% per profile) | Conservative profile, all users; everyone pre-Kelly-unlock      |
| **Volatility-targeted** | `sizePct = risk_pct[profile] / (ATR_pct · multiplier)`          | Moderate / aggressive profiles where ATR makes raw-pct unstable |
| **Kelly-fractional**    | `sizePct = 0.25 · kelly_f`, where `kelly_f = (p·b − q) / b`     | Aggressive profile (only) once Kelly unlock conditions met      |

Per-profile risk-pct defaults:

- Conservative: 0.5% per trade
- Moderate: 1.0% per trade
- Aggressive: 2.0% per trade

#### 9.3.1 Kelly unlock — bounded plausible regime

Kelly only unlocks for a `(pair, timeframe)` slice when **all** of:

- `n ≥ 50` resolved signals for that slice
- `p ∈ [0.45, 0.65]` (sane accuracy band — outside this, the slice is mis-classified or the rule library mis-fires)
- `b ∈ [0.5, 3.0]` (sane win/loss-ratio band — outside this, the resolution math is suspect)

If unlock conditions aren't met (or any check falls out later), fall back to vol-targeted (or fixed-fractional for conservative profile). Slices unlock independently — BTC/USDT 1d may unlock months before SOL/USDT 15m does.

**Always cap at 25% Kelly.** Real-world Kelly is brutal because real `p` is overestimated and real losses cluster. The cap is non-negotiable.

### 9.4 Stop-loss — ATR-based, profile-multiplied

```
stop_distance = ATR(14, signal_timeframe) · stop_multiplier[profile]
buy_stop  = entry_price − stop_distance
sell_stop = entry_price + stop_distance
```

`stop_multiplier` per profile:

- Conservative: 1.5× ATR
- Moderate: 2.0× ATR
- Aggressive: 3.0× ATR

ATR-based stops adapt to the current volatility regime — wider in chaos, tighter in calm. Avoid percentage stops (e.g. "5% below entry"); they're vol-blind.

### 9.5 Take-profit — per-profile R-multiples (asymmetric for crypto)

R = stop distance in price units. Profile-specific TP targets, capturing crypto's fat-tail asymmetry:

| Profile      | TP1 (50% close) | TP2 (25% close) | TP3 (25% close, trailing) |
| ------------ | --------------- | --------------- | ------------------------- |
| Conservative | 1R              | 2R              | 3R                        |
| Moderate     | 1R              | 2R              | **5R**                    |
| Aggressive   | 1R              | 3R              | **8R**                    |

Conservative books profits early (canonical asymmetric-payoff structure). Moderate and aggressive let the runner stretch further to capture extended crypto trends. The 50/25/25 close percentages stay constant across profiles — only the R-multiples change.

#### 9.5.1 Trailing stop on TP3

Once TP1 and TP2 close, the remaining 25% trails:

```
trailing_stop = current_price − 2 · ATR(signal_timeframe)
```

Updated on every blender run for the pair (which the user knows happens on TF close). Adapts to volatility; uses indicators we already compute; no new infrastructure.

### 9.6 Existing-position guidance during gates

When a vol / dispersion / stale gate fires for a pair, **new signals force `hold`** (already locked in §4.6). For users with **existing** open positions on that pair, surface a **generic banner**:

| Gate reason  | Banner copy                                                         |
| ------------ | ------------------------------------------------------------------- |
| `vol`        | "BTC volatility elevated — monitor your positions."                 |
| `dispersion` | "BTC price disagreement across exchanges — monitor your positions." |
| `stale`      | "BTC exchange data unavailable — monitor your positions."           |

No per-position advice (we don't track positions). The banner sits on the pair's signal card; UI work is downstream.

### 9.7 Multi-position aggregation — per-signal sizing + concurrent warning

Each signal's recommended `sizePct` is **per-signal** — assumes the user isn't already taking other concurrent signals. The 7% weekly drawdown cap (§9.8) is the global guardrail.

**UI affordance:** when ≥2 active buy/sell signals exist for the user, surface aggregated risk: _"You'd be at 3% concurrent risk if you took all three signals."_ The user reconciles. Quantara doesn't track real positions, only the signals it has issued.

### 9.8 Drawdown limits

Per-profile defaults (overridable in user settings):

| Profile      | Daily cap | Weekly cap | Per-pair concurrent cap |
| ------------ | --------- | ---------- | ----------------------- |
| Conservative | 2%        | 5%         | 1                       |
| Moderate     | 3%        | 7%         | 1                       |
| Aggressive   | 5%        | 12%        | 2                       |

Once the daily cap is breached, the API suppresses all new non-`hold` signals (returns the latest signal but with a banner state) for the rest of the trading day (UTC). Weekly cap suppresses for the rest of the week.

These are **suggestions the UI surfaces** — not enforcement. Quantara has no execution capability and never will.

### 9.9 Schema additions

Extend the `Signal` (or rather, the persisted `BlendedSignal`) type:

```ts
export interface RiskRecommendation {
  pair: string; // for cross-ref
  profile: "conservative" | "moderate" | "aggressive"; // looked up from user.riskProfiles[pair]
  positionSizePct: number; // % of account
  positionSizeModel: "fixed" | "vol-targeted" | "kelly";
  stopLoss: number; // price
  stopDistanceR: number; // ATR × multiplier
  takeProfit: { price: number; closePct: number; rMultiple: number }[];
  invalidationCondition: string; // human-readable, mobile UX
  trailingStopAfterTP2: { multiplier: number; reference: "ATR" };
}

export interface Signal {
  // ...existing BlendedSignal fields
  risk: RiskRecommendation | null; // null when type === "hold"
}

export type RiskProfileMap = Record<TradingPair, "conservative" | "moderate" | "aggressive">;

// On the user record:
export interface User {
  // ...existing fields
  riskProfiles: RiskProfileMap; // per-pair; default by tier
  drawdownState: {
    dailyPnLPct: number; // tracked from signals user marked as "took it"
    weeklyPnLPct: number;
    suppressUntil: string | null; // ISO8601 if in drawdown lockout
  };
}
```

Note: `drawdownState` requires the user to mark which signals they actually took (a future UI). Until that exists, drawdown caps are pure UI affordance — Quantara can't enforce because we don't observe positions.

### 9.10 What §9 explicitly defers

| Topic                                               | Phase                                    |
| --------------------------------------------------- | ---------------------------------------- |
| User-self-reported account balance ($ display)      | Phase 9+ UI work                         |
| Exchange API integration (live balance)             | Never (compliance)                       |
| Position management agent (closing existing trades) | Out of scope                             |
| Drawdown enforcement based on actual trade outcomes | Phase 9+ once "marked-as-taken" UI ships |
| Per-rule risk weighting                             | Phase 8 attribution                      |

---

## 10. Signal lifecycle & outcome scoring

### 10.1 States

```
emit  →  active  →  expired  →  resolved
  ↓        ↓          ↓
[stored] [shown]  [resolved with outcome]
```

- **emit:** signal is computed and persisted to DDB.
- **active:** between `createdAt` and `expiresAt`. Shown in the UI.
- **expired:** past `expiresAt`. No longer surfaced as "current."
- **resolved:** at `expiresAt`, the outcome is computed by comparing `priceAtSignal` to the price at `expiresAt`.

Plus an **invalidated** state (per §6.7): a fresh high-magnitude article can mark an active signal as `invalidatedAt: <ISO8601>`. Invalidated signals are **not resolved** — see §10.4.

### 10.2 Expiry windows — crypto-tuned (8× source TF)

| Source timeframe | Expiry window |
| ---------------- | ------------- |
| 15m              | 2 hours       |
| 1h               | 8 hours       |
| 4h               | 1 day         |
| 1d               | 3 days        |

For multi-horizon blended signals, use the `1d` window (longest source horizon, here 3 days).

Crypto moves faster than equities; shorter windows give faster Phase 8 attribution data accumulation and faster signal invalidation when the regime shifts. Trade-off: slightly more `pending` signals on slow days. Acceptable.

### 10.3 Outcome rule — `hold` is now scored against move magnitude

```
priceMove = (priceAtResolution − priceAtSignal) / priceAtSignal
threshold = 0.5 · ATR_pct                      # half-ATR = "meaningful"

if signal.gateReason !== null:                  # gate-driven hold: unscored
    outcome = "neutral"

elif signal.type == "hold":                     # strategic hold: scored
    if abs(priceMove) < threshold:              outcome = "correct"     # market stayed quiet
    elif abs(priceMove) > 2 · threshold:        outcome = "incorrect"   # missed a move
    else:                                       outcome = "neutral"

elif signal.type == "buy":
    if priceMove > +threshold:                  outcome = "correct"
    elif priceMove < −threshold:                outcome = "incorrect"
    else:                                       outcome = "neutral"

elif signal.type == "sell":
    if priceMove < −threshold:                  outcome = "correct"
    elif priceMove > +threshold:                outcome = "incorrect"
    else:                                       outcome = "neutral"
```

**Why `hold` is now scored:** without it, ~50%+ of resolved signals contribute nothing to calibration. Strategic holds that correctly anticipated a quiet market are real predictions and should be tracked. Gate-driven holds (vol/dispersion/stale) remain unscored — they're observations of conditions, not directional predictions.

ATR-relative thresholding stays — a "meaningful move" in DOGE is wildly different from BTC. Flat-% cutoff would over-credit volatile pairs.

### 10.4 Invalidated signals — survivorship

Invalidated signals (§6.7) **skip resolution entirely.** Excluded from accuracy stats and Brier/ECE calculations. Tracked separately as a count surfaced alongside the accuracy badges:

```
"73% directional accuracy on BTC over 30 days"
"12 signals invalidated by breaking news in the same window"
```

Including invalidated signals in accuracy would distort the metric — they were declared invalid before their natural resolution.

### 10.5 Per-rule attribution — granularity `(rule, pair, TF)`

Each signal carries `rulesFired: string[]`. Outcome data feeds into a per-bucket attribution table:

```
attribution[rule][pair][TF] = {
  correct:   <count>
  incorrect: <count>
  neutral:   <count>
  pending:   <count>
  brier:     <metric>           // computed when ≥30 resolved
  lastUpdated: ISO8601
}
```

14 rules × 5 pairs × 4 TFs = **280 buckets**. Granular enough to catch pair-specific rule misfires (e.g. _"`bollinger-touch-lower` works on BTC but not DOGE"_) without thinning samples beyond usefulness.

**Not split by `type` (buy/sell/hold)** — a rule's contribution is direction-agnostic; splitting would 3× the buckets and overfit.

### 10.6 Calibration measurement — Brier + ECE, K=10

Per §1, calibration is an explicit goal. Two metrics:

```
Brier(predictions) = mean((confidence_i − outcome_i)²)
   where outcome_i = 1 if "correct", 0 if "incorrect", neutral excluded

ECE(predictions, K=10):
   bins = [0,0.1), [0.1,0.2), ..., [0.9,1.0]
   for each bin: |mean(confidence in bin) − accuracy in bin|
   ECE = count-weighted mean across bins
```

Computed per `(pair, TF)` over a rolling 90-day window. Surfaced on a calibration dashboard:

- Brier < 0.25 = "decent" for advisory products
- Brier < 0.20 = good
- ECE < 0.05 = well-calibrated

Phase 8 fits per-(pair, TF) Platt scaling (`confidence_calibrated = sigmoid(a · raw_confidence + b)`) when ECE is poor and `n ≥ 50`.

### 10.7 Rolling accuracy windows

| Window  | Use                                               |
| ------- | ------------------------------------------------- |
| 7d      | Weekly recap; marketing                           |
| **30d** | **Primary user-facing badge**                     |
| 90d     | Calibration cycle / Platt scaling refresh trigger |

Compute on every resolved-signal event; cache aggregated results in DDB for cheap reads. 24h is too noisy; all-time risks misrepresenting current performance.

### 10.8 PnL counterfactual — explicitly excluded

We do **not** compute hypothetical PnL ("if user had taken this signal at recommended size, they would have made $X"). Reasons:

- "Profitable" framing is regulated speech in many jurisdictions; "directional accuracy" is observational
- PnL math compounds errors — slippage, fees, exact entry/exit timing all matter for real trades
- Users will compare claimed PnL to their own real PnL and discover the gap; trust collapses
- Hindsight bias dressed as forecasting

Marketing-friendly substitute when a $-flavored stat is needed: _"across 90 days, the signal direction matched price movement 73% of the time. Average move size at resolution: 1.2× ATR."_ Numerical, observational, no hindsight PnL.

### 10.9 Backtest harness contract (Phase 8)

§10 doesn't build the backtest harness, but does lock the data contract Phase 8 will replay:

- Every signal persisted with full state at emit time (algo candidate, indicators state hash, sentiment bundle hash, ratification record reference)
- `priceAtSignal` captured at emit time (median across non-stale exchanges, per §2)
- Outcomes computed at expiry, persisted as **immutable records**
- No mutation of historical signals — rule changes don't retroactively re-score

These guarantees flow into the §11 storage schema.

### 10.10 What §10 explicitly defers

| Topic                                                     | Phase        |
| --------------------------------------------------------- | ------------ |
| Backtest harness implementation                           | Phase 8      |
| Platt scaling fit + per-(pair, TF) confidence calibration | Phase 8      |
| Auto-disable / prune of rules with sustained low accuracy | Phase 8      |
| User-observed PnL ("I took this trade and made/lost X")   | Phase 9+ UI  |
| Real-time accuracy push notifications                     | Out of scope |

---

## 11. Storage schema

Three new DDB tables (signals, signal-outcomes, close-quorum), one intermediate compute table (signals-v2), and two extensions to existing tables.

### 11.1 New: `quantara-{env}-signals`

```
PK: pair (e.g. "BTC/USDT")
SK: timestamp#signalId  (ISO8601 + ULID)
Attributes:
  type: "buy" | "sell" | "hold"
  confidence: number
  reasoning: string
  evidence: {            // structured for replay/debug
    perTimeframe: { "15m": {...}, "1h": {...}, "4h": {...}, "1d": {...} },
    blendedScalar: number,
    rulesFired: string[],
    volatilityFlag: boolean,
  }
  risk: RiskRecommendation | null
  exchangeData: ExchangePricePoint[]
  llmRatified: boolean
  llmDowngradeReason: string | null
  createdAt: ISO8601
  expiresAt: ISO8601
  ttl: number  // 90d
GSI:
  by-pair-active: pair (PK) + expiresAt (SK)  — for "current signals" queries
```

### 11.2 New: `quantara-{env}-signal-outcomes`

```
PK: pair
SK: signalId
Attributes:
  type, confidence, createdAt, resolvedAt
  priceAtSignal, priceAtResolution, priceMovePct
  atrAtSignal: number
  outcome: "correct" | "incorrect" | "neutral" | "pending"
  rulesFired: string[]   // for per-rule attribution
GSI:
  by-pair-time: pair + createdAt  — for accuracy windows
  by-rule: rule (denormalized) + createdAt  — for rule-level performance
```

### 11.3 Extension to `news-events`

Add enrichment fields the engine depends on:

```
mentionedPairs: string[]   // ["BTC", "ETH"]
sentiment: { score: -1..+1, magnitude: 0..1, model: "..." }
```

Backfill once with the enrichment Lambda over the existing 30-day window.

### 11.4 Extension to `ingestion-metadata`

Cache aggregated sentiment so the engine doesn't recompute on every signal:

```
metaKey: "sentiment:BTC:4h"
value: { avgScore, totalMagnitude, articleCount, computedAt }
ttl: 600  // 10 min
```

### 11.5 New: `quantara-{env}-close-quorum` (DDB Streams + event-driven trigger)

> **v5 design. See §5.9 for the full event-driven trigger flow.**
>
> **v4 fixes retained:** Fix #1 (drop claimedBy), Fix #3 (TTL epoch seconds), Fix #5-v4 (close-quorum-monitor Lambda).
>
> **v5 fixes (this doc). Traced to codex review of PR #125 (comment #4409943828):**
>
> - **Fix #1 (P1):** Drop `processed-close-store` from schema — see §5.9 for rationale. `signals-v2` is now the sole dedup source.
> - **Fix #4 (P2):** `close-quorum` stream must be `NEW_AND_OLD_IMAGES` (not `NEW_IMAGE`) so the `close-quorum-monitor` Lambda can read the deleted item's attributes on TTL REMOVE events.

This table is the coordination point for the collect-then-compute flow (§5.9). It is written to by the candle-stream Lambda and read by the same Lambda to check quorum.

**Schema:**

```
PK: pair#timeframe#closeTime  (e.g. "BTC/USDT#1h#1746576000000")
Attributes:
  exchanges: String Set   // set of exchange names that have written for this slot
                          // populated via DDB ADD (atomic, idempotent on retry)
  ttl: number             // epoch SECONDS — closeTimeMs / 1000 + 86_400
                          // NOTE: NOT milliseconds — see TTL conversion in §5.9
```

**No `claimedBy`, `claimedAt`, or `processedAt` fields.** v5 dropped all per-row processing markers; v6 makes the `signals-v2` key deterministic. `signals-v2` is the dedup source (see §5.9 Fix #1-v6; §11.6 for schema). See §5.9 for crash-recovery semantics.

**No `processed-close-store` table (Fix #1-v5 retained).** The separate marker table introduced in earlier drafts is eliminated. `signals-v2` conditional Put on the deterministic PK+SK is the sole dedup mechanism.

**DDB Streams (Fix #4 v5):** enable DDB Streams on this table with `StreamViewType: NEW_AND_OLD_IMAGES`.

Why `NEW_AND_OLD_IMAGES` and not `NEW_IMAGE` (Fix #4 v5): DDB TTL deletion emits a `REMOVE` stream event. With `NEW_IMAGE`, the REMOVE record has no attributes — the item's data is not included. The `close-quorum-monitor` Lambda cannot inspect the deleted row at all. With `NEW_AND_OLD_IMAGES`, the OldImage is present on REMOVE events, giving the monitor access to `pair`, `timeframe`, `closeTime`, and `exchanges` from the expired row. This is required for the monitor to look up `signals-v2` and distinguish missed closes from normally-processed ones.

The event source mapping on the indicator handler Lambda reads from the **candle table** stream, not this table's stream. This table's stream is used only by the `close-quorum-monitor` Lambda (see below).

**Observability — `close-quorum-monitor` Lambda (Fix #5-v4 retained, updated for v5 dedup):**

> **Chosen: Option A — enable streams on close-quorum, subscribe a monitor Lambda.**

When a `close-quorum` row expires via DynamoDB TTL, the TTL deletion emits a `REMOVE` event on the `close-quorum` stream (now carrying OldImage per Fix #4 v5). A dedicated `close-quorum-monitor` Lambda subscribed to this stream with `eventName = REMOVE` filter:

1. Reads `OldImage` from the stream record to extract `pair`, `timeframe`, and `closeTime`
2. Reads `signals-v2` with `PK = pair`, `SK = closeTime#tf` (deterministic key — Fix #1-v6)
3. If absent → the slot was never processed → emits a `CloseMissed` CloudWatch metric: `{ pair, timeframe, closeTime }` and logs for debugging
4. If present → the slot was processed before TTL hit → no-op (normal case)

FilterCriteria for the monitor Lambda:

```json
{
  "Filters": [
    {
      "Pattern": "{ \"eventName\": [\"REMOVE\"] }"
    }
  ]
}
```

The monitor Lambda is a small, single-purpose function (~30 lines). It does not retry or re-trigger signal computation — missed closes are surfaced as an alarm signal, not auto-repaired. The downstream alarm in §15 ("lack-of-signal for pair/TF > N minutes") is the recovery indicator.

**Alternative options considered and rejected:**

| Option                    | Why rejected                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **B — Scheduled scanner** | Scans for stale rows every 5 min — lossy (misses closes that expired between scans), adds a DDB scan on a table with no GSI-by-age |
| **C — Drop the metric**   | Unacceptable for debugging "why no signal?"; the missed-close case is exactly the failure mode Fix #1 was designed to prevent      |

### 11.6 New: `quantara-{env}-signals-v2` (indicator handler compute + dedup table)

> **v6 design (Fix #1-v6).** Supersedes the v5 schema in which `signalKey` was a non-key attribute and `SK` was a random `signalId`. Deterministic PK/SK makes the conditional Put the true dedup.

This is the compute-layer table written by the `IndicatorLambda` collect-then-compute flow (§5.9). It holds one row per `(pair, timeframe, closeTime)` slot. It is **not** the user-facing signals table (that is `quantara-{env}-signals` in §11.1, which holds blended, LLM-ratified signals).

**Schema:**

```
PK: pair             (e.g. "BTC/USDT")
SK: closeTime#tf     (e.g. "1715187600000#15m"  — deterministic from inputs)
Attributes:
  type: "buy" | "sell" | "hold"
  confidence: number
  perTimeframe: { "15m": {...}, "1h": {...}, "4h": {...}, "1d": {...} }
  weightsUsed: { "15m": number, "1h": number, "4h": number, "1d": number }
  rulesFired: string[]
  volatilityFlag: boolean
  gateReason: "vol" | "dispersion" | "stale" | null
  exchanges: string[]      // exchanges that contributed to quorum
  computedAt: ISO8601
  ttl: number              // epoch SECONDS — closeTimeMs / 1000 + (7 * 86_400)  (7-day TTL)
DDB Streams: NEW_IMAGE  // fanout Lambda reads new signals (§16.5)
```

**Dedup guarantee (Fix #1-v6):** `PK = pair` + `SK = closeTime#tf` is fully deterministic. The conditional Put in Step 4 uses `attribute_not_exists(pair)`, which checks that this PK+SK combination does not yet exist. Two concurrent handlers targeting the same slot attempt a Put on the same item; DynamoDB serializes concurrent writes on the same key — only the first succeeds.

**Range queries:** `closeTime` is the leading component of the SK, so a Query with `SK between "T_start#" and "T_end~"` efficiently returns all signals for a pair in a time window. "Latest signal for pair X on timeframe 15m" is `Query(PK=pair, SK begins_with "")` with `Limit=1, ScanIndexForward=false` (most recent first), filtered to `closeTime#tf` entries.

**No `signalKey` attribute.** v5's `signalKey = pair#tf#closeTime` non-key attribute is removed. The PK+SK combination carries the same information with DynamoDB's native conditional-Put semantics.

---

## 12. Compute architecture

> **v5 update (codex finding Fix #3 P2 / PR #125 comment #4409943828):** §12.1 and §12.3 updated to reflect DDB-Streams-driven `IndicatorLambda` (supersedes the EventBridge-scheduled trigger described in earlier drafts). EventBridge cron retained only for the higher-TF candle poller and the outcome-tracker Lambda.

### 12.1 Where indicators run

Two viable shapes:

**Shape A — In-process on the Fargate streamer.**
Pros: indicators stay hot in memory, microsecond recomputation on every candle close. Keeps state.
Cons: stateful service is harder to scale horizontally; restart loses warm-up window.

**Shape B — DDB-Streams-driven Lambda + DDB-derived state (chosen).**
Pros: stateless, easy to scale, easy to replay against historical candles for backtests. Triggered directly by candle writes — no schedule drift.
Cons: pays DDB read cost on every run; indicators have to be re-derived from candles each invocation.

**Decision: Shape B.** `IndicatorLambda` is triggered by **DDB Streams on the `quantara-{env}-candles` table** (see §5.9 for the full event source mapping and FilterCriteria). On each filtered stream event, the handler runs the collect-then-compute flow (§5.9) and caches indicator values into a `quantara-{env}-indicator-state` table. The next signal computation reads cached state + the most recent candle and recomputes only the deltas.

Why: backtestability. We need to be able to point the indicator engine at historical candles and reproduce the exact signals that would have fired. A stateful Fargate process makes that arduous. DDB-Streams trigger also eliminates schedule drift — the Lambda fires exactly when a candle is written, not on a fixed cron interval.

**Deprecated (Fix #3 v5): EventBridge-scheduled IndicatorLambda.** Earlier drafts of §12.3 described an EventBridge cron rule triggering the IndicatorLambda every minute (checking `now() % timeframe == 0`). This design is **deprecated and must not be deployed**. Deploying both the scheduled trigger and the DDB-Streams trigger would cause the same slot to be processed twice — the streams-based handler would compute and write the signal, and the cron-based handler would re-enter the flow for the same closeTime. The signals-v2 dedup (§5.9 Step 3–4) prevents duplicate writes, but the wasted compute and duplicate quorum-ADD calls are unnecessary and confusing.

### 12.2 Latency budget

| Step                                          | Target           | Notes                                        |
| --------------------------------------------- | ---------------- | -------------------------------------------- |
| Candle close → indicator state updated        | < 5s             | Lambda cold start is the cap                 |
| Indicators → algo signal                      | < 50ms           | Pure CPU                                     |
| Algo signal → LLM ratification (when invoked) | < 3s             | Haiku is sub-second typically; budget 3s p99 |
| Signal → user-visible                         | < 30s end-to-end | Backend caches and pushes to web             |

### 12.3 EventBridge schedules (non-indicator)

EventBridge cron is **not** used to trigger the IndicatorLambda (see §12.1 deprecation note). EventBridge is retained for two other purposes:

- **Higher-TF candle poller** — EventBridge → Lambda calls `fetchOHLCV(pair, timeframe)` on each close boundary for all three exchanges. `cron(* * * * ? *)` with a `now() % timeframe == 0` check per TF. See §2 data-quality gap #1.
- **Outcome-tracker Lambda** — EventBridge → Lambda that checks resolved signals against actual price outcomes. Triggered on a per-outcome-window schedule (15m, 1h, 4h, 1d offsets from signal emission). See Phase 8.

Avoids deploying per-TF schedules for the poller; single Lambda decides what to do based on the current minute.

---

## 13. Implementation roadmap

Eight phases. Each phase shippable on its own — no big-bang merge. Each is sized to fit one agent-ready issue.

### Phase 1 — Indicator engine (offline-equivalent)

Files: `ingestion/src/indicators/{ema,macd,rsi,atr,bollinger,obv,vwap}.ts` + tests.
Acceptance: given a fixture of 200 candles, every indicator output matches a TradingView-equivalent reference (tolerance: ±0.01%).

### Phase 2 — Per-timeframe scoring

Files: `ingestion/src/signals/score.ts`, `packages/shared/src/constants/signals.ts` (add rule definitions).
Acceptance: deterministic mapping from indicator state → `{type, confidence, rulesFired}`. Replay test on a known historical setup yields expected output.

### Phase 3 — Multi-horizon blending

Files: `ingestion/src/signals/blend.ts`.
Acceptance: weighted blending matches §5.3 formula; agreement/disagreement tests pass.

### Phase 4 — Indicator Lambda + DDB schema

Files: `ingestion/src/indicator-handler.ts`, terraform additions for `signals` and `indicator-state` tables.
Trigger: DDB Streams on `quantara-{env}-candles` table (event source mapping per §5.9 FilterCriteria) — **not** an EventBridge schedule. See §12.1 for the deprecation of the EventBridge-scheduled IndicatorLambda design.
Acceptance: real candles → collect-then-compute flow (§5.9) → cached indicator state → algo signal persisted to `signals-v2`.

### Phase 5 — News pair-tagging + sentiment aggregation

Files: extend `ingestion/src/news/enrich.ts` (or wherever the enrichment lives), add `mentionedPairs` and `sentiment` to the schema.
Acceptance: backfilled news has pair tags; `sentiment:{pair}:4h` metadata is updated by a scheduled job.

### Phase 6 — LLM ratification

Files: `backend/src/lib/genie/ratify.ts` (or `ingestion`-side, depending on where signal emission lands).
Acceptance: when gates fire, the LLM is called; downgrade-only contract is enforced server-side; failures fall back to algo signal.

### Phase 7 — Risk management module

Files: `ingestion/src/signals/risk.ts`, schema extension to `Signal.risk`.
Acceptance: every non-hold signal carries position-size, stop, TP recommendations consistent with the user's tier.

### Phase 8 — Outcome tracking + accuracy badges

Files: `ingestion/src/signals/resolve.ts` (Lambda triggered by signal expiry), backend `/genie/history` actually returns data instead of `[]`.
Acceptance: signals emitted in Phase 4 are scored at expiry; rolling accuracy is computable per pair / timeframe / rule.

### Future phases (post-MVP)

- **Phase 9:** Whale-flow integration into the LLM ratification context.
- **Phase 10:** Per-user risk profile customization (currently global defaults).
- **Phase 11:** Backtest harness — replay any historical window and produce a signal stream.
- **Phase 12:** Auto-tuning of rule weights from outcome attribution.

---

## 14. Open questions

1. **Source of truth for "the price" across exchanges.** Median works but is rough. Volume-weighted across the three exchanges is better — but requires per-exchange volume normalization. Decide before Phase 1.
2. **Tier gating.** Should free-tier users get all timeframes, or only `1d`? Affects compute cost and conversion strategy.
3. **Push vs pull for the user-facing signal stream.** WebSocket from backend is the right answer long-term, but the current backend is Lambda-on-API-Gateway — no native WS. May need to plumb AppSync or accept polling for v1.
4. **News provider expansion.** CoinTelegraph + Decrypt + CoinDesk + Alpaca cover headlines but miss CT/X — which is where most crypto narrative actually breaks. Do we add a Twitter source?
5. **Whale wallet list.** `WHALE_MONITORING.md` references a tracked-wallet set. Who curates it? How often does it rotate? Plug into Phase 9.
6. **Compliance review.** "Advisory not advice" wording is in `ADVISORY_DISCLAIMER`. Does the risk-recommendation language (stop-loss, position size) need additional disclaimers? Likely yes in some jurisdictions.

---

## 15. Risks

> **v4 update (codex findings Fix #1, Fix #6 / PR #123):** Quorum non-recovery entry replaced with v4 race-window entry. WebSocket capacity entry corrected to reflect 500/sec rate quota, not 500 concurrent connections.
>
> **v5 update (codex findings Fix #1, Fix #3, Fix #4 / PR #125 comment #4409943828):** Quorum non-recovery entry updated to reflect signals-v2-as-dedup (no processed-close-store). close-quorum-monitor entry updated to reflect OldImage requirement. New entry added for close-quorum stream StreamViewType regression risk.
>
> **v6 update (issue #128):** Quorum race window entry updated to reflect deterministic PK/SK on signals-v2 (Fix #1-v6). Missed-close monitor entry updated to use PK/SK lookup instead of signalKey attribute. Backfill-as-live entry updated to reflect Fix #2-v6 (source filter re-added).

| Risk                                                                          | Mitigation                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indicator off-by-one bugs propagate silently into bad signals.                | Phase 1's TradingView-fixture acceptance bar; replay tests.                                                                                                                                                                                                                                                                                                                        |
| LLM hallucinates a `buy` from a `hold`.                                       | Server-side guardrail validates allowed transformations; logs breaches.                                                                                                                                                                                                                                                                                                            |
| Sentiment classification misreads sarcasm/satire.                             | Aggregated over many articles; single bad classification has bounded impact.                                                                                                                                                                                                                                                                                                       |
| Volatility gate fires too often, suppressing all signals.                     | Threshold tunable; backtested to balance suppression vs noise.                                                                                                                                                                                                                                                                                                                     |
| User over-trusts confidence numbers.                                          | UI must show outcome history alongside confidence; "advisory" disclaimer everywhere.                                                                                                                                                                                                                                                                                               |
| Cross-exchange price disagreement on flash events.                            | Median-of-three; stale-flag exclusion; fall back to single-exchange when ≥2 are stale.                                                                                                                                                                                                                                                                                             |
| **Quorum race window (v6) — 2+ handlers compute for same slot concurrently.** | **Rare: DDB Streams mostly serializes per-slot events. Wasted compute bounded to 500ms–2s. signals-v2 conditional Put on deterministic PK=pair, SK=closeTime#tf with `attribute_not_exists(pair)` guarantees exactly-once write — concurrent handlers target the same item; DDB serializes. No orphaned marker can block recovery (processed-close-store eliminated, Fix #1-v5).** |
| **Close-quorum row expires (TTL) without a signal written (missed close).**   | **`close-quorum-monitor` Lambda reads OldImage from REMOVE event, looks up signals-v2 with PK=pair, SK=closeTime#tf (Fix #1-v6 deterministic key); if absent, emits `CloseMissed` CloudWatch metric; downstream alarm fires when no signal for pair/TF > N minutes (§11.5).**                                                                                                      |
| **close-quorum stream reverted to NEW_IMAGE (Fix #4 v5 regression).**         | **If `StreamViewType` is changed from `NEW_AND_OLD_IMAGES` to `NEW_IMAGE`, TTL REMOVE events carry no attributes — the monitor cannot read pair/tf/closeTime from OldImage and silently stops emitting CloseMissed metrics. Guard in Terraform: StreamViewType must be NEW_AND_OLD_IMAGES (see §11.5).**                                                                           |
| **Backfill candle triggers live signal (Fix #2-v6).**                         | **`source = "live"` FilterCriteria (Fix #2-v6) blocks backfill candles at the event source mapping. Risk if `source` field is omitted on any `storeCandles` write path: the filter rejects the event (silent miss, not incorrect signal). Guard: make `source` mandatory on `Candle` type; validate at write time.**                                                               |
| **WebSocket concurrent connection cap reached.**                              | **AWS API Gateway default is 500 new connections/second (rate), not 500 concurrent. Steady-state capacity ~600K concurrent per region. See §16.6.**                                                                                                                                                                                                                                |

---

## 16. WebSocket architecture — real-time signal push

> **v4 design (codex findings Fix #6 P2 — quota fact-check, Fix #7 P3 — inverted subscription table / PR #123).**

### 16.1 Why WebSocket

The current backend is Lambda-on-API-Gateway with no native WebSocket support (see §14 open question 3). For v1, polling is acceptable. For the production signal product, WebSocket push is required so users see new signals within 1–2 seconds of emission — not 30–60 seconds of polling lag.

### 16.2 Architecture choice — API Gateway WebSocket API

**v1 uses AWS API Gateway WebSocket API** (not IoT Core, not AppSync). Reasons:

- Native integration with Lambda handlers (`$connect`, `$disconnect`, `$default`)
- `postToConnection` API for fan-out
- No additional infrastructure dependency
- IAM-controlled, observable via CloudWatch

IoT Core is the migration path at scale — but the scale threshold is much higher than 500 concurrent connections (see §16.6).

### 16.3 Connection lifecycle

```
Client              API GW WebSocket       Lambda ($connect)       DDB (connection-registry)
  │                       │                        │                          │
  ├─ WS handshake ────────►                        │                          │
  │   ?pairs=BTC,ETH      │                        │                          │
  │                       ├─ invoke ───────────────►                          │
  │                       │                        ├─ Put {connectionId,      │
  │                       │                        │      userId, pairs,      │
  │                       │                        │      ttl} ───────────────►
  │                       │                        │                          │
  │   ◄─ 101 connected ───│                        │                          │
  │                       │                        │                          │
[...signal emits...]       │                        │                          │
  │                       │                        │                          │
  │   ◄─ push: {signal} ──│◄── postToConnection ───│                          │
  │                       │                        │                          │
  ├─ WS close ────────────►                        │                          │
  │                       ├─ invoke ───────────────►                          │
  │                       │  ($disconnect)         ├─ Delete {connectionId} ──►
```

### 16.4 Connection registry schema

```
Table: quantara-{env}-connection-registry
PK: connectionId  (from $connect event)
Attributes:
  userId: string           // from JWT, validated in $connect
  subscribedPairs: String Set   // e.g. {"BTC/USDT", "ETH/USDT"}
  connectedAt: number      // epoch milliseconds (consistent with Candle.closeTime)
  ttl: number              // epoch SECONDS — Math.floor(connectedAt / 1000) + 7_200
                           // (2h max session; matches API GW WebSocket max session duration)
                           // TTL conversion: same pattern as §5.9 — value is seconds, NOT milliseconds
```

### 16.5 Fan-out on signal emit

When a new blended signal is written to `signals-v2` (via DDB Streams on the signals table), a `signals-fanout` Lambda:

1. Reads the signal's `pair` from the stream event
2. Scans `connection-registry` for all items where `subscribedPairs` contains the pair
3. Calls `postToConnection` for each matching `connectionId`
4. On `GoneException` (stale connection): deletes the registry row

**v1 scan-and-filter is acceptable** for a few thousand connections. The inverted subscription table (§16.7) replaces the scan at scale.

### 16.6 WebSocket scaling — corrected quota facts (Fix #6)

> **v3 error corrected:** §16 previously stated "500 default WebSocket concurrent-connection quota." This was wrong. 500 is the **new connections per second** quota, not concurrent connections.

Correct AWS API Gateway WebSocket quotas (as of 2026):

- **500 new connections/second** per account per region (soft quota — raisable via AWS Support)
- **200 concurrent frames/message per connection** (hard)
- No explicit concurrent connection limit — bounded by `new_conn_rate × avg_session_duration`
- Default idle timeout: 10 minutes; maximum connection duration: 2 hours (a session ends at the earlier of the two)
- Steady-state concurrent capacity estimate: `500 conn/s × 1200s avg session → ~600,000 concurrent connections per region`. Lower bound `500 × 600s = 300K` if every session idles out at 10 min; upper bound `500 × 7200s = 3.6M` if every session lives the full 2h. Use **~600K** as the planning number; matches the §15 risk-register row.

**IoT Core migration threshold:** not driven by concurrent connection count — driven by needing MQTT-level features (retained messages, QoS, device shadow, multi-region fan-out). Trigger: WebSocket connection rate approaches 500/sec sustained, or fan-out latency degrades beyond the 1s SLO at scale.

For Quantara's expected user base (hundreds to low thousands of concurrent users), the default API Gateway WebSocket quota is not a constraint.

### 16.7 Inverted subscription table — scale path (Fix #7)

**v1:** fan-out uses a scan of `connection-registry` filtered on `subscribedPairs` set membership. This works for up to ~10K active connections (scan is bounded and fast at that volume).

**Scale path (not implemented in v1):** an inverted `connection-subscriptions` table enables O(1) lookup by pair:

```
Table: quantara-{env}-connection-subscriptions
PK: pair          (e.g. "BTC/USDT")
SK: connectionId
Attributes:
  userId: string
  subscribedAt: ISO8601
  ttl: number  // epoch SECONDS — same TTL as connection-registry row
```

Write path — on `$connect` with `?pairs=BTC,ETH`:

```
Write { pair: "BTC/USDT", connectionId, userId, ttl } to connection-subscriptions
Write { pair: "ETH/USDT", connectionId, userId, ttl } to connection-subscriptions
Write { connectionId, userId, subscribedPairs: {"BTC/USDT", "ETH/USDT"}, ttl } to connection-registry
```

Fan-out path — for pair `BTC/USDT`:

```
Query connection-subscriptions where PK = "BTC/USDT"
→ Returns [connectionId, connectionId, ...]
→ postToConnection per id
```

No scan. Eliminates the `subscribedPairs` GSI plan from v3 (which was invalid — DynamoDB GSIs cannot index individual String Set members).

**Trigger for v1 → scale path migration:** fan-out Lambda p99 latency > 500ms sustained, or connection count crosses 10K active. Ship when load data justifies the additional write amplification.

---

## Appendix A — Rule library starter set

Initial rules to ship in Phase 2. Each is `(name, condition, direction, strength)`. Strength values are starting points; calibrate via outcome attribution after Phase 8.

```ts
// packages/shared/src/constants/signals.ts (proposed)
export const RULES = [
  // momentum
  { name: "rsi-oversold-strong", direction: "bullish", strength: 1.5, when: (s) => s.rsi14 < 20 },
  {
    name: "rsi-oversold",
    direction: "bullish",
    strength: 1.0,
    when: (s) => s.rsi14 >= 20 && s.rsi14 < 30,
  },
  { name: "rsi-overbought-strong", direction: "bearish", strength: 1.5, when: (s) => s.rsi14 > 80 },
  {
    name: "rsi-overbought",
    direction: "bearish",
    strength: 1.0,
    when: (s) => s.rsi14 > 70 && s.rsi14 <= 80,
  },

  // trend
  {
    name: "ema-stack-bull",
    direction: "bullish",
    strength: 0.8,
    when: (s) => s.ema20 > s.ema50 && s.ema50 > s.ema200,
  },
  {
    name: "ema-stack-bear",
    direction: "bearish",
    strength: 0.8,
    when: (s) => s.ema20 < s.ema50 && s.ema50 < s.ema200,
  },
  {
    name: "macd-cross-bull",
    direction: "bullish",
    strength: 1.0,
    when: (s) => s.macdHist > 0 && s.macdHist_prev <= 0,
  },
  {
    name: "macd-cross-bear",
    direction: "bearish",
    strength: 1.0,
    when: (s) => s.macdHist < 0 && s.macdHist_prev >= 0,
  },

  // mean reversion
  {
    name: "bollinger-touch-lower",
    direction: "bullish",
    strength: 0.5,
    when: (s) => s.close <= s.bbLower,
  },
  {
    name: "bollinger-touch-upper",
    direction: "bearish",
    strength: 0.5,
    when: (s) => s.close >= s.bbUpper,
  },

  // volume confirmation
  {
    name: "volume-spike-bull",
    direction: "bullish",
    strength: 0.7,
    when: (s) => s.volZ > 2 && s.close > s.open,
  },
  {
    name: "volume-spike-bear",
    direction: "bearish",
    strength: 0.7,
    when: (s) => s.volZ > 2 && s.close < s.open,
  },

  // sentiment overlay (Fear & Greed only — news is in LLM layer)
  { name: "fng-extreme-greed", direction: "bearish", strength: 0.3, when: (s) => s.fearGreed > 75 },
  { name: "fng-extreme-fear", direction: "bullish", strength: 0.3, when: (s) => s.fearGreed < 25 },
];
```

This list is intentionally short for v1. Add new rules only after Phase 8 attribution proves the existing set is undersignaled, not oversignaled.
