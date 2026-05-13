/**
 * Ratifier — Phase 2 follow-up (PR #373 review findings 1 & 2).
 *
 * Three ratification modes, plus the supporting abstractions so the engine
 * can plug a real Bedrock invoker / DDB ratifications lookup in production
 * while tests use in-memory stubs.
 *
 *   skip            — no LLM, signal carries `ratificationStatus: "not-required"`
 *   cache-only      — read existing rows from the production ratifications table
 *                     (keyed by (pair, closeTime/timeframe)); on miss → not-required.
 *   replay-bedrock  — invoke Bedrock for every candidate signal that crosses
 *                     the strategy's `ratificationThreshold`, accumulate
 *                     real input/output tokens, dollarise via the same
 *                     pricing constants as the cost estimator, and abort
 *                     mid-run when the running cost exceeds `maxCostUsd`.
 *
 * Design parity with the production `forceRatification` helper in
 * `backend/src/services/admin-debug.service.ts` — the prompt shape, model
 * id, and parse logic are intentionally mirrored so the ratifications a
 * backtest produces are shape-comparable to live admin-debug invocations.
 * We do NOT import that helper directly because it lives in a different
 * workspace and depends on backend-only logger + idempotency stores; the
 * subset replicated here is the minimum needed for an offline backtest.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

import {
  HAIKU_INPUT_PRICE_PER_M,
  HAIKU_OUTPUT_PRICE_PER_M,
  SONNET_INPUT_PRICE_PER_M,
  SONNET_OUTPUT_PRICE_PER_M,
  type RatificationModel,
} from "../cost/estimator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RatificationMode = "skip" | "cache-only" | "replay-bedrock";

/** Status carried on each emitted `BacktestSignal`. */
export type RatificationStatus =
  | "not-required" // skip mode, sub-threshold, or cache-miss
  | "ratified" // LLM (or cached verdict) approved
  | "downgraded" // LLM lowered confidence
  | "pending"; // reserved for future async paths

export type VerdictKind = "ratify" | "downgrade" | "reject" | "fallback";

export interface RatificationCandidate {
  pair: string;
  timeframe: string;
  closeTime: number;
  /** Algo signal type (5-tier). */
  type: string;
  /** Algo confidence in [0, 1]. */
  confidence: number;
  rulesFired: string[];
}

export interface RatificationVerdict {
  /** Final ratificationStatus to record on the BacktestSignal. */
  status: RatificationStatus;
  ratifiedType?: string;
  ratifiedConfidence?: number;
  verdictKind?: VerdictKind;
  /** Per-call USD cost (0 when no Bedrock call was made). */
  costUsd: number;
  /** Per-call input tokens (0 when no Bedrock call was made). */
  inputTokens: number;
  /** Per-call output tokens (0 when no Bedrock call was made). */
  outputTokens: number;
}

/**
 * Abstraction over the ratifications table for `cache-only` mode.
 * Tests provide an in-memory stub; production wires `DdbRatificationsLookup`.
 */
export interface RatificationsLookup {
  /**
   * Return the cached verdict that matches `(pair, timeframe, closeTime)`, or
   * null when no row matches. Implementations are free to apply a small time
   * window — production rows are keyed by an ISO-timestamp sort-key so an
   * exact-millisecond match is rare; a `±1 bar` window is sufficient.
   */
  lookup(pair: string, timeframe: string, closeTime: number): Promise<CachedRatification | null>;
}

export interface CachedRatification {
  ratifiedType: string;
  ratifiedConfidence: number;
  verdictKind: VerdictKind;
}

/**
 * Abstraction over Bedrock for `replay-bedrock` mode. Tests mock this; the
 * production implementation (`BedrockInvokerImpl`) wraps `InvokeModelCommand`.
 */
export interface BedrockInvoker {
  invoke(
    candidate: RatificationCandidate,
    model: RatificationModel,
  ): Promise<BedrockInvocationResult>;
}

export interface BedrockInvocationResult {
  verdictKind: VerdictKind;
  ratifiedConfidence: number;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Ratifier interface + factory
// ---------------------------------------------------------------------------

/**
 * Stateless mapper from a candidate signal → ratification verdict.
 *
 * Implementations must be safe to call concurrently for distinct candidates;
 * the engine calls them sequentially in the hot loop but tests may parallelise.
 */
export interface Ratifier {
  ratify(candidate: RatificationCandidate): Promise<RatificationVerdict>;
}

export interface RatifierOptions {
  mode: RatificationMode;
  model: RatificationModel;
  /**
   * Confidence floor below which ratification is skipped even in
   * `replay-bedrock` / `cache-only` mode. Mirrors production's
   * `ratificationThreshold` strategy field — when omitted, defaults to 0.6
   * so reasonable signals are ratified but noise floor isn't.
   */
  ratificationThreshold?: number;
  /** Cache lookup (cache-only mode). Required when mode === "cache-only". */
  cacheLookup?: RatificationsLookup;
  /** Bedrock invoker (replay-bedrock mode). Required when mode === "replay-bedrock". */
  bedrockInvoker?: BedrockInvoker;
}

/** Default confidence floor when the strategy doesn't specify one. */
export const DEFAULT_RATIFICATION_THRESHOLD = 0.6;

/**
 * Build a Ratifier for the requested mode.
 */
export function createRatifier(opts: RatifierOptions): Ratifier {
  if (opts.mode === "skip") {
    return new SkipRatifier();
  }
  if (opts.mode === "cache-only") {
    if (!opts.cacheLookup) {
      throw new Error("createRatifier: cache-only mode requires `cacheLookup`");
    }
    return new CacheOnlyRatifier(
      opts.cacheLookup,
      opts.ratificationThreshold ?? DEFAULT_RATIFICATION_THRESHOLD,
    );
  }
  // replay-bedrock
  if (!opts.bedrockInvoker) {
    throw new Error("createRatifier: replay-bedrock mode requires `bedrockInvoker`");
  }
  return new BedrockRatifier(
    opts.bedrockInvoker,
    opts.model,
    opts.ratificationThreshold ?? DEFAULT_RATIFICATION_THRESHOLD,
  );
}

// ---------------------------------------------------------------------------
// SkipRatifier
// ---------------------------------------------------------------------------

class SkipRatifier implements Ratifier {
  async ratify(_candidate: RatificationCandidate): Promise<RatificationVerdict> {
    return zeroCostVerdict("not-required");
  }
}

// ---------------------------------------------------------------------------
// CacheOnlyRatifier
// ---------------------------------------------------------------------------

class CacheOnlyRatifier implements Ratifier {
  constructor(
    private readonly lookup: RatificationsLookup,
    private readonly threshold: number,
  ) {}

  async ratify(candidate: RatificationCandidate): Promise<RatificationVerdict> {
    // Sub-threshold candidates aren't gated to the LLM in production either.
    if (candidate.confidence < this.threshold || candidate.type === "hold") {
      return zeroCostVerdict("not-required");
    }

    const cached = await this.lookup.lookup(
      candidate.pair,
      candidate.timeframe,
      candidate.closeTime,
    );

    if (cached === null) {
      // Cache miss → behave like skip. Costs nothing.
      return zeroCostVerdict("not-required");
    }

    const status: RatificationStatus =
      cached.verdictKind === "downgrade" ? "downgraded" : "ratified";

    return {
      status,
      ratifiedType: cached.ratifiedType,
      ratifiedConfidence: cached.ratifiedConfidence,
      verdictKind: cached.verdictKind,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// BedrockRatifier
// ---------------------------------------------------------------------------

class BedrockRatifier implements Ratifier {
  constructor(
    private readonly invoker: BedrockInvoker,
    private readonly model: RatificationModel,
    private readonly threshold: number,
  ) {}

  async ratify(candidate: RatificationCandidate): Promise<RatificationVerdict> {
    // Production also gates Bedrock invocation by confidence floor and never
    // ratifies a hold — mirror that so backtest cost matches reality.
    if (candidate.confidence < this.threshold || candidate.type === "hold") {
      return zeroCostVerdict("not-required");
    }

    const result = await this.invoker.invoke(candidate, this.model);

    const status: RatificationStatus =
      result.verdictKind === "downgrade"
        ? "downgraded"
        : result.verdictKind === "fallback" || result.verdictKind === "reject"
          ? "not-required"
          : "ratified";

    return {
      status,
      ratifiedType: candidate.type,
      ratifiedConfidence: result.ratifiedConfidence,
      verdictKind: result.verdictKind,
      costUsd: bedrockCallCostUsd(result.inputTokens, result.outputTokens, this.model),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Compute per-call USD cost. Uses the same constants the cost estimator
 * advertises so the post-run actual cost is directly comparable to the
 * pre-run estimate.
 */
export function bedrockCallCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: RatificationModel,
): number {
  const inputPricePerM = model === "haiku" ? HAIKU_INPUT_PRICE_PER_M : SONNET_INPUT_PRICE_PER_M;
  const outputPricePerM = model === "haiku" ? HAIKU_OUTPUT_PRICE_PER_M : SONNET_OUTPUT_PRICE_PER_M;
  return (inputTokens / 1_000_000) * inputPricePerM + (outputTokens / 1_000_000) * outputPricePerM;
}

function zeroCostVerdict(status: RatificationStatus): RatificationVerdict {
  return { status, costUsd: 0, inputTokens: 0, outputTokens: 0 };
}

// ---------------------------------------------------------------------------
// Production wirings — DDB cache lookup
// ---------------------------------------------------------------------------

/**
 * DynamoDB-backed RatificationsLookup over the production `ratifications`
 * table. The table is keyed by `pair` (PK) and `invokedAtRecordId` (SK,
 * `${invokedAt}#${uuid}`). There is no direct (pair, timeframe, closeTime)
 * index, so this helper queries by pair and filters in-memory for
 * (timeframe match) AND (algoCandidate.createdAt close to the bar's
 * closeTime), within a `WINDOW_MS` tolerance.
 *
 * Phase 2 follow-up: a `(pair, closeTime)` GSI is the right long-term shape,
 * but is out of scope for this PR — for the backtest's offline use the scan
 * is bounded by `WINDOW_MS × pages` which is cheap on dev volumes.
 */
export class DdbRatificationsLookup implements RatificationsLookup {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  /** ±1 emitting bar tolerance (assume 15m) — close enough for cache lookup. */
  private readonly windowMs: number;

  constructor(tableName?: string, windowMs = 900_000) {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this.tableName =
      tableName ??
      process.env.TABLE_RATIFICATIONS ??
      `${process.env.TABLE_PREFIX ?? "quantara-dev-"}ratifications`;
    this.windowMs = windowMs;
  }

  async lookup(
    pair: string,
    timeframe: string,
    closeTime: number,
  ): Promise<CachedRatification | null> {
    const sinceIso = new Date(closeTime - this.windowMs).toISOString();
    const untilIso = new Date(closeTime + this.windowMs).toISOString();

    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pair = :pair AND invokedAtRecordId BETWEEN :lo AND :hi",
        ExpressionAttributeNames: { "#pair": "pair" },
        ExpressionAttributeValues: {
          ":pair": pair,
          ":lo": sinceIso,
          ":hi": untilIso + "￿",
        },
        Limit: 50,
        ScanIndexForward: false,
      }),
    );

    for (const item of (result.Items ?? []) as Array<Record<string, unknown>>) {
      if (item["timeframe"] !== timeframe) continue;
      const validation = item["validation"] as { ok?: boolean } | undefined;
      if (!validation || validation.ok !== true) continue;

      const extracted = extractCachedRatification(item);
      if (extracted !== null) {
        return extracted;
      }
    }
    return null;
  }
}

/**
 * Extract a `CachedRatification` from a ratifications-table row, supporting
 * the two write paths that exist in production:
 *
 *   1. Canonical bulk path (`ingestion/src/lib/ratification-store.ts:putRatificationRecord`)
 *      stores the verdict NESTED under `ratified: BlendedSignal | null`. This
 *      is the shape used for ~99% of rows (every per-bar LLM ratification).
 *
 *   2. Admin-debug path (`backend/src/services/admin-debug.service.ts:forceRatification`)
 *      ALSO stores `ratified` nested, but additionally writes flat top-level
 *      `ratifiedType` / `ratifiedConfidence` / `verdictKind` fields for
 *      legacy/downstream consumers.
 *
 * We prefer the nested shape (production canonical) and fall back to the flat
 * shape so both write paths read correctly. Skip rows where `ratified` is
 * explicitly null (fallback rows where Bedrock failed) AND no flat fields
 * exist — those rows carry no verdict.
 *
 * Exported for unit testing both shapes against a single function.
 */
export function extractCachedRatification(
  item: Record<string, unknown>,
): CachedRatification | null {
  // 1. Prefer the nested canonical shape (BlendedSignal under `ratified`).
  //    `ratified === null` is a valid sentinel for fallback rows — we treat
  //    that as "no verdict" and fall through to the flat shape (which the
  //    admin-debug path writes alongside the null `ratified`).
  const ratifiedRaw = item["ratified"];
  if (ratifiedRaw !== null && ratifiedRaw !== undefined && typeof ratifiedRaw === "object") {
    const ratified = ratifiedRaw as {
      type?: unknown;
      confidence?: unknown;
      verdictKind?: unknown;
    };
    if (typeof ratified.type === "string" && typeof ratified.confidence === "number") {
      return {
        ratifiedType: ratified.type,
        ratifiedConfidence: ratified.confidence,
        verdictKind: normaliseVerdictKind(ratified.verdictKind),
      };
    }
  }

  // 2. Fall back to the flat top-level fields written by admin-debug rows.
  const flatType = item["ratifiedType"];
  const flatConfidence = item["ratifiedConfidence"];
  if (typeof flatType === "string" && typeof flatConfidence === "number") {
    return {
      ratifiedType: flatType,
      ratifiedConfidence: flatConfidence,
      verdictKind: normaliseVerdictKind(item["verdictKind"]),
    };
  }

  return null;
}

function normaliseVerdictKind(raw: unknown): VerdictKind {
  if (raw === "ratify" || raw === "downgrade" || raw === "reject" || raw === "fallback") {
    return raw;
  }
  return "ratify";
}

// ---------------------------------------------------------------------------
// Production wirings — Bedrock invoker
// ---------------------------------------------------------------------------

const DEFAULT_HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_SONNET_MODEL_ID = "us.anthropic.claude-sonnet-4-6";

function modelIdFor(model: RatificationModel): string {
  if (model === "haiku") {
    return process.env.BACKTEST_HAIKU_MODEL_ID ?? DEFAULT_HAIKU_MODEL_ID;
  }
  return process.env.BACKTEST_SONNET_MODEL_ID ?? DEFAULT_SONNET_MODEL_ID;
}

/**
 * Bedrock invoker that mirrors the prompt shape used by
 * `forceRatification` in `backend/src/services/admin-debug.service.ts`.
 * Kept in sync intentionally so the verdicts a backtest produces are
 * shape-comparable to admin-debug invocations on the same bar.
 */
export class BedrockInvokerImpl implements BedrockInvoker {
  private readonly client: BedrockRuntimeClient;

  constructor(client?: BedrockRuntimeClient) {
    this.client = client ?? new BedrockRuntimeClient({});
  }

  async invoke(
    candidate: RatificationCandidate,
    model: RatificationModel,
  ): Promise<BedrockInvocationResult> {
    const systemPrompt = `You are a crypto trading signal ratifier. Review the algorithmic signal and return a JSON verdict:
{ "verdict": "ratify" | "downgrade" | "reject", "confidence": <0-1>, "reasoning": <string> }
- ratify: LLM agrees with the signal and its confidence
- downgrade: signal direction is correct but confidence is too high
- reject: signal is wrong or unreliable given current conditions
Return JSON only.`;

    const userContent = `Signal to ratify:
Pair: ${candidate.pair}
Timeframe: ${candidate.timeframe}
Type: ${candidate.type}
Confidence: ${(candidate.confidence * 100).toFixed(0)}%
Close time: ${candidate.closeTime}
Rules fired: ${JSON.stringify(candidate.rulesFired)}
Trigger reason: backtest replay

Rate this signal's validity and provide your reasoning in 2-3 sentences.`;

    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: modelIdFor(model),
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }],
          }),
        }),
      );

      const raw = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
      const text = String((raw["content"] as Array<{ text?: string }>)?.[0]?.text ?? "{}");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      let verdictKind: VerdictKind = "fallback";
      let ratifiedConfidence = candidate.confidence;
      if (start !== -1 && end !== -1) {
        const parsed = JSON.parse(text.slice(start, end + 1)) as {
          verdict?: string;
          confidence?: number;
        };
        const v = parsed.verdict;
        if (v === "ratify" || v === "downgrade" || v === "reject") {
          verdictKind = v;
        }
        if (typeof parsed.confidence === "number") {
          ratifiedConfidence = parsed.confidence;
        }
      }
      const usage = raw["usage"] as { input_tokens?: number; output_tokens?: number };
      return {
        verdictKind,
        ratifiedConfidence,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      };
    } catch {
      return {
        verdictKind: "fallback",
        ratifiedConfidence: candidate.confidence,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }
}
