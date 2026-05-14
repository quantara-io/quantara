/**
 * Strategy registry — Phase 4 (issue #371).
 *
 * Auto-derived from the strategy files in this directory. Adding a new
 * strategy is a 2-step process:
 *
 *   1. Create the file (e.g. `my-new-strategy.ts`) with a default export
 *      matching the `Strategy` interface.
 *   2. Add the import + entry to the `STRATEGIES` array below.
 *
 * The list is exported via `listStrategies()` from
 * `backtest/src/strategies-registry.ts`, which the backend's
 * `GET /admin/backtest/strategies` route reads. There's no hand-maintained
 * second list elsewhere — both the runner and the admin UI consume this
 * single source of truth.
 *
 * Why not glob the directory at runtime? The backend API Lambda runs without
 * filesystem access to this directory, and esbuild can't statically include
 * a dynamic-glob set. An explicit array is honest, type-checked, and the
 * one-line addition is the price for cross-workspace portability.
 */

import type { Strategy } from "../src/strategy/types.js";

import productionDefault from "./production-default.js";
import aggressive1dWeighted from "./aggressive-1d-weighted.js";
import disableBollingerTouchUpper from "./disable-bollinger-touch-upper.js";
import weightTheWinners from "./weight-the-winners.js";
import longerHold from "./longer-hold.js";

export const STRATEGIES: ReadonlyArray<Strategy> = [
  productionDefault,
  aggressive1dWeighted,
  disableBollingerTouchUpper,
  weightTheWinners,
  longerHold,
] as const;
