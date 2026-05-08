/**
 * prompt.ts — LLM ratification prompt builders (Phase 6a).
 *
 * System prompt per §7.2. Kept in a separate file so it can be unit-tested
 * without constructing a full Anthropic client.
 *
 * Design: §7.2 of docs/SIGNALS_AND_RISK.md
 */

import crypto from "node:crypto";
import type { RatifyContext } from "./ratify.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a risk-aware market analyst for Quantara, an advisory product for retail crypto traders.

You will receive a candidate trading signal produced by a deterministic algorithm.
Your job: review the signal in light of news, sentiment, and market context, and output JSON only.

YOU MAY:
- Lower confidence on any type
- Change "buy" → "hold" if the qualitative context is bearish enough to warrant caution
- Change "sell" → "hold" if the qualitative context is bullish enough to warrant caution

YOU MAY NOT:
- Change "hold" → "buy" or "hold" → "sell"
- Change "buy" → "sell" or "sell" → "buy"
- Increase confidence above the candidate's confidence

Reasoning should be 1-3 sentences, mobile-readable, cite specific evidence (named indicators, news headlines, F&G level). Quote a news headline if one is materially relevant.

Respond with a JSON object only — no markdown, no explanation outside the object:
{
  "type": "buy" | "sell" | "hold",
  "confidence": <number between 0 and 1>,
  "reasoning": "<1-3 sentences>",
  "downgraded": <true if you changed type or lowered confidence>,
  "downgradeReason": "<string | null>"
}`;

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

export function buildUserMessage(ctx: RatifyContext): string {
  return JSON.stringify({
    pair: ctx.pair,
    candidate: {
      type: ctx.candidate.type,
      confidence: ctx.candidate.confidence,
      indicators_fired: ctx.candidate.rulesFired,
    },
    perTimeframe: ctx.perTimeframe,
    sentiment: ctx.sentiment,
    whaleSummary: ctx.whaleSummary ?? null,
    fearGreed: ctx.fearGreed,
    pricePoints: ctx.pricePoints,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Response type + validation
// ---------------------------------------------------------------------------

export interface RatificationResponse {
  type: "buy" | "sell" | "hold";
  confidence: number;
  reasoning: string;
  downgraded: boolean;
  downgradeReason: string | null;
}

const VALID_TYPES = new Set(["buy", "sell", "hold"]);

/**
 * Parse and validate the raw JSON object returned by the LLM.
 * Returns the typed response or null if it fails validation.
 */
export function parseRatificationResponse(raw: unknown): RatificationResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (!VALID_TYPES.has(obj.type as string)) return null;
  if (typeof obj.confidence !== "number") return null;
  if (obj.confidence < 0 || obj.confidence > 1) return null;
  if (typeof obj.reasoning !== "string") return null;
  if (obj.reasoning.length < 20 || obj.reasoning.length > 600) return null;
  if (typeof obj.downgraded !== "boolean") return null;
  if (obj.downgradeReason !== null && typeof obj.downgradeReason !== "string") return null;

  return {
    type: obj.type as "buy" | "sell" | "hold",
    confidence: obj.confidence,
    reasoning: obj.reasoning,
    downgraded: obj.downgraded,
    downgradeReason: obj.downgradeReason as string | null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable SHA-256 hash of the system prompt — stored in RatificationRecord for auditing. */
export const SYSTEM_HASH: string = crypto.createHash("sha256").update(SYSTEM_PROMPT).digest("hex");

/**
 * Hash the user JSON string (not the context object) for deduplication and auditing.
 */
export function hashUserMessage(userJson: string): string {
  return crypto.createHash("sha256").update(userJson).digest("hex");
}
