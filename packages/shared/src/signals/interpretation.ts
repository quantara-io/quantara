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
 *   - "ratified" + verdict.source="algo-fallback"
 *                    → source="algo-only" — graceful fallback wrote algo-as-verdict
 *                      because the LLM call failed; the narrative is just algo rules.
 *   - "ratified"     → source="llm-ratified",    text = ratificationVerdict.reasoning
 *   - "downgraded" + algoVerdict missing
 *                    → source="algo-only" — the type contract for `llm-downgraded`
 *                      requires `originalAlgo`; if we cannot honour it, degrade
 *                      to `algo-only` rather than emit a malformed interpretation.
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
    // Graceful fallback wrote an algo-shaped verdict because the LLM call
    // failed — surface it as algo-only so the UI does not say "LLM ratified".
    if (signal.ratificationVerdict.source === "algo-fallback") {
      return {
        source: "algo-only",
        text: rulesSummary,
      };
    }
    return {
      source: "llm-ratified",
      text: signal.ratificationVerdict.reasoning,
    };
  }

  if (
    signal.ratificationStatus === "downgraded" &&
    signal.ratificationVerdict &&
    signal.algoVerdict
  ) {
    return {
      source: "llm-downgraded",
      text: signal.ratificationVerdict.reasoning,
      originalAlgo: {
        type: signal.algoVerdict.type,
        confidence: signal.algoVerdict.confidence,
        reasoning: signal.algoVerdict.reasoning,
      },
    };
  }

  if (signal.ratificationStatus === "pending") {
    return {
      source: "algo-only",
      text: `${rulesSummary} — Awaiting LLM ratification…`,
    };
  }

  // "not-required", null, absent, or "downgraded" without algoVerdict.
  return {
    source: "algo-only",
    text: rulesSummary,
  };
}
