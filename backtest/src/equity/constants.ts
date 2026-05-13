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

/**
 * Round-trip transaction cost in basis points (slippage + fees, entry + exit
 * combined). Matches issue #370's "15 bps round-trip" specification.
 *
 * Composition (informational): ~5 bps slippage + ~10 bps exchange fees,
 * totalled across both legs (open + close) of a position. The full 15 bps is
 * charged ONCE per resolved directional signal in the equity simulator —
 * not per leg.
 */
export const ROUND_TRIP_COST_BPS = 15;

/** Round-trip transaction cost as a decimal fraction (15 bps = 0.0015). */
export const ROUND_TRIP_COST = ROUND_TRIP_COST_BPS * 1e-4;

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
