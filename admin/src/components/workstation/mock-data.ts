/**
 * mock-data — Single source of truth for workstation mock data.
 *
 * Quantara backend doesn't expose position data yet — these stubs let
 * PositionRail render, /close preview show real-looking numbers, and tests
 * assert against a stable record. When `/api/admin/positions/:pair` lands
 * these get swapped out for real fetches.
 */

export interface MockPosition {
  symbol: string;
  size: number;
  /** Average entry price. */
  entry: number;
  /** Current mark price (live PnL anchor). */
  mark: number;
  /** Unrealised PnL in USD. */
  pnl: number;
  /** Unrealised PnL as a percentage of entry. */
  pnlPct: number;
  side: "long" | "short";
}

/**
 * Canonical mock position used by PositionRail (rail render) and the
 * /close command preview (cmdk-commands).
 */
export const MOCK_POSITION: MockPosition = {
  symbol: "BTC",
  size: 8.42,
  entry: 69_568,
  mark: 71_092,
  pnl: 1_858.74,
  pnlPct: 2.61,
  side: "long",
};
