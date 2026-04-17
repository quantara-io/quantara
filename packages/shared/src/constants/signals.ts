import type { SignalType } from "../types/signals.js";

export const SIGNAL_COLORS: Record<SignalType, { themeA: string; themeB: string }> = {
  buy:  { themeA: "#2EE6A8", themeB: "#7FD494" },
  sell: { themeA: "#FF5C7A", themeB: "#E56B5F" },
  hold: { themeA: "#FFB547", themeB: "#F0B94A" },
};

export const ADVISORY_DISCLAIMER =
  "Signals are for educational and advisory purposes only. Quantara does not execute trades on your behalf.";

export const VOLATILITY_BANNER =
  "High market volatility detected. All signals set to HOLD. Exercise caution.";
