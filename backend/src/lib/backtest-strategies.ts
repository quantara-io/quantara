/**
 * backtest-strategies.ts — Phase 4 (issue #371).
 *
 * Thin re-export of the auto-derived strategy registry that lives in the
 * backtest workspace. Adding a new strategy is a single-file edit in
 * `backtest/strategies/index.ts` — no second registry to keep in sync.
 *
 * Resolves PR #376 review finding 8 (hardcoded strategy array).
 */

import { listStrategies, type StrategyMeta } from "quantara-backtest";

export type { StrategyMeta };

/**
 * Memoised view of the registry. Snapshotted once at module load — the list
 * only changes when a strategy file is added (cold-start picks it up).
 */
export const BACKTEST_STRATEGIES: ReadonlyArray<StrategyMeta> = listStrategies();
