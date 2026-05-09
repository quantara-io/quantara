import type { BlendedSignal, SignalInterpretation } from "../types/signals.js";

/**
 * Build the consolidated `SignalInterpretation` for a signal row.
 *
 * Called at both the ingestion read path (`signal-store.ts`) and the backend
 * read path (`signal-service.ts`) so clients always receive a populated
 * `interpretation` field without having to stitch `ratificationVerdict` +
 * `rulesFired` themselves.
 *
 * Logic:
 *   - "ratified"     → source="llm-ratified",    text = ratificationVerdict.reasoning
 *   - "downgraded"   → source="llm-downgraded",  text = ratificationVerdict.reasoning, originalAlgo set
 *   - "pending"      → source="algo-only",        text = rulesFired summary + "Awaiting LLM ratification…"
 *   - "not-required" → source="algo-only",        text = rulesFired summary
 *   - null / absent  → source="algo-only",        text = rulesFired summary
 */
export function buildInterpretation(
  signal: Pick<
    BlendedSignal,
    "ratificationStatus" | "ratificationVerdict" | "algoVerdict" | "rulesFired" | "pair" | "type"
  >,
): SignalInterpretation {
  const rulesSummary =
    signal.rulesFired.length > 0
      ? `${signal.pair}: ${signal.rulesFired.join(" + ")}`
      : `${signal.pair}: ${signal.type}`;

  if (signal.ratificationStatus === "ratified" && signal.ratificationVerdict) {
    return {
      source: "llm-ratified",
      text: signal.ratificationVerdict.reasoning,
    };
  }

  if (signal.ratificationStatus === "downgraded" && signal.ratificationVerdict) {
    const interpretation: SignalInterpretation = {
      source: "llm-downgraded",
      text: signal.ratificationVerdict.reasoning,
    };
    if (signal.algoVerdict) {
      interpretation.originalAlgo = {
        type: signal.algoVerdict.type,
        confidence: signal.algoVerdict.confidence,
        reasoning: signal.algoVerdict.reasoning,
      };
    }
    return interpretation;
  }

  if (signal.ratificationStatus === "pending") {
    return {
      source: "algo-only",
      text: `${rulesSummary} — Awaiting LLM ratification…`,
    };
  }

  // "not-required", null, or absent
  return {
    source: "algo-only",
    text: rulesSummary,
  };
}
