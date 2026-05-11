/**
 * Unit tests for PositionRail's pure render-mode selector.
 *
 * Issue #331 spec calls for an assertion that when `closed={true}` the rail
 * renders the "Position closed" placeholder. The admin vitest config is
 * `environment: "node"` + `include: ["src/**\/*.test.ts"]` — no jsdom, no
 * React Testing Library. So we exercise the pure helper `positionRailMode`
 * that drives the component's render branch, plus assert the exported label
 * string the closed branch uses.
 *
 * This is the same pattern as `CommandPalette.test.ts` (pure helpers tested,
 * JSX render covered by manual test plan).
 */

import { describe, it, expect } from "vitest";

import { positionRailMode, POSITION_CLOSED_LABEL } from "./PositionRail";

describe("positionRailMode", () => {
  it("returns 'closed' when closed=true", () => {
    expect(positionRailMode(true)).toBe("closed");
  });

  it("returns 'card' when closed=false", () => {
    expect(positionRailMode(false)).toBe("card");
  });

  it("returns 'card' when closed is undefined (default render)", () => {
    expect(positionRailMode(undefined)).toBe("card");
  });
});

describe("POSITION_CLOSED_LABEL", () => {
  it("is the human-readable closed-state placeholder text", () => {
    // Snapshot-style: lock the user-visible string so a stray typo (or a
    // refactor that drops the period) trips this test.
    expect(POSITION_CLOSED_LABEL).toBe("Position closed.");
  });
});
