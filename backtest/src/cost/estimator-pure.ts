/**
 * Pure cost-estimator math — Phase 4 follow-up.
 *
 * Extracted from estimator.ts so consumers outside the backtest workspace
 * (specifically the backend admin route in `backend/src/routes/admin.ts`)
 * can share the SAME pricing constants, multi-TF multiplier, and gate-rate
 * handling without pulling in the engine / DDB / ingestion deps.
 *
 * The DDB-backed `DdbRatificationsStore` and `estimateRatificationCost()`
 * still live in estimator.ts and re-use the constants below.
 *
 * No imports — this file is intentionally dependency-free so it stays cheap
 * to bundle into the API Lambda.
 */

// ---------------------------------------------------------------------------
// Pricing constants (Anthropic Bedrock pricing, 2026-Q1).
// MUST stay in sync with admin-debug.service.ts. The estimator and the
// inline cost preview in admin/src/pages/BacktestNew.tsx import these
// directly via @quantara/backtest so a price change is one-file-edit.
// ---------------------------------------------------------------------------

/** Haiku 4.5 input price per 1M tokens, USD. */
export const HAIKU_INPUT_PRICE_PER_M = 0.25;
/** Haiku 4.5 output price per 1M tokens, USD. */
export const HAIKU_OUTPUT_PRICE_PER_M = 1.25;
/** Sonnet 4.6 input price per 1M tokens, USD. */
export const SONNET_INPUT_PRICE_PER_M = 3.0;
/** Sonnet 4.6 output price per 1M tokens, USD. */
export const SONNET_OUTPUT_PRICE_PER_M = 15.0;

/** Estimated tokens per ratification call (from observed force-ratification call shape). */
export const EST_INPUT_TOKENS_PER_CALL = 700;
export const EST_OUTPUT_TOKENS_PER_CALL = 150;

/** Estimated Bedrock invocation latency per call (ms). */
export const EST_LATENCY_MS_PER_CALL = 3_000;

/** Default gate rate when the ratifications table is empty or unreachable. */
export const DEFAULT_GATE_RATE = 0.004; // 0.4%

/** Sanity bounds for gated rate [floor, ceiling]. */
export const GATE_RATE_FLOOR = 0.001;
export const GATE_RATE_CEILING = 0.5;

/** Milliseconds per bar for each signal TF. */
export const TF_MS: Record<string, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/**
 * Number of signal TFs that get re-scored at every emitting-TF boundary in
 * multi-TF blend mode. Single-TF runs use 1.
 */
export const SIGNAL_TF_COUNT_MULTI_TF = 4;

export type RatificationModel = "haiku" | "sonnet";

export interface RatificationCostEstimate {
  /** Number of candle closes in the eval window (across all signal TFs). */
  closes: number;
  /** Fraction of closes that are expected to reach the LLM gate. */
  gatedRate: number;
  /** Estimated number of Bedrock invocations. */
  estimatedCalls: number;
  estimatedTokens: { input: number; output: number };
  /** Estimated total cost in USD. */
  estimatedCostUsd: number;
  /** Estimated total latency in ms (sum of serial call latencies). */
  estimatedLatencyMs: number;
  model: RatificationModel;
  pricingSource: string;
}

export interface ComputeEstimateInput {
  /** Window start (ms epoch). */
  fromMs: number;
  /** Window end (ms epoch). */
  toMs: number;
  /** Emitting timeframe (defaults to 15m if missing). */
  timeframe: string;
  /** Multi-TF blend? Defaults to false (single-TF). */
  multiTf?: boolean;
  /** Gate rate to use. Caller can pre-compute from DDB query, or use DEFAULT_GATE_RATE. */
  gatedRate?: number;
  /** Ratification model — drives pricing. */
  model: RatificationModel;
}

/**
 * Pure (no I/O) cost-estimate computation. Both `estimateRatificationCost()`
 * (DDB-backed) and the backend admin route call this — they only differ in
 * how they source `gatedRate`.
 */
export function computeEstimateMath(input: ComputeEstimateInput): RatificationCostEstimate {
  const periodMs = input.toMs - input.fromMs;
  if (periodMs <= 0) {
    return zeroEstimate(input.model);
  }

  const multiTf = input.multiTf === true;
  const emittingTfMs = multiTf
    ? (TF_MS["15m"] ?? 900_000)
    : (TF_MS[input.timeframe] ?? TF_MS["15m"] ?? 900_000);
  const bars = Math.floor(periodMs / emittingTfMs);
  const closes = bars * (multiTf ? SIGNAL_TF_COUNT_MULTI_TF : 1);

  // Clamp gate rate to sanity bounds.
  let gatedRate = input.gatedRate ?? DEFAULT_GATE_RATE;
  gatedRate = Math.max(GATE_RATE_FLOOR, Math.min(GATE_RATE_CEILING, gatedRate));

  const estimatedCalls = Math.round(closes * gatedRate);
  const inputTokens = estimatedCalls * EST_INPUT_TOKENS_PER_CALL;
  const outputTokens = estimatedCalls * EST_OUTPUT_TOKENS_PER_CALL;

  const inputPricePerM =
    input.model === "haiku" ? HAIKU_INPUT_PRICE_PER_M : SONNET_INPUT_PRICE_PER_M;
  const outputPricePerM =
    input.model === "haiku" ? HAIKU_OUTPUT_PRICE_PER_M : SONNET_OUTPUT_PRICE_PER_M;

  const estimatedCostUsd =
    (inputTokens / 1_000_000) * inputPricePerM + (outputTokens / 1_000_000) * outputPricePerM;

  const estimatedLatencyMs = estimatedCalls * EST_LATENCY_MS_PER_CALL;

  return {
    closes,
    gatedRate,
    estimatedCalls,
    estimatedTokens: { input: inputTokens, output: outputTokens },
    estimatedCostUsd,
    estimatedLatencyMs,
    model: input.model,
    pricingSource: "code-comment-as-of-2026-Q1",
  };
}

export function zeroEstimate(model: RatificationModel): RatificationCostEstimate {
  return {
    closes: 0,
    gatedRate: DEFAULT_GATE_RATE,
    estimatedCalls: 0,
    estimatedTokens: { input: 0, output: 0 },
    estimatedCostUsd: 0,
    estimatedLatencyMs: 0,
    model,
    pricingSource: "code-comment-as-of-2026-Q1",
  };
}
