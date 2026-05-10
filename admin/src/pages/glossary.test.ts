/**
 * Tests for the glossary constants module and its wiring constraints.
 *
 * These are pure TypeScript / value-level tests — no DOM rendering required.
 * The vitest config runs in `node` environment, so JSX rendering is out of scope here.
 * Visual rendering is verified manually (see issue acceptance criteria).
 */

import { describe, it, expect } from "vitest";
import { GLOSSARY } from "@quantara/shared";
import type { GlossaryEntry, GlossaryKey } from "@quantara/shared";

// ---------------------------------------------------------------------------
// Glossary shape
// ---------------------------------------------------------------------------

describe("GLOSSARY", () => {
  it("exports a non-empty object", () => {
    expect(typeof GLOSSARY).toBe("object");
    expect(Object.keys(GLOSSARY).length).toBeGreaterThan(0);
  });

  it("every entry has a non-empty label and body", () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.label, `${key}.label`).toBeTruthy();
      expect(entry.body, `${key}.body`).toBeTruthy();
      expect(typeof entry.label, `${key}.label type`).toBe("string");
      expect(typeof entry.body, `${key}.body type`).toBe("string");
    }
  });

  it("optional code fields, when present, are non-empty strings", () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      if ("code" in entry && entry.code !== undefined) {
        expect(typeof entry.code, `${key}.code type`).toBe("string");
        expect(entry.code.length, `${key}.code length`).toBeGreaterThan(0);
      }
    }
  });

  it("optional docHref fields, when present, start with /admin/glossary#", () => {
    for (const [key, entry] of Object.entries(GLOSSARY) as [string, GlossaryEntry][]) {
      if (entry.docHref !== undefined) {
        expect(
          entry.docHref.startsWith("/admin/glossary#"),
          `${key}.docHref must use in-app canonical form`,
        ).toBe(true);
      }
    }
  });

  it("contains all Tier-1 keys required by Performance.tsx", () => {
    const tier1: GlossaryKey[] = [
      "confidenceCalibration",
      "winRate",
      "tpRate",
      "coOccurrence",
      "volatilityQuartile",
      "hourBucket",
    ];
    for (const key of tier1) {
      expect(key in GLOSSARY, `missing Tier-1 key: ${key}`).toBe(true);
    }
  });

  it("contains all Tier-1 keys required by Market / Pipeline indicator labels", () => {
    const indicatorKeys: GlossaryKey[] = [
      "rsi14",
      "ema50",
      "macdHist",
      "bbBands",
      "atr14",
      "obv",
      "vwap",
      "volZ",
    ];
    for (const key of indicatorKeys) {
      expect(key in GLOSSARY, `missing indicator key: ${key}`).toBe(true);
    }
  });

  it("contains all Tier-2 keys required by Genie / Ratifications / Health", () => {
    const tier2: GlossaryKey[] = [
      "ratificationVerdict",
      "cacheHit",
      "fellBackToAlgo",
      "quorum",
      "streamHealth",
      "lambdaThrottles",
    ];
    for (const key of tier2) {
      expect(key in GLOSSARY, `missing Tier-2 key: ${key}`).toBe(true);
    }
  });

  it("contains all Tier-3 keys required by News / Pipeline", () => {
    const tier3: GlossaryKey[] = [
      "phase5aSentiment",
      "mentionedPairs",
      "newsStatus",
      "barFreshness",
    ];
    for (const key of tier3) {
      expect(key in GLOSSARY, `missing Tier-3 key: ${key}`).toBe(true);
    }
  });

  it("has no entries with body shorter than 20 chars (quality gate)", () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.body.length, `${key}.body is too short`).toBeGreaterThanOrEqual(20);
    }
  });

  it("GlossaryKey type is the union of actual keys (type-level sanity)", () => {
    // This test is mostly a compile-time check. At runtime we verify the union
    // by confirming every key in GLOSSARY is assignable to a string (the
    // underlying primitive). TypeScript will catch any key mismatch at build.
    const keys = Object.keys(GLOSSARY) as GlossaryKey[];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(typeof k).toBe("string");
    }
  });
});
