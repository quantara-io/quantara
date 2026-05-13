/**
 * equity/types.ts — Phase 3 equity-curve types.
 */

// ---------------------------------------------------------------------------
// Equity point
// ---------------------------------------------------------------------------

export interface EquityPoint {
  /** ISO timestamp of the signal that produced this equity update. */
  ts: string;
  /** Notional equity level, starts at 1.0. */
  equity: number;
  /** Peak-to-trough drawdown since strategy start (0-1, where 0.10 = 10% drawdown). */
  drawdownPct: number;
  /** Total signals processed up to and including this point. */
  signalsToDate: number;
  /** Total correct (win) signals up to and including this point. */
  winsToDate: number;
}

// ---------------------------------------------------------------------------
// Equity curve
// ---------------------------------------------------------------------------

export interface EquityCurve {
  points: EquityPoint[];
  peakEquity: number;
  trough: { ts: string; equity: number };
  maxDrawdownPct: number;
  finalEquity: number;
  /**
   * Annualized Sharpe ratio.
   * null when std dev is 0 or fewer than SHARPE_MIN_SIGNALS resolved signals.
   */
  sharpeAnnualized: number | null;
}

// ---------------------------------------------------------------------------
// Drawdown period
// ---------------------------------------------------------------------------

export interface DrawdownPeriod {
  /** Start of drawdown (date of peak). */
  startTs: string;
  /** Date of trough (lowest equity during the drawdown). */
  troughTs: string;
  /** Date of recovery to the prior peak (or "ongoing" if not yet recovered). */
  recoveryTs: string | null;
  /** Drawdown magnitude (0-1). */
  drawdownPct: number;
}
