/**
 * ratify.ts — LLM ratification entry point (Phase 6a).
 *
 * Single entry point for consumers. Takes a BlendedSignal + context, gates
 * cost per §7.5, checks cache per §7.6, calls Sonnet 4.6, validates per §7.7,
 * and persists a RatificationRecord per §7.9.
 *
 * Model: claude-sonnet-4-6 (pinned per issue spec)
 *
 * Design: §7 of docs/SIGNALS_AND_RISK.md
 */

import Anthropic from "@anthropic-ai/sdk";
import type { BlendedSignal, Timeframe } from "@quantara/shared";
import type { SentimentBundle } from "../news/bundle.js";
import type { TimeframeVote } from "@quantara/shared";
import type { ExchangePricePoint } from "@quantara/shared";
import { shouldInvokeRatification } from "./gating.js";
import { deriveCacheKey, getCachedRatification, putCachedRatification } from "./cache.js";
import {
  SYSTEM_PROMPT,
  SYSTEM_HASH,
  buildUserMessage,
  hashUserMessage,
  parseRatificationResponse,
} from "./prompt.js";
import { validateRatification } from "./validate.js";
import {
  putRatificationRecord,
  type InvokedReason,
} from "../lib/ratification-store.js";

// ---------------------------------------------------------------------------
// Model config (pinned per issue spec)
// ---------------------------------------------------------------------------

const RATIFICATION_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optional whale summary — populated when Phase 8/9 land. */
export interface WhaleSummary {
  netFlowUsd: number;
  largeTransactionCount: number;
  sentiment: "bullish" | "bearish" | "neutral";
}

export interface RatifyContext {
  pair: string;
  candidate: BlendedSignal;
  perTimeframe: Record<Timeframe, TimeframeVote | null>;
  sentiment: SentimentBundle;
  whaleSummary?: WhaleSummary | null;
  pricePoints: ExchangePricePoint[];
  fearGreed: { value: number; trend24h: number };
}

export interface RatifyResult {
  signal: BlendedSignal;
  fellBackToAlgo: boolean;
  cacheHit: boolean;
}

// ---------------------------------------------------------------------------
// Validation failure counter (§7.9 metric)
// ---------------------------------------------------------------------------

let _validationFailureCount = 0;

/** Returns the total validation failure count since process start. Useful for monitoring. */
export function getValidationFailureCount(): number {
  return _validationFailureCount;
}

/** Reset counter — intended for tests only. */
export function _resetValidationFailureCount(): void {
  _validationFailureCount = 0;
}

// ---------------------------------------------------------------------------
// Anthropic client (module-scoped, re-used across calls)
// ---------------------------------------------------------------------------

let _anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic();
  }
  return _anthropicClient;
}

// ---------------------------------------------------------------------------
// Core ratification function
// ---------------------------------------------------------------------------

/**
 * Ratify a blended signal.
 *
 * Behavior:
 *   1. Run gating per §7.5. If gate fails: return candidate unchanged + persist skipped record.
 *   2. Compute cache key per §7.6. Cache hit (< 5 min): return cached ratified signal.
 *   3. Cache miss: build prompt → Sonnet 4.6 call → parse JSON → validate per §7.7.
 *   4. On validation failure: fall back to candidate, log, increment failure metric.
 *   5. Persist RatificationRecord regardless of outcome.
 *   6. Return the ratified or fallback signal.
 */
export async function ratifySignal(context: RatifyContext): Promise<RatifyResult> {
  const invokedAt = new Date().toISOString();
  const startMs = Date.now();

  // ------------------------------------------------------------------
  // Step 1: Cost gating
  // ------------------------------------------------------------------
  const gate = await shouldInvokeRatification(context);
  if (!gate.shouldInvoke) {
    console.log(`[Ratifier] Skipped for ${context.pair}: ${gate.reason}`);
    // Persist a skipped record (no cost, no LLM call)
    await putRatificationRecord({
      pair: context.pair,
      timeframe: context.candidate.emittingTimeframe,
      algoCandidate: context.candidate,
      llmRequest: { model: RATIFICATION_MODEL, systemHash: SYSTEM_HASH, userJsonHash: "" },
      llmRawResponse: null,
      cacheHit: false,
      validation: { ok: false, reason: `gated: ${gate.reason}` },
      ratified: null,
      fellBackToAlgo: true,
      latencyMs: Date.now() - startMs,
      costUsd: 0,
      invokedReason: "news",
      invokedAt,
    });
    return { signal: context.candidate, fellBackToAlgo: true, cacheHit: false };
  }

  // Determine invokedReason from the gate reason string
  const invokedReason = gateReasonToInvokedReason(gate.reason);

  // ------------------------------------------------------------------
  // Step 2: Cache lookup
  // ------------------------------------------------------------------
  const cacheKey = deriveCacheKey(context);
  const cached = await getCachedRatification(cacheKey);
  if (cached !== null) {
    console.log(`[Ratifier] Cache hit for ${context.pair}`);
    await putRatificationRecord({
      pair: context.pair,
      timeframe: context.candidate.emittingTimeframe,
      algoCandidate: context.candidate,
      llmRequest: { model: RATIFICATION_MODEL, systemHash: SYSTEM_HASH, userJsonHash: cacheKey },
      llmRawResponse: null,
      cacheHit: true,
      validation: { ok: true },
      ratified: cached,
      fellBackToAlgo: false,
      latencyMs: Date.now() - startMs,
      costUsd: 0,
      invokedReason,
      invokedAt,
    });
    return { signal: cached, fellBackToAlgo: false, cacheHit: true };
  }

  // ------------------------------------------------------------------
  // Step 3: LLM call
  // ------------------------------------------------------------------
  const userJson = buildUserMessage(context);
  const userJsonHash = hashUserMessage(userJson);

  let llmRawResponse: object | null = null;
  let parsedResponse: ReturnType<typeof parseRatificationResponse> = null;
  let costUsd = 0;
  let llmTextContent: string | null = null;

  // Isolate the API call so JSON.parse errors are handled separately below
  try {
    const client = getClient();
    const response = await client.messages.create({
      model: RATIFICATION_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userJson }],
    });

    // Compute cost: Sonnet 4.6 = $3/1M input, $15/1M output
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

    const block = response.content.find((b: { type: string }) => b.type === "text");
    if (block && block.type === "text") {
      llmTextContent = (block as { type: "text"; text: string }).text;
    }
  } catch (err) {
    console.error(`[Ratifier] LLM call failed for ${context.pair}:`, err);
    // Fall back to algo on any API error
    await putRatificationRecord({
      pair: context.pair,
      timeframe: context.candidate.emittingTimeframe,
      algoCandidate: context.candidate,
      llmRequest: { model: RATIFICATION_MODEL, systemHash: SYSTEM_HASH, userJsonHash },
      llmRawResponse: null,
      cacheHit: false,
      validation: { ok: false, reason: "llm_api_error" },
      ratified: null,
      fellBackToAlgo: true,
      latencyMs: Date.now() - startMs,
      costUsd: 0,
      invokedReason,
      invokedAt,
    });
    return { signal: context.candidate, fellBackToAlgo: true, cacheHit: false };
  }

  // Parse JSON response outside the API try/catch so JSON errors are counted as schema failures
  if (llmTextContent) {
    try {
      const raw = JSON.parse(llmTextContent) as unknown;
      llmRawResponse = typeof raw === "object" && raw !== null ? (raw as object) : { raw };
      parsedResponse = parseRatificationResponse(raw);
    } catch {
      // Invalid JSON — treated as schema parse failure below (parsedResponse stays null)
      llmRawResponse = { raw: llmTextContent };
    }
  }

  // ------------------------------------------------------------------
  // Step 4: Validate
  // ------------------------------------------------------------------
  if (!parsedResponse) {
    _validationFailureCount++;
    console.warn(`[Ratifier] Schema parse failed for ${context.pair}`, llmRawResponse);
    await putRatificationRecord({
      pair: context.pair,
      timeframe: context.candidate.emittingTimeframe,
      algoCandidate: context.candidate,
      llmRequest: { model: RATIFICATION_MODEL, systemHash: SYSTEM_HASH, userJsonHash },
      llmRawResponse,
      cacheHit: false,
      validation: { ok: false, reason: "schema_parse_failed" },
      ratified: null,
      fellBackToAlgo: true,
      latencyMs: Date.now() - startMs,
      costUsd,
      invokedReason,
      invokedAt,
    });
    return { signal: context.candidate, fellBackToAlgo: true, cacheHit: false };
  }

  const validation = validateRatification(context.candidate, parsedResponse);
  if (!validation.ok) {
    _validationFailureCount++;
    console.warn(`[Ratifier] Validation failed for ${context.pair}: ${validation.reason}`, llmRawResponse);
    await putRatificationRecord({
      pair: context.pair,
      timeframe: context.candidate.emittingTimeframe,
      algoCandidate: context.candidate,
      llmRequest: { model: RATIFICATION_MODEL, systemHash: SYSTEM_HASH, userJsonHash },
      llmRawResponse,
      cacheHit: false,
      validation: { ok: false, reason: validation.reason },
      ratified: null,
      fellBackToAlgo: true,
      latencyMs: Date.now() - startMs,
      costUsd,
      invokedReason,
      invokedAt,
    });
    return { signal: context.candidate, fellBackToAlgo: true, cacheHit: false };
  }

  // ------------------------------------------------------------------
  // Step 5 & 6: Persist + return success
  // ------------------------------------------------------------------
  const ratified = validation.ratified;
  await putCachedRatification(cacheKey, ratified);

  await putRatificationRecord({
    pair: context.pair,
    timeframe: context.candidate.emittingTimeframe,
    algoCandidate: context.candidate,
    llmRequest: { model: RATIFICATION_MODEL, systemHash: SYSTEM_HASH, userJsonHash },
    llmRawResponse,
    cacheHit: false,
    validation: { ok: true },
    ratified,
    fellBackToAlgo: false,
    latencyMs: Date.now() - startMs,
    costUsd,
    invokedReason,
    invokedAt,
  });

  console.log(`[Ratifier] Ratified ${context.pair}: ${ratified.type} conf=${ratified.confidence.toFixed(3)}`);
  return { signal: ratified, fellBackToAlgo: false, cacheHit: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gateReasonToInvokedReason(gateReason: string): InvokedReason {
  if (gateReason.includes("news") && gateReason.includes("vol") && gateReason.includes("fng")) {
    return "all";
  }
  if (gateReason.includes("vol")) return "vol";
  if (gateReason.includes("fng")) return "fng-shift";
  return "news";
}
