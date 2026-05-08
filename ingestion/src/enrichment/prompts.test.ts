import { describe, it, expect } from "vitest";

import { buildEnrichmentMessage, NEWS_ENRICHMENT_PROMPT } from "./prompts.js";

describe("buildEnrichmentMessage", () => {
  it("includes the system prompt, the title, and a comma-joined currency list", () => {
    const msg = buildEnrichmentMessage("BTC ETF approved", ["BTC", "ETH"]);
    expect(msg).toContain(NEWS_ENRICHMENT_PROMPT);
    expect(msg).toContain('Article title: "BTC ETF approved"');
    expect(msg).toContain("Mentioned cryptocurrencies: BTC, ETH");
  });

  it("renders 'none specified' when the currency list is empty", () => {
    const msg = buildEnrichmentMessage("Generic market update", []);
    expect(msg).toContain("Mentioned cryptocurrencies: none specified");
  });

  it("preserves quotes inside the title verbatim (no escaping mangling)", () => {
    const msg = buildEnrichmentMessage('Vitalik says "scaling is fine"', ["ETH"]);
    expect(msg).toContain('Vitalik says "scaling is fine"');
  });
});
