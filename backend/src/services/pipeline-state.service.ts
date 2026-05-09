/**
 * pipeline-state.service.ts
 *
 * Reads the latest indicator state, signals, and sentiment aggregates for
 * every configured pair × timeframe cell and assembles a debug-friendly
 * payload for the admin Pipeline State page.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

import { PAIRS } from "@quantara/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ---------------------------------------------------------------------------
// Table names
// ---------------------------------------------------------------------------

const INDICATOR_STATE_TABLE =
  process.env.TABLE_INDICATOR_STATE ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}indicator-state`;

const SIGNALS_V2_TABLE =
  process.env.TABLE_SIGNALS_V2 ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}signals-v2`;

const SENTIMENT_AGGREGATES_TABLE =
  process.env.TABLE_SENTIMENT_AGGREGATES ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}sentiment-aggregates`;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// `consensus` is a pseudo-timeframe column showing the cross-timeframe rolled-up
// state for the pair: the freshest indicator_state row written under
// `pair#consensus#*` (consensus exchange path inside indicator-handler) and the
// newest signals_v2 row regardless of emitting timeframe.
const PIPELINE_TIMEFRAMES = ["15m", "1h", "4h", "1d", "consensus"] as const;
type PipelineTimeframe = (typeof PIPELINE_TIMEFRAMES)[number];

// indicator-handler writes indicator_state rows with `exchange: "consensus"`
// only — never per-exchange (no `binanceus`/`kraken`/`coinbase` rows). Using
// any other exchange here returns empty cells.
const DEFAULT_EXCHANGE = "consensus";
const CONSENSUS_EXCHANGE = "consensus";

/**
 * sentiment_aggregates is keyed by base symbol ("BTC", "ETH", …) — the
 * `mentionedPairs` field from the news enrichment LLM, which uses bare
 * symbols. Trading pairs in the rest of the system are "BTC/USDT" form;
 * convert before reading.
 */
function pairToBaseSymbol(pair: string): string {
  const [base] = pair.split("/");
  return base ?? pair;
}

/** Timeframe durations in milliseconds — used for ageSeconds colour thresholds. */
export const TF_DURATION_MS: Record<PipelineTimeframe, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  // No fixed cadence — pick the slowest tf bound so the cell never goes red on
  // age alone.
  consensus: 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface IndicatorStateCell {
  barsSinceStart: number | null;
  rsi14: number | null;
  ema50: number | null;
  ema200: number | null;
  macdLine: number | null;
  atr14: number | null;
  asOf: string | null;
  ageSeconds: number | null;
  /** Full raw item — forwarded as-is for the side-panel JSON view. */
  raw: Record<string, unknown> | null;
}

export interface SignalCell {
  type: string | null;
  confidence: number | null;
  ratificationStatus: string | null;
  interpretationText: string | null;
  closeTime: string | null;
  ageSeconds: number | null;
  /** Full raw item — forwarded as-is for the side-panel JSON view. */
  raw: Record<string, unknown> | null;
  /** Up to 5 most-recent items from the same (pair × tf) for ratification history. */
  recentHistory: Record<string, unknown>[];
}

export interface SentimentWindowCell {
  score: number | null;
  magnitude: number | null;
  articleCount: number | null;
  updatedAt: string | null;
  ageSeconds: number | null;
}

export interface PipelineCell {
  pair: string;
  timeframe: PipelineTimeframe;
  indicator: IndicatorStateCell;
  signal: SignalCell;
  sentiment4h: SentimentWindowCell;
  sentiment24h: SentimentWindowCell;
}

export interface PipelineStateResult {
  cells: PipelineCell[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Fetchers (each returns null on missing / error — never throws)
// ---------------------------------------------------------------------------

async function fetchIndicatorState(
  pair: string,
  exchange: string,
  timeframe: PipelineTimeframe,
): Promise<IndicatorStateCell> {
  try {
    // For the `consensus` pseudo-timeframe column, indicator-handler stamps
    // consensus-exchange rows per real timeframe. We pick the 15m row as the
    // representative "current consensus state" since 15m updates fastest.
    // (Per-tf consensus internals are still visible in the standard columns
    // when the worker rolls those out separately.)
    const pk =
      timeframe === "consensus"
        ? `${pair}#${CONSENSUS_EXCHANGE}#15m`
        : `${pair}#${exchange}#${timeframe}`;
    const result = await client.send(
      new QueryCommand({
        TableName: INDICATOR_STATE_TABLE,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": pk },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    const item = result.Items?.[0] as Record<string, unknown> | undefined;
    if (!item) return emptyIndicator();

    const asOfMs = (item.asOfMs as number | undefined) ?? null;
    const ageSeconds = asOfMs !== null ? Math.round((Date.now() - asOfMs) / 1000) : null;

    return {
      barsSinceStart: (item.barsSinceStart as number | null) ?? null,
      rsi14: (item.rsi14 as number | null) ?? null,
      ema50: (item.ema50 as number | null) ?? null,
      ema200: (item.ema200 as number | null) ?? null,
      macdLine: (item.macdLine as number | null) ?? null,
      atr14: (item.atr14 as number | null) ?? null,
      asOf: asOfMs !== null ? new Date(asOfMs).toISOString() : null,
      ageSeconds,
      raw: item,
    };
  } catch {
    return emptyIndicator();
  }
}

function emptyIndicator(): IndicatorStateCell {
  return {
    barsSinceStart: null,
    rsi14: null,
    ema50: null,
    ema200: null,
    macdLine: null,
    atr14: null,
    asOf: null,
    ageSeconds: null,
    raw: null,
  };
}

async function fetchSignal(pair: string, timeframe: PipelineTimeframe): Promise<SignalCell> {
  try {
    // Fetch latest 5 items (newest first) for the side-panel history view.
    // For the `consensus` column, drop the tfPrefix filter so the freshest
    // signal across ANY emitting timeframe is surfaced.
    const result =
      timeframe === "consensus"
        ? await client.send(
            new QueryCommand({
              TableName: SIGNALS_V2_TABLE,
              KeyConditionExpression: "#pair = :pair",
              ExpressionAttributeNames: { "#pair": "pair" },
              ExpressionAttributeValues: { ":pair": pair },
              ScanIndexForward: false,
              Limit: 5,
            }),
          )
        : await client.send(
            new QueryCommand({
              TableName: SIGNALS_V2_TABLE,
              KeyConditionExpression: "#pair = :pair AND begins_with(#sk, :tfPrefix)",
              ExpressionAttributeNames: { "#pair": "pair", "#sk": "sk" },
              ExpressionAttributeValues: { ":pair": pair, ":tfPrefix": `${timeframe}#` },
              ScanIndexForward: false,
              Limit: 5,
            }),
          );

    const items = (result.Items ?? []) as Record<string, unknown>[];
    if (items.length === 0) return emptySignal();

    const latest = items[0];
    const asOfMs = (latest.asOf as number | undefined) ?? null;
    const ageSeconds = asOfMs !== null ? Math.round((Date.now() - asOfMs) / 1000) : null;

    // interpretation.text — the signal store materialises this via buildInterpretation;
    // it may be stored in perTimeframe or at top level depending on version.
    // We pull from ratificationVerdict.reasoning as fallback.
    const rawInterpretation = ((latest.interpretation as Record<string, unknown> | undefined)
      ?.text ??
      (latest.ratificationVerdict as Record<string, unknown> | undefined)?.reasoning ??
      null) as string | null;

    const interpretationText = rawInterpretation !== null ? rawInterpretation.slice(0, 160) : null;

    return {
      type: (latest.type as string | null) ?? null,
      confidence: (latest.confidence as number | null) ?? null,
      ratificationStatus: (latest.ratificationStatus as string | null) ?? null,
      interpretationText,
      closeTime: asOfMs !== null ? new Date(asOfMs).toISOString() : null,
      ageSeconds,
      raw: latest,
      recentHistory: items,
    };
  } catch {
    return emptySignal();
  }
}

function emptySignal(): SignalCell {
  return {
    type: null,
    confidence: null,
    ratificationStatus: null,
    interpretationText: null,
    closeTime: null,
    ageSeconds: null,
    raw: null,
    recentHistory: [],
  };
}

async function fetchSentiment(pair: string, window: "4h" | "24h"): Promise<SentimentWindowCell> {
  try {
    // sentiment_aggregates pk is the base symbol (`BTC`), not the trading
    // pair (`BTC/USDT`). The aggregator is fed by `mentionedPairs` from the
    // news enrichment LLM, which produces bare symbols.
    const result = await client.send(
      new GetCommand({
        TableName: SENTIMENT_AGGREGATES_TABLE,
        Key: { pair: pairToBaseSymbol(pair), window },
      }),
    );
    const item = result.Item as Record<string, unknown> | undefined;
    if (!item) return emptySentiment();

    const computedAt = (item.computedAt as string | undefined) ?? null;
    const updatedAtMs = computedAt !== null ? new Date(computedAt).getTime() : null;
    const ageSeconds = updatedAtMs !== null ? Math.round((Date.now() - updatedAtMs) / 1000) : null;

    return {
      score: (item.meanScore as number | null) ?? null,
      magnitude: (item.meanMagnitude as number | null) ?? null,
      articleCount: (item.articleCount as number | null) ?? null,
      updatedAt: computedAt,
      ageSeconds,
    };
  } catch {
    return emptySentiment();
  }
}

function emptySentiment(): SentimentWindowCell {
  return {
    score: null,
    magnitude: null,
    articleCount: null,
    updatedAt: null,
    ageSeconds: null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the full pipeline state for all (or one) pair × timeframe cells.
 *
 * Sentiment is per-pair (not per-pair-per-tf), so it's fetched ONCE per pair
 * and reused across the per-tf cells. With 5 pairs × 5 timeframes that's
 * 5 sentiment-aggregate GETs per window per request instead of 25 — matters
 * at the 5-second poll cadence under multiple admin sessions.
 *
 * Empty cells (no data) are returned with null fields rather than omitted,
 * so the frontend can render "—" without error.
 */
export async function getPipelineState(filterPair?: string): Promise<PipelineStateResult> {
  const pairs =
    filterPair !== undefined
      ? (PAIRS as readonly string[]).filter((p) => p === filterPair)
      : (PAIRS as readonly string[]);

  // Per-pair sentiment fetched once and shared across all timeframe cells.
  const perPairSentiment = await Promise.all(
    pairs.map(async (pair) => {
      const [sentiment4h, sentiment24h] = await Promise.all([
        fetchSentiment(pair, "4h"),
        fetchSentiment(pair, "24h"),
      ]);
      return { pair, sentiment4h, sentiment24h };
    }),
  );
  const sentimentByPair = new Map(perPairSentiment.map((s) => [s.pair, s]));

  // Fan out per-tf indicator + signal queries concurrently across all cells.
  const cellPromises: Promise<PipelineCell>[] = [];

  for (const pair of pairs) {
    const sentiment = sentimentByPair.get(pair);
    for (const timeframe of PIPELINE_TIMEFRAMES) {
      cellPromises.push(
        (async (): Promise<PipelineCell> => {
          const [indicator, signal] = await Promise.all([
            fetchIndicatorState(pair, DEFAULT_EXCHANGE, timeframe),
            fetchSignal(pair, timeframe),
          ]);
          return {
            pair,
            timeframe,
            indicator,
            signal,
            sentiment4h: sentiment?.sentiment4h ?? emptySentiment(),
            sentiment24h: sentiment?.sentiment24h ?? emptySentiment(),
          };
        })(),
      );
    }
  }

  const cells = await Promise.all(cellPromises);

  return { cells, generatedAt: new Date().toISOString() };
}
