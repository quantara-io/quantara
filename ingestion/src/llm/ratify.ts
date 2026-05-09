/**
 * ratify.ts — LLM ratification entry point (Phase 6a / Phase B1).
 *
 * Phase B1 changes:
 *   - Uses Anthropic streaming API (messages.stream) instead of create.
 *   - Returns the ratified signal synchronously (algo-first) for stage-1 write,
 *     plus a promise (`ratificationComplete`) that resolves when the LLM stream
 *     finishes and the stage-2 DDB UPDATE is done.
 *   - Callers must `await ratificationComplete` (or fire-and-forget if stage-1
 *     write already happened and stage-2 can be async).
 *
 * Single entry point for consumers. Takes a BlendedSignal + context, gates
 * cost per §7.5, checks cache per §7.6, calls Sonnet 4.6 (streaming), validates
 * per §7.7, and persists a RatificationRecord per §7.9.
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
import { putRatificationRecord, type InvokedReason } from "../lib/ratification-store.js";

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

/**
 * Phase B1: ratifySignal returns the stage-1 signal synchronously plus a
 * deferred `kickoffRatification` callback that the caller invokes ONLY
 * after the stage-1 DDB Put commits. This eliminates the race where a
 * fast-failing LLM stream could fire its onStage2 UPDATE before the
 * stage-1 row exists (resulting in a no-op UPDATE that silently leaves
 * the row stuck on "pending").
 *
 * `ratificationStatus` on the returned signal indicates:
 *   - "pending"       → LLM call needed; caller writes stage-1 then invokes
 *                        kickoffRatification() to start the stream.
 *   - "not-required"  → no LLM call needed; stage-1 IS the final state.
 *   - "ratified"      → cache hit; signal is already final (no stage-2).
 *
 * `kickoffRatification` is non-undefined ONLY when `ratificationStatus`
 * is "pending". It returns the same Promise<void> the prior `ratificationComplete`
 * field returned: resolves when the LLM stream + stage-2 callback finish;
 * never rejects (errors are logged + fallback applied).
 *
 * `fellBackToAlgo` reflects only the synchronous pre-stream state:
 *   - true  → gated out before LLM call (stage-1 is the final algo signal)
 *   - false → cache hit OR pending stream still in flight
 *
 * For the fellBackToAlgo state of the post-stream verdict, observe the
 * `ratificationStatus` on the Stage2Payload when onStage2 fires — the
 * fallback path emits status="ratified" with algoVerdict equal to the
 * algo candidate.
 */
export interface RatifyResult {
  signal: BlendedSignal;
  fellBackToAlgo: boolean;
  cacheHit: boolean;
  /**
   * Caller invokes this after stage-1 Put commits. Returns a promise that
   * resolves when the LLM stream + stage-2 callback finish. Undefined when
   * no LLM call is needed (gated, cache hit).
   */
  kickoffRatification?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Stage-2 callback type
// ---------------------------------------------------------------------------

/** Payload supplied to the stage-2 callback once the LLM verdict is ready. */
export interface Stage2Payload {
  ratificationStatus: "ratified" | "downgraded";
  ratificationVerdict: { type: "buy" | "sell" | "hold"; confidence: number; reasoning: string };
  algoVerdict: { type: "buy" | "sell" | "hold"; confidence: number; reasoning: string } | null;
  /** The final signal after ratification (updated fields) */
  finalSignal: BlendedSignal;
}

export type OnStage2Callback = (payload: Stage2Payload) => Promise<void>;

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
 * Ratify a blended signal (Phase B1 two-stage version).
 *
 * Behavior:
 *   1. Run gating per §7.5. If gate fails: return candidate with
 *      ratificationStatus="not-required" + resolved ratificationComplete.
 *   2. Compute cache key per §7.6. Cache hit: return cached signal with
 *      ratificationStatus="ratified" + resolved ratificationComplete.
 *   3. Cache miss: return candidate with ratificationStatus="pending" +
 *      ratificationComplete promise that:
 *        a. Streams LLM response (claude-sonnet-4-6).
 *        b. Parses + validates verdict.
 *        c. On success: calls onStage2 with verdict, updates cache, stores record.
 *        d. On any failure: calls onStage2 with algo-as-fallback (graceful).
 *
 * @param context   - Signal + context for the LLM.
 * @param onStage2  - Callback invoked when the LLM verdict is ready (or failed).
 *                    Only called when ratificationStatus is "pending".
 *                    The caller should perform the stage-2 DDB UPDATE here.
 */
export async function ratifySignal(
  context: RatifyContext,
  onStage2?: OnStage2Callback,
): Promise<RatifyResult> {
  const invokedAt = new Date().toISOString();
  const startMs = Date.now();

  // ------------------------------------------------------------------
  // Step 1: Cost gating
  // ------------------------------------------------------------------
  const gate = await shouldInvokeRatification(context);
  if (!gate.shouldInvoke) {
    console.log(`[Ratifier] Skipped for ${context.pair}: ${gate.reason}`);
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
      // Derive from gate.reason rather than hardcoding "news" — otherwise
      // metrics conflate confidence-floor / rate-limit / daily-cap skips
      // with news-driven invocations.
      invokedReason: gateReasonToInvokedReason(gate.reason),
      invokedAt,
    });
    const signal: BlendedSignal = { ...context.candidate, ratificationStatus: "not-required" };
    return {
      signal,
      fellBackToAlgo: true,
      cacheHit: false,
    };
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
    const signal: BlendedSignal = { ...cached, ratificationStatus: "ratified" };
    return {
      signal,
      fellBackToAlgo: false,
      cacheHit: true,
    };
  }

  // ------------------------------------------------------------------
  // Step 3: Return algo signal as stage-1 (pending) + a kickoffRatification
  // callback. The LLM stream is NOT started here — the caller invokes
  // kickoffRatification ONLY after the stage-1 DDB Put commits. This
  // guarantees that any onStage2 UPDATE issued by the stream targets a
  // row that exists.
  // ------------------------------------------------------------------
  const algoSignal: BlendedSignal = { ...context.candidate, ratificationStatus: "pending" };
  const userJson = buildUserMessage(context);
  const userJsonHash = hashUserMessage(userJson);

  return {
    signal: algoSignal,
    fellBackToAlgo: false,
    cacheHit: false,
    kickoffRatification: () =>
      runLlmStream({
        context,
        cacheKey,
        userJson,
        userJsonHash,
        invokedReason,
        invokedAt,
        startMs,
        onStage2,
      }),
  };
}

// ---------------------------------------------------------------------------
// Internal: LLM stream execution (async, returns a promise)
// ---------------------------------------------------------------------------

interface LlmStreamParams {
  context: RatifyContext;
  cacheKey: string;
  userJson: string;
  userJsonHash: string;
  invokedReason: InvokedReason;
  invokedAt: string;
  startMs: number;
  onStage2?: OnStage2Callback;
}

async function runLlmStream(params: LlmStreamParams): Promise<void> {
  const { context, cacheKey, userJson, userJsonHash, invokedReason, invokedAt, startMs, onStage2 } =
    params;

  const algoVerdict = {
    type: context.candidate.type,
    confidence: context.candidate.confidence,
    reasoning: context.candidate.rulesFired.join(", ") || "algo rules",
  };

  // ------------------------------------------------------------------
  // LLM call (streaming)
  // ------------------------------------------------------------------
  let llmRawResponse: object | null = null;
  let parsedResponse: ReturnType<typeof parseRatificationResponse> = null;
  let costUsd = 0;
  let llmTextContent: string | null = null;

  try {
    const client = getClient();
    const stream = client.messages.stream({
      model: RATIFICATION_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userJson }],
    });

    // Collect streamed text chunks
    let accumulated = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        accumulated += event.delta.text;
      }
    }

    // Get final message for usage stats
    const finalMessage = await stream.finalMessage();
    const inputTokens = finalMessage.usage?.input_tokens ?? 0;
    const outputTokens = finalMessage.usage?.output_tokens ?? 0;
    // Sonnet 4.6 = $3/1M input, $15/1M output
    costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

    llmTextContent = accumulated.trim();
  } catch (err) {
    console.error(`[Ratifier] LLM stream failed for ${context.pair}:`, err);
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
    // Graceful fallback: write stage-2 as "ratified" with algo verdict
    await invokeStage2Fallback({
      context,
      algoVerdict,
      onStage2,
    });
    return;
  }

  // Parse JSON response outside the API try/catch so JSON errors are counted as schema failures
  if (llmTextContent) {
    try {
      const raw = JSON.parse(llmTextContent) as unknown;
      llmRawResponse = typeof raw === "object" && raw !== null ? (raw as object) : { raw };
      parsedResponse = parseRatificationResponse(raw);
    } catch {
      // Invalid JSON — treated as schema parse failure below
      llmRawResponse = { raw: llmTextContent };
    }
  }

  // ------------------------------------------------------------------
  // Validate
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
    await invokeStage2Fallback({ context, algoVerdict, onStage2 });
    return;
  }

  const validation = validateRatification(context.candidate, parsedResponse);
  if (!validation.ok) {
    _validationFailureCount++;
    console.warn(
      `[Ratifier] Validation failed for ${context.pair}: ${validation.reason}`,
      llmRawResponse,
    );
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
    await invokeStage2Fallback({ context, algoVerdict, onStage2 });
    return;
  }

  // ------------------------------------------------------------------
  // Success: persist + invoke stage-2
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

  const isDowngraded =
    parsedResponse.type !== context.candidate.type ||
    parsedResponse.confidence < context.candidate.confidence - 1e-6;

  const ratificationStatus = isDowngraded ? "downgraded" : "ratified";
  const ratificationVerdict = {
    type: parsedResponse.type,
    confidence: parsedResponse.confidence,
    reasoning: validation.reasoning,
  };

  const finalSignal: BlendedSignal = {
    ...ratified,
    ratificationStatus,
    ratificationVerdict,
    algoVerdict: isDowngraded ? algoVerdict : null,
  };

  console.log(
    `[Ratifier] Ratified ${context.pair}: ${finalSignal.type} conf=${finalSignal.confidence.toFixed(3)} status=${ratificationStatus}`,
  );

  if (onStage2) {
    try {
      await onStage2({
        ratificationStatus,
        ratificationVerdict,
        algoVerdict: isDowngraded ? algoVerdict : null,
        finalSignal,
      });
    } catch (err) {
      console.error(`[Ratifier] onStage2 callback failed for ${context.pair}:`, err);
      // Don't re-throw — stage-2 callback failure is non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Graceful fallback for stage-2
// ---------------------------------------------------------------------------

async function invokeStage2Fallback(params: {
  context: RatifyContext;
  algoVerdict: { type: "buy" | "sell" | "hold"; confidence: number; reasoning: string };
  onStage2?: OnStage2Callback;
}): Promise<void> {
  const { context, algoVerdict, onStage2 } = params;
  if (!onStage2) return;

  // Graceful fallback: treat algo as the verdict so the signal is never stuck on "pending"
  const fallbackVerdict = algoVerdict;
  const finalSignal: BlendedSignal = {
    ...context.candidate,
    ratificationStatus: "ratified",
    ratificationVerdict: fallbackVerdict,
    algoVerdict: null,
  };

  try {
    await onStage2({
      ratificationStatus: "ratified",
      ratificationVerdict: fallbackVerdict,
      algoVerdict: null,
      finalSignal,
    });
  } catch (err) {
    console.error(`[Ratifier] onStage2 fallback callback failed for ${context.pair}:`, err);
  }
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
