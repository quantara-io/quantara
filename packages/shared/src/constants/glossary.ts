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
  /**
   * Optional long-form content shown only on the /admin/glossary page.
   * Not every entry needs this — use it where the short body genuinely
   * isn't enough (indicators, performance metrics, regime concepts).
   */
  longForm?: {
    /** Additional paragraphs shown below the short body on the glossary page. */
    paragraphs: string[];
    /** "Where you'll see this" — dashboard pages that surface this term. */
    seenOn?: { page: string; href: string }[];
    /** Related glossary keys shown as chip links at the bottom of the entry. */
    related?: GlossaryKey[];
  };
}

export const GLOSSARY = {
  // -------------------------------------------------------------------------
  // Technical indicators
  // -------------------------------------------------------------------------

  rsi14: {
    label: "RSI 14",
    body: "Relative Strength Index over 14 bars. Measures the speed and magnitude of recent price changes on a 0–100 scale. Readings above 70 suggest overbought conditions; below 30 suggest oversold.",
    code: "RSI = 100 − 100 / (1 + avg_gain / avg_loss)",
    longForm: {
      paragraphs: [
        "RSI is calculated by separating recent bars into up-closes and down-closes, taking the average gain and average loss over the lookback window (14 bars by default), and computing the ratio RS = avg_gain / avg_loss. The formula then maps that ratio to a 0–100 scale. When avg_loss approaches zero the RSI approaches 100; when avg_gain approaches zero it approaches 0.",
        "Quantara uses RSI 14 as a confluence input, not a standalone trigger. A signal will not fire on RSI alone — it must co-occur with trend (EMA stack) and volume (OBV slope or vol Z) confirmation. The blender assigns higher weight to RSI readings in the 30–70 band when the asset is trending, because extreme readings (>70, <30) in strong trends can persist far longer than mean-reversion traders expect.",
        "RSI tiers: below 30 is flagged as oversold (potential long setup with other confluence); 30–50 is neutral-to-bearish (caution on longs); 50–70 is neutral-to-bullish (valid for long confluence); above 70 is flagged as overbought (only short setups or profit-take alerts). MIN_CONFLUENCE is raised by 0.05 when RSI is above 75 or below 25 to compensate for the higher noise in extended readings.",
      ],
      seenOn: [
        { page: "Market", href: "/market" },
        { page: "Performance", href: "/performance" },
      ],
      related: ["emaStack", "macdHist", "volZ"],
    },
  },

  emaStack: {
    label: "EMA Stack",
    body: "EMA20 > EMA50 > EMA200 is a strong uptrend signature (all shorter averages above the longer ones). When the stack inverts the trend is weakening. Used as a confluence filter — the blender weights long signals higher when the stack aligns bullishly.",
    longForm: {
      paragraphs: [
        "The EMA stack is a three-level trend-alignment check. A fully bullish stack (EMA20 > EMA50 > EMA200) means the short-term average is above the medium-term, which is above the long-term — all time horizons agree the asset is in an uptrend. A partial stack (e.g. EMA20 > EMA50 but EMA50 < EMA200) signals short-term recovery within a longer-term downtrend — valid for counter-trend bounces but not trend-following longs.",
        "Quantara's blender applies a stack score of 0, 0.5, or 1.0 based on how many of the two stack conditions hold (EMA20>EMA50 and EMA50>EMA200). This score is multiplied into the confidence weight for any long signal. Short signals use the inverted condition. A fully inverted stack (EMA20 < EMA50 < EMA200) yields a score of 1.0 for short confluence.",
        "The EMA stack is not a timing signal — it is a filter. A bullish stack with flat price action provides no entry trigger. The stack is most useful combined with a momentum signal (RSI above 50, MACD histogram positive and expanding) and a volume signal (OBV slope positive, vol Z neutral or elevated). The dashboard's Market page highlights the stack alignment for each watched pair in the indicator ribbon.",
      ],
      seenOn: [{ page: "Market", href: "/market" }],
      related: ["ema20", "ema50", "ema200", "rsi14", "macdHist"],
    },
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
    longForm: {
      paragraphs: [
        "MACD uses three exponential moving averages: EMA12 (fast), EMA26 (slow), and EMA9 applied to the MACD line itself (the signal line). The histogram is the difference between the MACD line and its signal line — it oscillates around zero and its direction is a leading indicator of MACD crossovers.",
        "Quantara uses the histogram rather than the raw MACD line because the histogram's slope reveals momentum acceleration before the lines actually cross. A histogram bar that is positive but smaller than the previous bar (decelerating) is an early warning that bullish momentum is fading — useful for tightening stops or reducing confidence in open longs.",
        "Key patterns watched by the signal engine: (1) Histogram crosses from negative to positive — bullish momentum shift. (2) Histogram is positive and each bar is taller than the last — momentum accelerating, good confluence for new longs. (3) Histogram diverges from price (price makes a higher high but histogram makes a lower high) — bearish divergence, reduces long confidence. (4) Histogram at extreme levels (historically high positive or negative absolute value) — mean reversion risk increases.",
      ],
      seenOn: [{ page: "Market", href: "/market" }],
      related: ["rsi14", "emaStack", "bbBands"],
    },
  },

  bbBands: {
    label: "Bollinger Bands",
    body: "Three lines around a 20-bar SMA: upper and lower bands are 2 standard deviations away. Price near the upper band signals expansion / potential overbought; near the lower band signals contraction / potential oversold. Band squeeze (low width) precedes large moves.",
    code: "Upper = SMA20 + 2σ | Lower = SMA20 − 2σ",
    longForm: {
      paragraphs: [
        "Bollinger Bands are a volatility envelope. The width of the bands (upper minus lower, divided by the middle band) is called Bandwidth. When Bandwidth compresses to a multi-month low it indicates the market is coiling — a large move is likely imminent, but the direction is unresolved. The signal engine flags a squeeze condition when Bandwidth falls below its 20th percentile over a 120-bar lookback.",
        "Price touching or exceeding the upper band is not automatically bearish. In strong trending markets price can walk the upper band for many bars. Quantara treats an upper-band touch as a confluence factor for longs (confirming expansion) only when RSI is below 75 and the EMA stack is bullish. Above RSI 75 with an upper-band touch, it flips to a caution flag (overbought extension).",
        "The squeeze-breakout pattern: watch for a squeeze (low Bandwidth) followed by the first bar where price closes outside the bands with volume Z above +1. That is a high-probability breakout setup. The signal engine assigns elevated confidence to breakout signals that emerge from a confirmed squeeze, with the direction determined by whether price breaks above or below the bands.",
      ],
      seenOn: [{ page: "Market", href: "/market" }],
      related: ["atr14", "volZ", "rsi14"],
    },
  },

  atr14: {
    label: "ATR 14",
    body: "Average True Range over 14 bars. Measures raw market volatility in price units (not percent). Used for stop-loss sizing: a wider ATR → wider stop. Also drives the volatility-quartile regime bucketing.",
    code: "ATR = avg(max(High−Low, |High−Prev_Close|, |Low−Prev_Close|), 14)",
    longForm: {
      paragraphs: [
        "True Range accounts for overnight gaps by including the distance from the previous close to the current high or low — not just the intra-bar range. ATR 14 averages the True Range over 14 bars using Wilder's smoothing (equivalent to an EMA with alpha = 1/14).",
        "Stop-loss sizing: Quantara places stops at 1.5× ATR below the entry for longs (2.0× ATR for higher-volatility regime signals). This ensures stops are wide enough to absorb normal intraday noise while still being tight enough to limit downside. As ATR expands in volatile markets, stops widen automatically without any manual override needed.",
        "Volatility-quartile bucketing: ATR is converted to a percentile over a 252-bar (roughly one trading year) rolling window. Q1 = ATR below the 25th percentile (calm market). Q2 = 25th–50th. Q3 = 50th–75th. Q4 = ATR above the 75th percentile (volatile market). The Performance page's regime breakdown uses these quartiles to show whether the strategy works better in calm or volatile conditions.",
      ],
      seenOn: [
        { page: "Market", href: "/market" },
        { page: "Performance", href: "/performance" },
      ],
      related: ["bbBands", "volZ", "volatilityQuartile"],
    },
  },

  obv: {
    label: "On-Balance Volume",
    body: "On-Balance Volume accumulates volume on up bars and subtracts it on down bars. Rising OBV while price consolidates suggests accumulation (smart money buying quietly). OBV divergence from price is a leading signal.",
    code: "OBV += volume if close > prev_close else −volume",
    longForm: {
      paragraphs: [
        "OBV was developed by Joe Granville in 1963. The core idea is that volume precedes price: when large buyers accumulate a position, they must buy gradually to avoid moving the price against themselves. During accumulation, OBV rises while price stays flat or drifts — the divergence reveals that more volume is flowing in on up-bars than out on down-bars.",
        "Quantara uses OBV in two ways: (1) absolute trend — is OBV making higher highs alongside price? If OBV fails to confirm a new price high, the signal engine flags a bearish divergence and reduces long confidence. (2) OBV slope — the short-term rate of change of OBV (see OBV Slope entry) is used as a fast momentum input. A positive slope means net buying pressure is accelerating.",
        "Important limitation: OBV is exchange-specific. Quantara uses the quorum-weighted volume from all three exchanges (Binance US, Coinbase, Kraken) aggregated into a single bar. This makes the OBV more representative of the broader market than a single-exchange feed, but it can differ from OBV computed on any individual exchange's data.",
      ],
      seenOn: [{ page: "Market", href: "/market" }],
      related: ["obvSlope", "volZ", "emaStack"],
    },
  },

  obvSlope: {
    label: "OBV Slope",
    body: "Rate of change of On-Balance Volume over a short lookback (typically 5–10 bars). Positive slope = net volume inflow accelerating; negative = distribution.",
  },

  vwap: {
    label: "VWAP",
    body: "Volume-Weighted Average Price. The average price paid for each unit of volume traded over the session. Institutions often use VWAP as a benchmark — price above VWAP is bullish intraday; below is bearish.",
    code: "VWAP = Σ(price × volume) / Σ(volume)",
    longForm: {
      paragraphs: [
        "VWAP resets at the start of each UTC trading session (midnight UTC for crypto, since crypto markets run 24/7). It accumulates the sum of (typical price × volume) and divides by cumulative volume. Early in the session VWAP can be volatile; by mid-session it stabilises and reflects the true volume-weighted centre of gravity.",
        "Institutional benchmark usage: large funds often execute buy orders when price dips below VWAP (favourable relative to the session average) and sell when price rises above VWAP. This behaviour means VWAP acts as dynamic support during bullish sessions and dynamic resistance during bearish sessions — a self-fulfilling property that makes it a reliable intraday reference.",
        "Quantara uses VWAP as a filter for intraday signal entries. A long signal that fires when price is below VWAP (meaning the entry price is below the session average) gets a small confidence boost; a long signal when price is significantly above VWAP (>0.5% above) gets a small confidence penalty. This avoids chasing entries at the top of an intraday range.",
      ],
      seenOn: [{ page: "Market", href: "/market" }],
      related: ["obv", "volZ", "emaStack"],
    },
  },

  volZ: {
    label: "Volume Z-score",
    body: "How many standard deviations the current bar's volume is from its rolling mean. A Z-score above +2 indicates a volume spike — often accompanies breakouts or news-driven moves. The signal engine gates some rules when vol Z is abnormally low (thin market).",
    code: "Z = (vol − mean_vol) / std_vol",
    longForm: {
      paragraphs: [
        "Volume Z-score normalises volume across time and across pairs so that a spike on BTC/USDT (where absolute volume is enormous) is comparable to a spike on a smaller pair. The rolling mean and standard deviation are computed over a 20-bar window. Z = 0 means exactly average volume; Z = +2 means the bar's volume is two standard deviations above the recent mean — a notable spike.",
        "Gating rules: when vol Z drops below −1.0, several confluence rules are suppressed. Thin-market conditions (low volume relative to the recent average) amplify noise — RSI swings more violently, OBV moves are less meaningful, and spread costs rise. Suppressing rules in thin markets reduces false signals at the cost of missing some valid thin-market setups.",
        "Volume spikes (Z > +2) have a dual interpretation depending on context. On a breakout bar (price closes outside BB bands or above a recent high), a volume spike confirms the move — confidence is increased. On a bar where price barely moves (small range, high volume), a spike suggests churning / distribution — confidence for longs is reduced. The engine distinguishes these two cases using the bar's range-to-ATR ratio.",
      ],
      seenOn: [
        { page: "Market", href: "/market" },
        { page: "Performance", href: "/performance" },
      ],
      related: ["obv", "bbBands", "atr14"],
    },
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
    longForm: {
      paragraphs: [
        "Calibration is about honesty of confidence estimates. An overconfident model says it's 90% sure on signals that only win 60% of the time — it is systematically wrong about its own uncertainty. An underconfident model says it's 55% sure on signals that win 80% of the time — it is leaving money on the table by sizing conservatively.",
        "The calibration chart bins all resolved signals into confidence deciles (e.g. 50–60%, 60–70%, …, 90–100%). For each bin it plots the actual win rate as a bar. A perfectly calibrated model produces bars that lie exactly on the 45-degree diagonal. Bars above the diagonal = actual win rate exceeds stated confidence (the model is conservative / underconfident in that range). Bars below = actual win rate worse than stated confidence (overconfident).",
        "Quantara re-calibrates the confidence weighting coefficients quarterly using Platt scaling on the most recent 90-day resolved signal cohort. If a confidence decile drifts more than 10 percentage points from the diagonal, an alert fires on the Health page. This is a leading indicator of regime change — when the model's learned patterns stop matching market behaviour, calibration degrades first.",
      ],
      seenOn: [{ page: "Performance", href: "/performance" }],
      related: ["winRate", "tpRate", "coOccurrence"],
    },
  },

  winRate: {
    label: "Win Rate",
    body: "Fraction of closed signals that hit their take-profit before stop-loss. A signal is counted once its outcome is definitively resolved (TP or SL triggered). Does not account for partial closes or risk/reward ratio.",
  },

  tpRate: {
    label: "TP Rate (True-Positive)",
    body: "True-positive rate for a given rule: how often this rule fires on signals that ultimately hit take-profit. Higher = the rule is a good positive predictor. Different from win rate — a rule can have low TP rate if it fires on both winning and losing signals equally.",
    longForm: {
      paragraphs: [
        "TP Rate measures the precision of an individual rule as a positive predictor. If rule R fires on 100 signals and 72 of those signals hit take-profit, R's TP rate is 72%. Note: this does not mean 72% of signals with rule R are wins — it means among the subset of signals where R fired, 72% resolved as wins.",
        "TP Rate differs from win rate in scope. Win rate is computed over all signals in a time window. TP Rate is per-rule. A rule can have a high TP rate (very selective, fires rarely but accurately) or a low TP rate (fires on most signals regardless of outcome — not informative as a predictor). Rules with TP rates close to the overall win rate are essentially noise and get down-weighted by the blender.",
        "The per-rule TP rate table on the Performance page sorts rules by TP rate descending and highlights rules that are more than 10 points above the baseline win rate in green (strong positive predictor) and rules more than 5 points below in amber (weak or noise). Rules in amber are candidates for deactivation or threshold-tightening in the next model review cycle.",
      ],
      seenOn: [{ page: "Performance", href: "/performance" }],
      related: ["winRate", "coOccurrence", "confidenceCalibration"],
    },
  },

  coOccurrence: {
    label: "Rule Co-Occurrence",
    body: "How frequently two rules fire together on the same signal, and the joint TP rate when they do. High co-occurrence with high joint TP rate = the rule pair is a reliable confluence pattern worth weighting up.",
    longForm: {
      paragraphs: [
        "Co-occurrence analysis asks: when rule A and rule B both fire on the same signal, does their combination predict outcomes better than either rule alone? If rule A has a TP rate of 68% and rule B has 65%, but when they fire together the joint TP rate is 81%, that pair is a high-value confluence pattern. The blender can apply a synergy bonus to signals where this pair co-fires.",
        "The co-occurrence heat matrix on the Performance page shows all rule pairs. The colour encodes the joint TP rate (green = high, amber = average, red = below baseline). The size of each cell (or a secondary axis) encodes frequency — a high-TP pair that only co-fires 3 times in 90 days is not statistically reliable enough to act on.",
        "Minimum sample threshold: Quantara requires at least 20 joint firings before a co-occurrence pair is considered statistically actionable. Pairs with fewer samples are shown in the matrix with reduced opacity and excluded from the blender's synergy weighting. This prevents overfitting to small-sample coincidences.",
      ],
      seenOn: [{ page: "Performance", href: "/performance" }],
      related: ["tpRate", "winRate", "confidenceCalibration"],
    },
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
