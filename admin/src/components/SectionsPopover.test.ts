/**
 * Pure value-level tests for the SectionsPopover data layer.
 * No DOM rendering — vitest runs in node environment.
 */

import { describe, it, expect } from "vitest";
import { ALL_SECTIONS } from "./SectionsPopover";

describe("ALL_SECTIONS", () => {
  it("contains exactly 13 entries (all routes from App.tsx)", () => {
    expect(ALL_SECTIONS).toHaveLength(13);
  });

  it("every entry has a non-empty label and a path starting with /", () => {
    for (const s of ALL_SECTIONS) {
      expect(s.label.length, `${s.to} label empty`).toBeGreaterThan(0);
      expect(s.to.startsWith("/"), `${s.to} must start with /`).toBe(true);
    }
  });

  it("includes the root / path (Workstation)", () => {
    expect(ALL_SECTIONS.some((s) => s.to === "/")).toBe(true);
  });

  it("includes /admin/glossary (nested route)", () => {
    expect(ALL_SECTIONS.some((s) => s.to === "/admin/glossary")).toBe(true);
  });

  it("includes all 12 non-root routes from App.tsx", () => {
    const expectedPaths = [
      "/market",
      "/news",
      "/genie",
      "/performance",
      "/pnl",
      "/whitelist",
      "/ratifications",
      "/pipeline",
      "/health",
      "/activity",
      "/ops",
      "/admin/glossary",
    ];
    for (const path of expectedPaths) {
      expect(
        ALL_SECTIONS.some((s) => s.to === path),
        `missing route ${path}`,
      ).toBe(true);
    }
  });

  it("has no duplicate paths", () => {
    const paths = ALL_SECTIONS.map((s) => s.to);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  it("has no duplicate labels", () => {
    const labels = ALL_SECTIONS.map((s) => s.label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });
});
