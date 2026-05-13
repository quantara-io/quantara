/**
 * Strategy registry — Phase 4 (issue #371).
 *
 * Derives the public strategy list from the modules in `backtest/strategies/`
 * via the curated index in `backtest/strategies/index.ts`. There is exactly
 * one place where a new strategy needs to be added (that index file's
 * import + array). The backend admin route and the Fargate runner both call
 * `listStrategies()` from here.
 *
 * Why a separate file from `backtest/strategies/index.ts`?
 *   - The strategies dir contains the strategy module *implementations*.
 *   - This file is the public registry API the rest of the codebase consumes
 *     (`StrategyMeta` is a UI-friendly subset, not the full Strategy).
 *
 * Resolves PR #376 review finding 8 (hardcoded strategy list in
 * `backend/src/lib/backtest-strategies.ts`).
 */

import { STRATEGIES } from "../strategies/index.js";
import type { Strategy } from "./strategy/types.js";

/**
 * UI-friendly strategy metadata — what the dropdown in BacktestNew.tsx renders.
 * Keep this subset minimal so changes to Strategy internals don't break the API
 * contract.
 */
export interface StrategyMeta {
  name: string;
  description: string;
}

/**
 * Return the registered strategies as `StrategyMeta[]`. Source of truth is the
 * `STRATEGIES` array in `backtest/strategies/index.ts`.
 */
export function listStrategies(): StrategyMeta[] {
  return STRATEGIES.map((s) => ({
    name: s.name,
    description: s.description,
  }));
}

/**
 * Look up a Strategy by name. Returns undefined when not found — callers
 * should 400 the request.
 */
export function getStrategy(name: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.name === name);
}
