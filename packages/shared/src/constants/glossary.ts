/**
 * GLOSSARY — single source of truth for inline help tooltip content.
 *
 * Used by admin dashboard HelpTooltip insertions. Will be reused by the
 * web app and marketing pages when those gain inline explanations.
 *
 * Rules:
 *   - `body` must be plain-enough prose for a non-expert to follow.
 *   - `code` is an optional formula / pseudocode in monospace.
 *   - `docHref` uses the in-app canonical form `/admin/glossary#<key>`.
 *     Leave undefined until the glossary page (#229) ships.
 */

export interface GlossaryEntry {
  /** Short headline shown bold at top of tooltip popover. */
  label: string;
  /** 1–4 sentence explanation. Plain prose; markdown-lite bold/code is OK. */
  body: string;
  /** Optional inline formula rendered in monospace below the body. */
  code?: string;
  /**
   * Optional deep link to an in-app anchor.
   * Canonical form: `/admin/glossary#<key>` — omit until #229 ships.
   */
  docHref?: string;
}

export const GLOSSARY = {
  // -------------------------------------------------------------------------
  // Technical indicators
  // -------------------------------------------------------------------------

  rsi14: {
    label: "RSI 14",
    body: "Relative Strength Index over 14 bars. Measures the speed and magnitude of recent price changes on a 0–100 scale. Readings above 70 suggest overbought conditions; below 30 suggest oversold.",
    code: "RSI = 100 − 100 / (1 + avg_gain / avg_loss)",
  },

  emaStack: {
    label: "EMA Stack",
    body: "EMA20 > EMA50 > EMA200 is a strong uptrend signature (all shorter averages above the longer ones). When the stack inverts the trend is weakening. Used as a confluence filter — the blender weights long signals higher when the stack aligns bullishly.",
  },

  ema20: {
    label: "EMA 20",
    body: "Exponential Moving Average over 20 bars. Faster-reacting than the 50-period EMA. Frequently acts as dynamic short-term support in trending markets.",
  },

  ema50: {
    label: "EMA 50",
    body: "Exponential Moving Average over 50 bars. Mid-term trend filter. Price above the 50 EMA is a prerequisite for most Quantara long setups.",
  },

  ema200: {
    label: "EMA 200",
    body: "Exponential Moving Average over 200 bars. The primary long-term trend anchor. Bull market = price above EMA 200; bear market = below.",
  },

  macdHist: {
    label: "MACD Histogram",
    body: "Moving Average Convergence/Divergence histogram. The bar height = MACD line minus its signal line. Positive and growing = bullish momentum building; negative and shrinking = bearish momentum fading.",
    code: "MACD = EMA12 − EMA26 | Signal = EMA9(MACD) | Hist = MACD − Signal",
  },

  bbBands: {
    label: "Bollinger Bands",
    body: "Three lines around a 20-bar SMA: upper and lower bands are 2 standard deviations away. Price near the upper band signals expansion / potential overbought; near the lower band signals contraction / potential oversold. Band squeeze (low width) precedes large moves.",
    code: "Upper = SMA20 + 2σ | Lower = SMA20 − 2σ",
  },

  atr14: {
    label: "ATR 14",
    body: "Average True Range over 14 bars. Measures raw market volatility in price units (not percent). Used for stop-loss sizing: a wider ATR → wider stop. Also drives the volatility-quartile regime bucketing.",
    code: "ATR = avg(max(High−Low, |High−Prev_Close|, |Low−Prev_Close|), 14)",
  },

  obv: {
    label: "On-Balance Volume",
    body: "On-Balance Volume accumulates volume on up bars and subtracts it on down bars. Rising OBV while price consolidates suggests accumulation (smart money buying quietly). OBV divergence from price is a leading signal.",
    code: "OBV += volume if close > prev_close else −volume",
  },

  obvSlope: {
    label: "OBV Slope",
    body: "Rate of change of On-Balance Volume over a short lookback (typically 5–10 bars). Positive slope = net volume inflow accelerating; negative = distribution.",
  },

  vwap: {
    label: "VWAP",
    body: "Volume-Weighted Average Price. The average price paid for each unit of volume traded over the session. Institutions often use VWAP as a benchmark — price above VWAP is bullish intraday; below is bearish.",
    code: "VWAP = Σ(price × volume) / Σ(volume)",
  },

  volZ: {
    label: "Volume Z-score",
    body: "How many standard deviations the current bar's volume is from its rolling mean. A Z-score above +2 indicates a volume spike — often accompanies breakouts or news-driven moves. The signal engine gates some rules when vol Z is abnormally low (thin market).",
    code: "Z = (vol − mean_vol) / std_vol",
  },

  // -------------------------------------------------------------------------
  // Market context
  // -------------------------------------------------------------------------

  fearGreed: {
    label: "Fear & Greed Index",
    body: "Composite market-sentiment gauge (0 = Extreme Fear, 100 = Extreme Greed). Sourced from Alternative.me. Extreme Fear historically precedes recoveries; Extreme Greed precedes corrections. Used as a macro overlay on signal confidence.",
  },

  // -------------------------------------------------------------------------
  // Performance metrics
  // -------------------------------------------------------------------------

  confidenceCalibration: {
    label: "Confidence Calibration",
    body: "A calibrated model produces signals where stated confidence matches realized win rate: a 70%-confident signal should win ~70% of the time. The chart groups signals into confidence bins (x-axis) and plots the actual win rate (bars). Bars close to the diagonal = good calibration.",
  },

  winRate: {
    label: "Win Rate",
    body: "Fraction of closed signals that hit their take-profit before stop-loss. A signal is counted once its outcome is definitively resolved (TP or SL triggered). Does not account for partial closes or risk/reward ratio.",
  },

  tpRate: {
    label: "TP Rate (True-Positive)",
    body: "True-positive rate for a given rule: how often this rule fires on signals that ultimately hit take-profit. Higher = the rule is a good positive predictor. Different from win rate — a rule can have low TP rate if it fires on both winning and losing signals equally.",
  },

  coOccurrence: {
    label: "Rule Co-Occurrence",
    body: "How frequently two rules fire together on the same signal, and the joint TP rate when they do. High co-occurrence with high joint TP rate = the rule pair is a reliable confluence pattern worth weighting up.",
  },

  volatilityQuartile: {
    label: "Volatility Quartile",
    body: "ATR percentile bucket for the bar at signal time. Q1 = calmest 25% of historical bars; Q4 = wildest 25%. Helps identify whether the strategy performs better in calm or volatile regimes.",
  },

  hourBucket: {
    label: "Hour Bucket",
    body: "UTC hour of the bar's close time. Used to identify intraday patterns in signal quality (e.g. low-liquidity Asian session vs. peak London/NY overlap). Heat strip highlights hours with historically above-average win rates.",
  },

  // -------------------------------------------------------------------------
  // Genie / ratification
  // -------------------------------------------------------------------------

  ratificationVerdict: {
    label: "Ratification Verdict",
    body: 'The LLM\'s decision after reviewing the algo\'s candidate signal. "ratify" = LLM agrees and passes the signal through. "downgrade" = LLM disagrees and reduces confidence or flips to hold. "fell back to algo" = LLM call failed, the original algo signal was used unchanged.',
  },

  cacheHit: {
    label: "Cache Hit / Miss",
    body: "Whether the LLM ratification call hit the prompt cache. A cache hit means the system prompt and most of the context were already cached in the Bedrock inference layer, reducing latency by ~80% and cost by ~90%. Miss = full-price call.",
  },

  fellBackToAlgo: {
    label: "Fell back to algo",
    body: "The LLM ratification call failed (timeout, validation error, or Bedrock error) and the original algo candidate signal was used unchanged. This ensures the pipeline never stalls on LLM failures. The ratification record is still written for auditability.",
  },

  // -------------------------------------------------------------------------
  // Health / pipeline
  // -------------------------------------------------------------------------

  quorum: {
    label: "Quorum",
    body: "At least 2 of 3 exchanges (Binance US, Coinbase, Kraken) must agree on a candle close within a tolerance window before the bar is accepted as canonical. Quorum prevents a single exchange outage or data anomaly from generating spurious signals.",
  },

  streamHealth: {
    label: "Stream Health",
    body: "Healthy = last 1-minute bar arrived within 30 seconds. Stale = bar arrived 30–120 seconds ago (possible lag or reconnect). Down = no data for more than 120 seconds (exchange stream offline or Fargate connection dropped).",
  },

  lambdaThrottles: {
    label: "Lambda Throttles",
    body: "Number of Lambda invocations rejected by AWS because the function's reserved concurrency was exhausted. Throttles > 0 means the indicator-handler or signal-blender is falling behind the ingestion rate. Check reserved concurrency settings in the Terraform module.",
  },

  // -------------------------------------------------------------------------
  // News / enrichment
  // -------------------------------------------------------------------------

  phase5aSentiment: {
    label: "Phase 5a Sentiment",
    body: "Sentiment score produced by the Phase 5a enrichment path (ingestion/src/news/enrich.ts). Returns a numeric score (−1 = strongly bearish, +1 = strongly bullish) and a magnitude (0 = weak claim, 1 = strong claim), unlike the earlier path which returned a string label.",
    code: "score ∈ [−1, +1] | magnitude ∈ [0, 1]",
  },

  mentionedPairs: {
    label: "Mentioned Pairs",
    body: "Trading pairs explicitly or implicitly mentioned in the article, as identified by the LLM enrichment step. Used to route news sentiment to the correct pair-level sentiment aggregates. Source-feed currencies are a fallback when the LLM tagging has not run yet.",
  },

  newsStatus: {
    label: "News Status",
    body: 'Pipeline status of a news article. "raw" = fetched from source, pending enrichment. "enriched" = LLM classification complete. "failed" = enrichment threw an error (check logs for that newsId).',
  },

  // -------------------------------------------------------------------------
  // Pipeline page
  // -------------------------------------------------------------------------

  barFreshness: {
    label: "Bar Freshness",
    body: "How old the most recent indicator state is relative to the expected bar cadence. Green = within 1 bar duration; yellow = 1–2x; red = more than 2x overdue. Stale indicators mean the ingestion stream has lagged or the Fargate task restarted.",
  },

  higherTfPoller: {
    label: "Higher-TF Poller",
    body: "The 4h and 1d candles are polled from a REST endpoint rather than streamed tick-by-tick, since those bars close infrequently. The poller runs on a schedule aligned to each timeframe's close time. Stale higher-TF cells usually mean the poller cron is behind or the exchange REST endpoint throttled the request.",
  },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
