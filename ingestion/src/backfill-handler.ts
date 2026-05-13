import type { Context } from "aws-lambda";
import type { Timeframe } from "@quantara/shared";

import { backfillCandles } from "./exchanges/backfill.js";
import type { ExchangeId, TradingPair } from "./exchanges/config.js";

interface BackfillEvent {
  exchange: ExchangeId;
  pair: TradingPair;
  timeframe: Timeframe;
  days: number;
  force?: boolean;
  /** When set, writes candles to this table instead of the default candles table. */
  targetTable?: string;
}

export async function handler(event: BackfillEvent, _context: Context): Promise<{ total: number }> {
  console.log("[Backfill] Invoked with:", JSON.stringify(event));

  const { exchange, pair, timeframe = "1h", days = 7, force = false, targetTable } = event;

  if (!exchange || !pair) {
    throw new Error("Missing required fields: exchange, pair");
  }

  const total = await backfillCandles({
    exchangeId: exchange,
    pair,
    timeframe,
    days,
    force,
    ...(targetTable !== undefined && { targetTable }),
  });

  return { total };
}
