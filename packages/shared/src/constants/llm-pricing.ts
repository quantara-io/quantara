/**
 * LLM pricing constants — single source of truth for cost calculations.
 *
 * Used by:
 * - `ingestion/src/news/enrich.ts` (token-counter writers, future displays)
 * - `backend/src/services/admin.service.ts` (`getNewsUsage` cost aggregation)
 *
 * Update when the underlying provider price list changes. The accompanying
 * `MODEL_TAG` should match what callers stamp on `RecordLlmUsage.modelTag`
 * so cost-per-model breakdowns join up.
 */

/** Anthropic Claude Haiku 4.5 on Bedrock — input price per 1M tokens, USD. */
export const HAIKU_INPUT_PRICE_PER_M = 0.8;

/** Anthropic Claude Haiku 4.5 on Bedrock — output price per 1M tokens, USD. */
export const HAIKU_OUTPUT_PRICE_PER_M = 4.0;

/** Stable tag stored on `RecordLlmUsage.modelTag` for Haiku pricing aggregation. */
export const HAIKU_MODEL_TAG = "anthropic.claude-haiku-4-5";
