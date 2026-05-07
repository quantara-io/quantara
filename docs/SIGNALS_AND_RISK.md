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

### Architectural commitment: Hybrid (Option C)

Decision recorded: **algo proposes, LLM ratifies**.

- A deterministic indicator engine emits `{type, confidence, indicators_fired}` on each candle close.
- An LLM ratification layer can **downgrade** (`buy` → `hold`, lower confidence) but never invent a new direction.
- LLM is opt-in per signal — only invoked when the algo confidence and recent news flow justify the cost.
- If the LLM call fails, the algo signal passes through unchanged (graceful degradation).

---

## 2. Inputs available today

| Input | Source | Frequency | Storage |
|---|---|---|---|
| 1m closed OHLCV candles | Fargate `MarketStreamManager` (CCXT Pro WebSocket) | Per minute, per `(exchange, pair)` | DDB `quantara-dev-candles`, 7d TTL |
| 5m / 15m / 1h / 4h / 1d candles | `quantara-dev-backfill` Lambda (REST `fetchOHLCV`) | On-demand backfill, archived to S3 | DDB + S3 archive, TTL 30d / 30d / 90d / 90d / 365d |
| Real-time tickers | Fargate `watchTicker` | Multi-tick / second | DDB `quantara-dev-prices`, 7d TTL |
| 5-min ticker snapshots | `quantara-dev-ingestion` Lambda (EventBridge schedule) | 5 min | Same prices table |
| Fear & Greed Index | `alternative.me/fng` REST poll | 1 hour | DDB metadata `market:fear-greed` |
| News articles | Alpaca News API + RSS (CoinTelegraph, Decrypt, CoinDesk) | 2 min | DDB `news-events`, 30d TTL |
| Sentiment-classified news | News enrichment Lambda (SQS-driven) | Per article | DDB `news-events` (enriched fields) |
| Whale flows | **Not yet wired** | — | See `docs/WHALE_MONITORING.md` |

### Data-quality gaps to fix before this lands

1. **Higher-timeframe candles (5m / 15m / 1h / 4h / 1d) need a scheduled REST poll on close.**
   EventBridge → Lambda calls `fetchOHLCV(pair, timeframe)` on each close boundary for all three exchanges. Reuses the existing `fetchOHLCV` path (same as backfill). Works for Coinbase (which lacks `watchOHLCV`). Total volume: ~1200 calls/hour, well within rate limits.
   The 1m stream from `MarketStreamManager` continues to drive real-time tickers and intra-bar updates; closed higher-TF candles come from the scheduled poller. WebSocket per-TF subscriptions remain a future option for hot pairs (e.g. BTC) once load is observed.

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

| Option | Behavior | Why rejected for v1 |
|---|---|---|
| **WebSocket `watchOHLCV` per timeframe (Option B)** | Subscribe to 5m/15m/1h/4h on the Fargate streamer | Doesn't solve Coinbase (no `watchOHLCV` support); 4× more WS connections per pair; harder to monitor than Lambda |
| **Aggregate from the 1m stream (Option A)** | Roll up 1m candles into higher TFs | Depends on 1m stream being unbroken (gaps → bad aggregations); doesn't help Coinbase since we have no 1m there |
| **Chosen: scheduled REST poll (Option C)** | EventBridge → Lambda calls `fetchOHLCV` on each close boundary | All three exchanges, Lambda monitoring, ~1200 calls/hour, reuses backfill code |

WebSocket per-TF subscription remains a **future option** for hot pairs (e.g. BTC) once production load is observed. Track in §14 Open Questions, not as a v1 phase.

---

## 3. Indicator stack

Indicators are computed per `(exchange, pair, timeframe)` combination, then reduced across exchanges (median) before scoring. All indicators below are standard formulations — listed here so the implementation matches a known reference and we can validate against TradingView / TA-Lib.

### 3.1 Trend indicators

| Indicator | Formula | Use |
|---|---|---|
| **EMA(N)** | `EMA[t] = α·close[t] + (1-α)·EMA[t-1]`, `α = 2/(N+1)` | Trend direction at multiple speeds |
| **MACD(12, 26, 9)** | `MACD = EMA(12) − EMA(26)`; `signal = EMA(MACD, 9)`; `hist = MACD − signal` | Trend reversals via histogram zero-cross |
| **EMA-stack (20/50/200)** | Bullish if `EMA(20) > EMA(50) > EMA(200)`; bearish inverse | Trend regime classification |

### 3.2 Momentum indicators

| Indicator | Formula | Use |
|---|---|---|
| **RSI(14)** | `RSI = 100 − 100/(1 + RS)`, `RS = avg_gain(14) / avg_loss(14)` | Overbought (>70), oversold (<30) |
| **Stochastic(14, 3, 3)** | `%K = 100·(close − low_N) / (high_N − low_N)`; `%D = SMA(%K, 3)` | Oscillator — sharper than RSI |
| **ROC(N)** | `(close[t] − close[t-N]) / close[t-N]` | Raw momentum strength |

### 3.3 Volatility indicators

| Indicator | Formula | Use |
|---|---|---|
| **ATR(14)** | `TR = max(high − low, abs(high − close[-1]), abs(low − close[-1]))`; `ATR = SMA(TR, 14)` | **Stop-loss sizing.** ATR defines "normal" volatility. |
| **Bollinger(20, 2σ)** | `mid = SMA(20)`, `upper/lower = mid ± 2·stdev(20)` | Bandwidth = squeeze detection; price-touching = mean-reversion candidate |
| **Realized vol (24h)** | `stdev(returns_1m, last 1440 bars) · sqrt(525600)` (annualized) | Trigger the `volatilityFlag` if > threshold (forces all signals to `hold`) |

### 3.4 Volume indicators

| Indicator | Formula | Use |
|---|---|---|
| **OBV** | `OBV[t] = OBV[t-1] + sign(close[t] − close[t-1]) · volume[t]` | Confirms or contradicts price moves |
| **VWAP** (intraday only) | `Σ(typical_price · volume) / Σ(volume)` reset at session boundary | Reference for intraday signals; institutional benchmark |
| **Volume z-score** | `(volume[t] − SMA(volume, 20)) / stdev(volume, 20)` | Spot abnormal volume; gates breakouts |

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

| Indicator | Hazard | Handling |
|---|---|---|
| **EMA** | Naive recursion `EMA[0] = close[0]` is biased low for ~3·N bars | Seed `EMA[N-1] = SMA(close, N)`, then recurse from bar `N`. Ignore first 3·N bars in backtests. |
| **RSI** | Two valid avg-gain/loss methods (Wilder's RMA vs SMA) produce different numbers | Use **Wilder's RMA** to match TradingView. Document explicitly in code. |
| **RSI** | First N values undefined | Return `null` (not 50) for warm-up bars; treat as no-signal |
| **Stochastic** | When `high_N == low_N` (perfectly flat bar), formula divides by zero | If range is zero, return `%K = 50` |
| **ATR** | Bar 0 has no previous close → True Range undefined | Use `high − low` for bar 0 only |
| **ATR** | Mixing Wilder's smoothing for ATR with SMA elsewhere causes silent number drift | Use **Wilder's RMA** explicitly; name helpers `wilderSmooth(...)` vs `sma(...)` |
| **Bollinger** | Standard deviation: divide by N or N-1? | Divide by N (population stdev — Bollinger's original spec, TradingView default) |
| **Bollinger** | During calm periods, BB width approaches zero, "touch" rule fires constantly | Rules using band touches must also check `bbWidth > Yth percentile` over a window |
| **OBV** | Cumulative and unbounded — comparing OBV value across pairs is invalid | Use OBV **slope** (linear regression over last 10 bars) as the actual signal |
| **VWAP** | Crypto trades 24/7 — no natural session boundary | Reset at **00:00 UTC** daily. Compute only for 15m / 1h timeframes. |
| **Volume z-score** | Volume has strong time-of-day pattern; flat z-score over 20 bars compares 03:00 UTC to 14:00 UTC | Acceptable noise for v1. Time-of-day-bucketed z-score is **deferred to v2**. |
| **Volume z-score** | If `stdev(volume, N) == 0`, division explodes | Guard: return 0 |
| **Realized vol** | Annualization factor depends on timeframe | `bars_per_year = {1m: 525600, 5m: 105120, 15m: 35040, 1h: 8760, 4h: 2190, 1d: 365}` |
| **Realized vol** | First N log-returns include NaN if any candle has zero close | Skip bars with zero or null close; require ≥N valid returns before emitting |
| **All** | Single-bar-update path may diverge from full-recomputation path | Phase 1 acceptance: unit test asserts `update(state, candle) ≡ recompute(allCandles)` for every indicator |

---

## 4. Per-timeframe scoring

Each timeframe produces an independent vote `{type, confidence, evidence}` using a **rule-confluence** model. Chosen over decision trees and ML approaches because (a) it ships with zero training data, (b) `rulesFired[]` is naturally explainable in the reasoning string, and (c) it migrates cleanly to logistic regression after Phase 8 outcome data exists.

### Rejected scoring approaches

> **NOT IN ANY PHASE.** Recorded for context only.

| Approach | Why rejected for v1 |
|---|---|
| **Decision tree** (hand-coded if/else nesting) | Brittle — one rule change reshapes outputs; hard to maintain |
| **Logistic regression on indicators → outcome** | Needs ~6 months of labeled outcomes per pair × TF before fitting; can't ship without training data |
| **Random forest / gradient-boosted trees** | Same data dependency; opaque attribution; harder to audit |
| **Fuzzy logic (membership functions, T-norms)** | More expressive but harder to debug; team needs to build fuzzy-logic literacy first |

**Forward path:** rule confluence today, logistic regression replaces hand-tuned strengths in a future phase once Phase 8 attribution data is rich enough. The rule structure stays; only the strengths become learned. Track as a future-phase candidate, not a v1 issue.

### 4.1 Rule structure

```ts
interface Rule {
  name: string;
  direction: "bullish" | "bearish" | "gate";
  strength: number;                          // contribution to score on fire
  when: (state: IndicatorState) => boolean;

  appliesTo: Timeframe[];                    // TFs the rule runs on
  group?: string;                            // mutually-exclusive group
  cooldownBars?: number;                     // suppress re-fire for N bars
  requiresPrior: number;                     // bars of warm-up before eligible
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
  const fired = rules.filter(r =>
    r.when(state) &&
    r.appliesTo.includes(state.tf) &&
    state.barsSinceStart >= r.requiresPrior &&
    state.barsSinceLastFire(r) >= (r.cooldownBars ?? 0)
  );
  const byGroup = groupBy(fired, r => r.group ?? r.name);
  return Object.values(byGroup).map(group =>
    group.reduce((max, r) => (r.strength > max.strength ? r : max))
  );
}
```

Maintain the rule list in `packages/shared/src/constants/signals.ts`. See Appendix A.

### 4.2 IndicatorState shape

State carries current indicator values plus a 5-bar history ring buffer for cross/divergence rules.

```ts
interface IndicatorState {
  pair: string;
  exchange: string;        // or "consensus" for canonicalized
  timeframe: Timeframe;
  asOf: number;            // unix ms of latest closed candle
  barsSinceStart: number;  // for requiresPrior gating

  // current bar
  rsi14: number;
  ema20: number; ema50: number; ema200: number;
  macdLine: number; macdSignal: number; macdHist: number;
  atr14: number;
  bbUpper: number; bbMid: number; bbLower: number; bbWidth: number;
  obv: number; obvSlope: number;          // slope over last 10 bars
  vwap: number | null;                    // null on TFs other than 15m/1h
  volZ: number;
  realizedVolAnnualized: number;
  fearGreed: number;                      // overlay, refreshed hourly
  dispersion: number;                     // cross-exchange spread / median

  // 5-bar history (most recent first)
  history: {
    rsi14: number[]; macdHist: number[];
    ema20: number[]; ema50: number[];
    close: number[]; volume: number[];
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

| State | Meaning | When |
|---|---|---|
| `signal: {type, confidence, ...}` | Normal output | Rules fire above threshold, no gates |
| `signal: {type: "hold", volatilityFlag: true, gateReason}` | Gated hold | Vol / dispersion / stale-data gate fired |
| `null` | No opinion | Warm-up, missing required indicators, exchange data unavailable |

`null` is distinct from `hold`. `hold` means "I have an opinion: stay out." `null` means "I don't have an opinion." UIs must surface the distinction (e.g. greyed-out vs. yellow `hold` chip).

### 4.6 Gate spec (volatility / dispersion / stale)

Three independent gates, any of which forces `type = "hold"`:

**Volatility gate** — per-pair absolute annualized-vol thresholds for v1. Migrate to 30-day z-score in v2 once history exists.

| Pair | Vol gate threshold (annualized) |
|---|---|
| BTC/USDT | 150% |
| ETH/USDT | 200% |
| SOL/USDT | 300% |
| XRP/USDT | 250% |
| DOGE/USDT | 350% |

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

| Rule (from Appendix A) | 15m | 1h | 4h | 1d |
|---|---|---|---|---|
| `rsi-oversold-strong` / `rsi-oversold` | ✅ | ✅ | ✅ | ✅ |
| `rsi-overbought-strong` / `rsi-overbought` | ✅ | ✅ | ✅ | ✅ |
| `ema-stack-bull` / `ema-stack-bear` | ❌ | ❌ | ✅ | ✅ |
| `macd-cross-bull` / `macd-cross-bear` | ❌ | ✅ | ✅ | ✅ |
| `bollinger-touch-lower` / `-upper` | ❌ | ❌ | ✅ | ✅ |
| `volume-spike-bull` / `-bear` | ✅ | ✅ | ✅ | ✅ |
| `fng-extreme-greed` / `-extreme-fear` | ✅ | ✅ | ✅ | ✅ |
| `vwap-cross-bull` / `-bear` (future) | ✅ | ✅ | ❌ | ❌ |

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

| Rule | Direction | Strength |
|---|---|---|
| `rsi-oversold` (group: rsi-oversold-tier) | bullish | +1.0 |
| `macd-cross-bull` | bullish | +1.0 |
| `fng-extreme-fear` | bullish | +0.3 |
| `ema-stack-bear` | bearish | +0.8 |
| `volume-spike-bull` | — (close < open, condition fails) | — |

Score:
```
bullish = 1.0 + 1.0 + 0.3 = 2.3
bearish = 0.8

bullish ≥ MIN_CONFLUENCE (1.5)? Yes.
bullish > bearish? Yes.
type = "buy"
confidence = sigmoid(2.3 − 0.8) = sigmoid(1.5) ≈ 0.68
volatilityFlag = false (no gate fired)
```

Reasoning string the algo emits (LLM ratification then refines):
> *"Oversold RSI plus fresh MACD bullish cross on the 1h, with extreme fear sentiment supporting a contrarian bounce. Daily-style EMA stack remains bearish — keeps confidence moderate. Bounce candidate, not a trend reversal."*

This is the kind of signal the algo emits cleanly. Mean-reversion buy against the longer-term trend is a valid setup at lower confidence — precisely what the formula expresses.

---

## 5. Multi-horizon blending

The user picked multi-horizon: compute on 15m / 1h / 4h / 1d, blend into one signal per pair.

### 5.1 Why multi-horizon

- 1d catches regime; 4h catches trend; 1h catches setup; 15m catches entry timing.
- Disagreement between horizons is itself informative — "bullish on 1d, bearish on 1h" is a "hold for now, watch the 1h reversal" signal, not a buy or a sell.
- Makes confidence better calibrated: when *all* horizons agree, confidence is high; when they conflict, confidence drops.

### 5.2 Weighting

Default weights (tunable per-pair after calibration):

| Timeframe | Weight | Rationale |
|---|---|---|
| 1d | 0.35 | Regime — most predictive over multi-day windows |
| 4h | 0.30 | Trend |
| 1h | 0.20 | Setup |
| 15m | 0.15 | Entry timing |

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

If `1d` says `buy` and `1h` says `sell`, the blended scalar might still be bullish but with low magnitude — naturally resolves to `hold` via the threshold `T`. The reasoning string should call this out explicitly: *"Daily trend is up but the 1h is rolling over. Wait for confirmation."*

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

| Case | Recommended behavior |
|---|---|
| All 4 TFs vote `null` | Blend returns `null`. UI: "warming up — no signal yet." |
| All 4 TFs vote `hold` (no gates) | Blend returns `hold` at confidence 0.5. |
| 3 TFs `null`, 1 TF votes | Re-normalized weight = 1.0 on the voting TF. Blend confidence multiplied by 0.7 to reflect single-source uncertainty. |
| Any TF has `volatilityFlag: true` | Blend forces `type = "hold"`, `volatilityFlag: true`, `gateReason: "vol"`. Confidence = 0.5. |
| Any TF has `gateReason = "dispersion"` or `"stale"` | Blend forces `type = "hold"`, propagates the gateReason. Confidence = 0.5. |
| Mixed gates (e.g. 4h `vol`-gated, 1h `stale`-gated) | Priority: `vol` > `dispersion` > `stale`. Blend's `gateReason` is the highest-priority one fired on any TF. |

---

## 6. Sentiment integration

### 6.1 What we ingest today

- **News articles** via Alpaca + 3 RSS feeds (every 2 min). Each article has title, body, and an `enrichment` job that runs sentiment classification.
- **Fear & Greed Index** (hourly): a single value 0–100 with classification (`extreme fear` … `extreme greed`).

### 6.2 What needs to be added

1. **Pair entity extraction** in the enrichment Lambda: tag each article with the symbol(s) it mentions (`BTC`, `ETH`, `SOL`, `XRP`, `DOGE`). Without this, news has no pair-level signal.
2. **Sentiment polarity** per article: `{score: -1..+1, magnitude: 0..1}`. The enrichment can use a small classifier (FinBERT, finBERT-crypto, or LLM in JSON mode).
3. **Aggregated sentiment** per pair over a rolling window:
   - `last 4h` and `last 24h` windows
   - Stored in a derived metadata key, e.g. `sentiment:BTC:4h = {score, count, magnitude}`
   - Recomputed when new news lands or every 5 min on a schedule.

### 6.3 How sentiment enters the signal

Sentiment is **not** treated as an algo rule. It enters at the LLM ratification step (§7). Why:

- Sentiment is qualitative. Trying to express "Coinbase delisting rumor" as `+0.8` on a fixed rule is a brittle hack.
- The LLM is already good at reading a 200-word headline and deciding *"this materially changes my view of the next 4h."*
- Keeping sentiment out of the algo preserves backtestability — algo signals are deterministic from candles alone. Sentiment overlays are tracked separately for attribution.

The Fear & Greed Index *is* a hard rule (it's a single number, well-defined): when the index is in `extreme greed` (>75), apply a small bearish bias; in `extreme fear` (<25), apply a small bullish bias (contrarian, well-supported empirically). Magnitude: ±0.3 confidence shift, never enough to flip direction.

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

### 7.3 Model choice

Recommend **Claude Haiku 4.5** for ratification — fast, cheap, good at structured output. Reserve Sonnet/Opus for the conversational layer when users ask Genie *"why did this signal fire?"* and we want a longer narrative.

### 7.4 Failure modes & fallback

- **LLM call times out (>3s):** Use algo signal unchanged. Log.
- **LLM returns invalid JSON:** Use algo signal unchanged. Log.
- **LLM violates downgrade-only rule:** Use algo signal unchanged. Log + alert (if this fires often, the prompt is broken).
- **LLM provider outage:** Algo signals continue to flow. The system never depends on the LLM being up.

---

## 8. Whale signal integration (forward-looking)

See `docs/WHALE_MONITORING.md` for the deeper plan. Hooks in this design:

- A whale event (>$1M USD-equiv on-chain transfer to/from a tracked exchange wallet) generates a `WhaleEvent` record.
- Aggregated over a rolling 1h window per pair, becomes another input to the LLM ratification prompt.
- Large net inflows to exchanges → bearish bias (people moving to sell). Large outflows → bullish (accumulation).
- Like sentiment, whale data does **not** enter the algo. It's qualitative and easily gameable; the LLM is the right place to weigh it.

A future iteration may add a hard rule (e.g. "exchange net inflow > 10× 30-day average → force hold") if backtests show predictive value.

---

## 9. Risk management

Risk recommendations are emitted **alongside** each non-`hold` signal. They are advisory and parameterized by the user's tier/profile.

### 9.1 Position sizing

Three models supported, user-selectable per profile:

| Model | Formula | Best for |
|---|---|---|
| **Fixed-fractional** | `size = account · risk_pct` (e.g. 1% of account per trade) | Beginners; predictable drawdown |
| **Volatility-targeted** | `size = (account · risk_pct) / (ATR · multiplier)` | Adapts to current market vol |
| **Kelly-fractional** | `size = account · 0.25 · kelly_f`, where `kelly_f = (p·b − q) / b` | Advanced users with tracked accuracy |

`p` = signal accuracy (from `SignalHistoryEntry.outcome`), `q = 1 − p`, `b` = avg-win / avg-loss ratio (R-multiple). Capped at 25% Kelly to avoid ruin. Only available once we have ≥30 resolved signals for that pair/timeframe.

### 9.2 Stop-loss

Every `buy`/`sell` signal carries a recommended stop-loss derived from ATR:

```
stop_distance = ATR(14, signal_timeframe) · stop_multiplier
buy_stop  = entry_price − stop_distance
sell_stop = entry_price + stop_distance
```

`stop_multiplier` defaults:
- Conservative profile: 1.5× ATR
- Moderate: 2.0× ATR
- Aggressive: 3.0× ATR

ATR-based stops adapt to the current volatility regime — wider stops in chaos, tighter in calm. Avoid percentage stops (e.g. "5% below entry"); they're vol-blind.

### 9.3 Take-profit

Recommend **R-multiples** (`R` = stop distance in price units):

- TP1: `1R` — close 50% of position
- TP2: `2R` — close 25%
- TP3: `3R` — leave 25% with trailing stop

This is the canonical asymmetric-payoff structure. With a baseline 50% accuracy, 1R/2R/3R staging produces positive expectancy.

### 9.4 Drawdown limits

Per-user limits stored in profile:
- Daily drawdown cap (default 3% of account) — once breached, suppress all new signals for the rest of the trading day.
- Weekly drawdown cap (default 7%) — suppress for the rest of the week.
- Per-pair concurrent-position cap (default 1).

These are *suggestions* the UI surfaces, not enforcement. Quantara has no execution capability.

### 9.5 Schema additions

Extend the `Signal` type:

```ts
export interface RiskRecommendation {
  positionSizePct: number;          // % of account
  positionSizeModel: "fixed" | "vol-targeted" | "kelly";
  stopLoss: number;                 // price
  stopDistanceR: number;            // R-multiple stop distance
  takeProfit: { price: number; closePct: number }[];
  invalidationCondition: string;    // human-readable
}

export interface Signal {
  // ...existing fields
  risk: RiskRecommendation | null;  // null when type === "hold"
}
```

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

### 10.2 Expiry windows (per timeframe)

| Source timeframe | Expiry window |
|---|---|
| 15m | 4 hours |
| 1h | 12 hours |
| 4h | 2 days |
| 1d | 5 days |

For multi-horizon blended signals, use the `1d` window (longest source horizon).

### 10.3 Outcome rule

```
priceMove = (priceAtResolution − priceAtSignal) / priceAtSignal
threshold = 0.5 · ATR_pct  // half an ATR move = "meaningful"

if signal.type == "hold":
    outcome = "neutral"  // we don't score holds against direction
elif signal.type == "buy":
    if priceMove > +threshold:  outcome = "correct"
    elif priceMove < -threshold: outcome = "incorrect"
    else:                        outcome = "neutral"
elif signal.type == "sell":
    if priceMove < -threshold:  outcome = "correct"
    elif priceMove > +threshold: outcome = "incorrect"
    else:                        outcome = "neutral"
```

ATR-relative thresholding is the right choice: a "meaningful move" in DOGE is wildly different from BTC. Using a flat % cutoff would over-credit signals on more volatile pairs.

### 10.4 What we do with outcomes

- Compute rolling 30/90-day accuracy per pair, per timeframe, per rule that fired.
- Surface "73% directional accuracy on BTC over 90 days" badges (compliance-cleared phrasing — never claim "profitable").
- Feed back into Kelly sizing once `n ≥ 30`.
- Identify failing rules (rule-X fires often but its signals score `incorrect`) and prune them.

---

## 11. Storage schema

Two new DDB tables, two extensions to existing tables.

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

---

## 12. Compute architecture

### 12.1 Where indicators run

Two viable shapes:

**Shape A — In-process on the Fargate streamer.**
Pros: indicators stay hot in memory, microsecond recomputation on every candle close. Keeps state.
Cons: stateful service is harder to scale horizontally; restart loses warm-up window.

**Shape B — Scheduled Lambda + DDB-derived state.**
Pros: stateless, easy to scale, easy to replay against historical candles for backtests.
Cons: pays DDB read cost on every run; indicators have to be re-derived from candles each invocation.

**Recommendation: Shape B.** Scheduled `IndicatorLambda` triggered on each candle-close boundary (per timeframe) computes indicators from DDB candles + caches the indicator values back into a `quantara-{env}-indicator-state` table. The next signal computation reads cached state + the most recent candle and recomputes only the deltas.

Why: backtestability. We need to be able to point the indicator engine at historical candles and reproduce the exact signals that would have fired. A stateful Fargate process makes that arduous.

### 12.2 Latency budget

| Step | Target | Notes |
|---|---|---|
| Candle close → indicator state updated | < 5s | Lambda cold start is the cap |
| Indicators → algo signal | < 50ms | Pure CPU |
| Algo signal → LLM ratification (when invoked) | < 3s | Haiku is sub-second typically; budget 3s p99 |
| Signal → user-visible | < 30s end-to-end | Backend caches and pushes to web |

### 12.3 Scheduling

EventBridge rules per timeframe:
- `cron(* * * * ? *)` — every minute (drives 15m/1h/4h/1d depending on minute-of-hour)
- The Lambda checks `now() % timeframe == 0` for each TF and only computes the ones that just closed.

Avoids deploying 4 separate schedules; single Lambda decides what to do.

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
Files: `ingestion/src/indicator-handler.ts`, terraform additions for `signals` and `indicator-state` tables, EventBridge rule.
Acceptance: real candles → cached indicator state → algo signal persisted to DDB.

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

| Risk | Mitigation |
|---|---|
| Indicator off-by-one bugs propagate silently into bad signals. | Phase 1's TradingView-fixture acceptance bar; replay tests. |
| LLM hallucinates a `buy` from a `hold`. | Server-side guardrail validates allowed transformations; logs breaches. |
| Sentiment classification misreads sarcasm/satire. | Aggregated over many articles; single bad classification has bounded impact. |
| Volatility gate fires too often, suppressing all signals. | Threshold tunable; backtested to balance suppression vs noise. |
| User over-trusts confidence numbers. | UI must show outcome history alongside confidence; "advisory" disclaimer everywhere. |
| Cross-exchange price disagreement on flash events. | Median-of-three; stale-flag exclusion; fall back to single-exchange when ≥2 are stale. |

---

## Appendix A — Rule library starter set

Initial rules to ship in Phase 2. Each is `(name, condition, direction, strength)`. Strength values are starting points; calibrate via outcome attribution after Phase 8.

```ts
// packages/shared/src/constants/signals.ts (proposed)
export const RULES = [
  // momentum
  { name: "rsi-oversold-strong",     direction: "bullish", strength: 1.5,
    when: (s) => s.rsi14 < 20 },
  { name: "rsi-oversold",            direction: "bullish", strength: 1.0,
    when: (s) => s.rsi14 >= 20 && s.rsi14 < 30 },
  { name: "rsi-overbought-strong",   direction: "bearish", strength: 1.5,
    when: (s) => s.rsi14 > 80 },
  { name: "rsi-overbought",          direction: "bearish", strength: 1.0,
    when: (s) => s.rsi14 > 70 && s.rsi14 <= 80 },

  // trend
  { name: "ema-stack-bull",          direction: "bullish", strength: 0.8,
    when: (s) => s.ema20 > s.ema50 && s.ema50 > s.ema200 },
  { name: "ema-stack-bear",          direction: "bearish", strength: 0.8,
    when: (s) => s.ema20 < s.ema50 && s.ema50 < s.ema200 },
  { name: "macd-cross-bull",         direction: "bullish", strength: 1.0,
    when: (s) => s.macdHist > 0 && s.macdHist_prev <= 0 },
  { name: "macd-cross-bear",         direction: "bearish", strength: 1.0,
    when: (s) => s.macdHist < 0 && s.macdHist_prev >= 0 },

  // mean reversion
  { name: "bollinger-touch-lower",   direction: "bullish", strength: 0.5,
    when: (s) => s.close <= s.bbLower },
  { name: "bollinger-touch-upper",   direction: "bearish", strength: 0.5,
    when: (s) => s.close >= s.bbUpper },

  // volume confirmation
  { name: "volume-spike-bull",       direction: "bullish", strength: 0.7,
    when: (s) => s.volZ > 2 && s.close > s.open },
  { name: "volume-spike-bear",       direction: "bearish", strength: 0.7,
    when: (s) => s.volZ > 2 && s.close < s.open },

  // sentiment overlay (Fear & Greed only — news is in LLM layer)
  { name: "fng-extreme-greed",       direction: "bearish", strength: 0.3,
    when: (s) => s.fearGreed > 75 },
  { name: "fng-extreme-fear",        direction: "bullish", strength: 0.3,
    when: (s) => s.fearGreed < 25 },
];
```

This list is intentionally short for v1. Add new rules only after Phase 8 attribution proves the existing set is undersignaled, not oversignaled.
