import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { NewsEnrichment } from "@quantara/shared";

import { recordLlmUsage } from "../lib/metadata-store.js";

import { buildEnrichmentMessage } from "./prompts.js";

const bedrock = new BedrockRuntimeClient({});

// Cross-region inference profile (us.* prefix) — required because all
// currently-active Anthropic models on Bedrock are profile-only. AWS marked
// Haiku 3.5 as legacy and revoked access for accounts that hadn't invoked
// it in 30+ days, which is what was producing the silent enrichment
// failures (every InvokeModel returned ResourceNotFoundException → catch
// block wrote `status: "failed"` to news-events). The us.* profile routes
// across us-west-2 / us-east-1 / us-east-2 by capacity; the org SCP
// region-lock was updated to permit `bedrock:InvokeModel*` cross-region.
const MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/** Stable model tag stamped on usage records — decoupled from the inference profile ID. */
const MODEL_TAG = "anthropic.claude-haiku-4-5";

export async function enrichNewsItem(title: string, currencies: string[]): Promise<NewsEnrichment> {
  const prompt = buildEnrichmentMessage(title, currencies);

  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    }),
  );

  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  // Record token usage for the admin dashboard. This is the *active* enrichment
  // path (one InvokeModel per article), so the call boundary IS the article
  // boundary — countAsArticle: true. Best-effort, never blocks enrichment.
  void recordLlmUsage({
    modelTag: MODEL_TAG,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    countAsArticle: true,
  });

  const text = body.content?.[0]?.text ?? "{}";

  try {
    const parsed = JSON.parse(text);
    return {
      sentiment: parsed.sentiment ?? "neutral",
      confidence: parsed.confidence ?? 0.5,
      events: parsed.events ?? [],
      relevance: parsed.relevance ?? {},
      timeHorizon: parsed.timeHorizon,
      summary: parsed.summary ?? "",
    };
  } catch {
    console.error("[Bedrock] Failed to parse enrichment response:", text);
    return {
      sentiment: "neutral",
      confidence: 0,
      events: [],
      relevance: {},
      summary: "Failed to parse enrichment",
    };
  }
}
