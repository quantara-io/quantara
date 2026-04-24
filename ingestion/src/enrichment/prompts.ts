export const NEWS_ENRICHMENT_PROMPT = `You are a crypto market analyst. Analyze the following news article and return a JSON object with these fields:

- sentiment: "bullish" | "bearish" | "neutral"
- confidence: number between 0 and 1
- events: string[] — list of key events mentioned (e.g., "ETF approval", "exchange hack", "regulatory action")
- relevance: object mapping each affected cryptocurrency to a relevance score 0-1 (e.g., {"BTC": 0.9, "ETH": 0.3})
- timeHorizon: "very_short" | "short_term" | "medium_term" | "long_term"
- summary: one sentence summary of market impact

Return ONLY valid JSON, no markdown or explanation.`;

export function buildEnrichmentMessage(title: string, currencies: string[]): string {
  return `${NEWS_ENRICHMENT_PROMPT}

Article title: "${title}"
Mentioned cryptocurrencies: ${currencies.length > 0 ? currencies.join(", ") : "none specified"}`;
}
