import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { NewsEnrichment } from "@quantara/shared";

import { buildEnrichmentMessage } from "./prompts.js";

const bedrock = new BedrockRuntimeClient({});

const MODEL_ID = "anthropic.claude-3-5-haiku-20241022-v1:0";

export async function enrichNewsItem(
  title: string,
  currencies: string[]
): Promise<NewsEnrichment> {
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
    })
  );

  const body = JSON.parse(new TextDecoder().decode(response.body));
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
