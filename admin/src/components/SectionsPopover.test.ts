/**
 * Pure value-level tests for the SectionsPopover data layer + a11y helpers.
 * No DOM rendering — vitest runs in node environment.
 */

import { describe, it, expect } from "vitest";
import { ALL_SECTIONS, getNextFocusElement, isOutsideClick } from "./SectionsPopover";

describe("ALL_SECTIONS", () => {
  it("contains exactly 14 entries (all routes from App.tsx, incl. /backtest)", () => {
    expect(ALL_SECTIONS).toHaveLength(14);
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

  it("includes all 13 non-root routes from App.tsx", () => {
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
      "/backtest",
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

// ── isOutsideClick — guards the toggle race (P1.1) ───────────────────────────
//
// The grid trigger button lives OUTSIDE the popover container. A naive
// "click outside container" check fires `onClose` on the document mousedown
// before the trigger's click handler runs — the click handler then toggles
// the popover back open. Excluding the trigger from the outside-click check
// is the fix.
describe("isOutsideClick", () => {
  it("returns false when the click target is inside the popover container", () => {
    const target = {} as unknown as Node;
    const container = { contains: (n: Node) => n === target } as unknown as Element;
    const trigger = { contains: () => false } as unknown as Element;
    expect(isOutsideClick(target, container, trigger)).toBe(false);
  });

  it("returns false when the click target is the trigger itself (P1.1 — toggle race fix)", () => {
    // Without this exclusion, clicking the trigger to close the popover
    // closes via mousedown handler then re-opens via click handler.
    const target = {} as unknown as Node;
    const container = { contains: () => false } as unknown as Element;
    const trigger = { contains: (n: Node) => n === target } as unknown as Element;
    expect(isOutsideClick(target, container, trigger)).toBe(false);
  });

  it("returns false when the click target is inside the trigger (e.g. an SVG icon child)", () => {
    // The grid icon is an SVG inside the trigger button. Real-world
    // event.target may be the SVG, not the button — `.contains` handles both.
    const target = {} as unknown as Node;
    const container = { contains: () => false } as unknown as Element;
    const trigger = { contains: (n: Node) => n === target } as unknown as Element;
    expect(isOutsideClick(target, container, trigger)).toBe(false);
  });

  it("returns true when the click target is outside both container and trigger", () => {
    const target = {} as unknown as Node;
    const container = { contains: () => false } as unknown as Element;
    const trigger = { contains: () => false } as unknown as Element;
    expect(isOutsideClick(target, container, trigger)).toBe(true);
  });

  it("returns false when target is null (defensive)", () => {
    const container = { contains: () => false } as unknown as Element;
    const trigger = { contains: () => false } as unknown as Element;
    expect(isOutsideClick(null, container, trigger)).toBe(false);
  });

  it("returns true when both refs are null and target is non-null", () => {
    const target = {} as unknown as Node;
    expect(isOutsideClick(target, null, null)).toBe(true);
  });
});

// ── getNextFocusElement — focus trap (P1.3) ──────────────────────────────────
//
// Tab from last focusable wraps to first; Shift+Tab from first wraps to last;
// otherwise no trap action (lets the browser handle the move naturally).
describe("getNextFocusElement", () => {
  const A = { name: "first" };
  const B = { name: "middle" };
  const C = { name: "last" };
  const focusables = [A, B, C] as const;

  it("Tab on the last element wraps to the first (forward wrap)", () => {
    expect(getNextFocusElement(C, focusables, false)).toBe(A);
  });

  it("Shift+Tab on the first element wraps to the last (backward wrap)", () => {
    expect(getNextFocusElement(A, focusables, true)).toBe(C);
  });

  it("Tab in the middle returns null (let browser handle it)", () => {
    expect(getNextFocusElement(B, focusables, false)).toBeNull();
  });

  it("Shift+Tab in the middle returns null (let browser handle it)", () => {
    expect(getNextFocusElement(B, focusables, true)).toBeNull();
  });

  it("Tab on the first element returns null (let browser advance forward)", () => {
    expect(getNextFocusElement(A, focusables, false)).toBeNull();
  });

  it("Shift+Tab on the last element returns null (let browser go backward)", () => {
    expect(getNextFocusElement(C, focusables, true)).toBeNull();
  });

  it("returns null when there are no focusables (defensive)", () => {
    expect(getNextFocusElement(A, [], false)).toBeNull();
    expect(getNextFocusElement(A, [], true)).toBeNull();
  });

  it("active element not in the list returns null (don't trap unrelated focus)", () => {
    const D = { name: "outside" };
    expect(getNextFocusElement(D, focusables, false)).toBeNull();
    expect(getNextFocusElement(D, focusables, true)).toBeNull();
  });

  it("single focusable: Tab and Shift+Tab keep focus on it", () => {
    const single = [A] as const;
    expect(getNextFocusElement(A, single, false)).toBe(A);
    expect(getNextFocusElement(A, single, true)).toBe(A);
  });
});
