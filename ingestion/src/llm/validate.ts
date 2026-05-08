/**
 * validate.ts — server-side guardrail for LLM ratification (Phase 6a).
 *
 * Enforces the downgrade-only contract from §7.4 + §7.7.
 * The LLM is only permitted to lower confidence or widen the hold zone;
 * it may never escalate a signal.
 *
 * Design: §7.4, §7.7 of docs/SIGNALS_AND_RISK.md
 */

import type { BlendedSignal } from "@quantara/shared";
import type { RatificationResponse } from "./prompt.js";

export type ValidationResult =
  | { ok: true; ratified: BlendedSignal; reasoning: string }
  | { ok: false; reason: string };

/**
 * Validate the LLM response against the candidate signal.
 *
 * Rules (§7.4 table):
 *   hold → non-hold: forbidden
 *   buy  → sell:     forbidden (sign flip)
 *   sell → buy:      forbidden (sign flip)
 *   *    → increase confidence: forbidden
 *   confidence out of [0,1]: forbidden
 *   reasoning length out of [20,600]: forbidden
 *
 * On success returns the ratified BlendedSignal (spread from candidate, type + confidence overwritten).
 */
export function validateRatification(
  candidate: BlendedSignal,
  llmResponse: RatificationResponse,
): ValidationResult {
  // Type transformation rules (§7.4 table)
  if (candidate.type === "hold" && llmResponse.type !== "hold") {
    return { ok: false, reason: "hold→non-hold not allowed" };
  }
  if (candidate.type === "buy" && llmResponse.type === "sell") {
    return { ok: false, reason: "buy→sell sign flip" };
  }
  if (candidate.type === "sell" && llmResponse.type === "buy") {
    return { ok: false, reason: "sell→buy sign flip" };
  }

  // Confidence bound (no increases, §7.7)
  if (llmResponse.confidence > candidate.confidence + 1e-6) {
    return { ok: false, reason: "confidence increase forbidden" };
  }

  // Schema bounds
  if (llmResponse.confidence < 0 || llmResponse.confidence > 1) {
    return { ok: false, reason: "confidence out of [0,1]" };
  }
  if (llmResponse.reasoning.length < 20 || llmResponse.reasoning.length > 600) {
    return { ok: false, reason: "reasoning length out of bounds" };
  }

  const ratified: BlendedSignal = {
    ...candidate,
    type: llmResponse.type,
    confidence: llmResponse.confidence,
  };

  return { ok: true, ratified, reasoning: llmResponse.reasoning };
}
