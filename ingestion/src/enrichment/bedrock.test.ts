import { describe, it, expect } from "vitest";

import { stripJsonFence } from "./bedrock.js";

describe("stripJsonFence", () => {
  it("strips ```json fence with newlines (Haiku 4.5 default shape)", () => {
    const fenced = '```json\n{"sentiment":"neutral","confidence":0.7}\n```';
    expect(stripJsonFence(fenced)).toBe('{"sentiment":"neutral","confidence":0.7}');
  });

  it("strips bare ``` fence with no language tag", () => {
    const fenced = '```\n{"a":1}\n```';
    expect(stripJsonFence(fenced)).toBe('{"a":1}');
  });

  it("tolerates leading and trailing whitespace around the fence", () => {
    const fenced = '   \n```json\n{"a":1}\n```\n  ';
    expect(stripJsonFence(fenced)).toBe('{"a":1}');
  });

  it("preserves multiline JSON content inside the fence", () => {
    const fenced = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
    expect(stripJsonFence(fenced)).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("returns trimmed input unchanged when there is no fence", () => {
    const raw = '  {"a":1}  ';
    expect(stripJsonFence(raw)).toBe('{"a":1}');
  });

  it("returns trimmed input unchanged when only one fence marker is present", () => {
    const partial = '```json\n{"a":1}';
    expect(stripJsonFence(partial)).toBe(partial.trim());
  });

  it("yields output that JSON.parse can consume on a real Haiku response", () => {
    const real =
      '```json\n{\n  "sentiment": "bullish",\n  "confidence": 0.72,\n  "events": ["X"],\n  "relevance": {"BTC": 0.7},\n  "timeHorizon": "long_term",\n  "summary": "test"\n}\n```';
    const parsed = JSON.parse(stripJsonFence(real));
    expect(parsed.sentiment).toBe("bullish");
    expect(parsed.confidence).toBe(0.72);
    expect(parsed.relevance.BTC).toBe(0.7);
  });
});
