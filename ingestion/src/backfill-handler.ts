import type { Context } from "aws-lambda";
import type { Timeframe } from "@quantara/shared";
import { backfillCandles } from "./exchanges/backfill.js";
import type { ExchangeId, TradingPair } from "./exchanges/config.js";

interface BackfillEvent {
  exchange: ExchangeId;
  pair: TradingPair;
  timeframe: Timeframe;
  days: number;
}

export async function handler(event: BackfillEvent, _context: Context): Promise<{ total: number }> {
  console.log("[Backfill] Invoked with:", JSON.stringify(event));

  const { exchange, pair, timeframe = "1h", days = 90 } = event;

  if (!exchange || !pair) {
    throw new Error("Missing required fields: exchange, pair");
  }

  const total = await backfillCandles({
    exchangeId: exchange,
    pair,
    timeframe,
    days,
  });

  return { total };
}
