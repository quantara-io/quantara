/**
 * equity/constants.ts — Phase 3 configurable sizing and transaction-cost constants.
 *
 * All constants are in decimal form (0.0015 = 15 bps).
 * Editing this file is the intended tuning surface — no other file needs to change
 * when adjusting the cost model.
 */

// ---------------------------------------------------------------------------
// Transaction costs
// ---------------------------------------------------------------------------

/** Slippage per-side in bps. Production estimate: 5 bps. */
export const SLIPPAGE_BPS = 5;

/** Exchange fee per-side in bps. Production estimate: 10 bps. */
export const FEE_BPS = 10;

/** Round-trip transaction cost (entry + exit) as a decimal fraction. */
export const ROUND_TRIP_COST = (SLIPPAGE_BPS + FEE_BPS) * 2 * 1e-4;

// ---------------------------------------------------------------------------
// Sizing defaults
// ---------------------------------------------------------------------------

/** Default fixed-pct position size when strategy.sizing.kind === "fixed-pct". */
export const DEFAULT_FIXED_PCT = 0.02;

/** Minimum position size (safety floor to avoid degenerate bets). */
export const MIN_POSITION_SIZE = 0.001;

/** Maximum position size (safety cap — no more than 20% in one bet). */
export const MAX_POSITION_SIZE = 0.2;

// ---------------------------------------------------------------------------
// Sharpe annualization
// ---------------------------------------------------------------------------

/**
 * Annualization factor for Sharpe computation.
 * 252 trading days/year × 6.5 hours/day × 4 bars/hour (15m signal TF).
 * Adjust if the primary TF changes.
 */
export const SHARPE_ANNUALIZATION_FACTOR = Math.sqrt(252 * 6.5 * 4);

/** Minimum number of resolved signals required to compute annualized Sharpe. */
export const SHARPE_MIN_SIGNALS = 30;
