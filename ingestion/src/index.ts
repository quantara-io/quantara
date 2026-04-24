import type { ScheduledEvent, Context } from "aws-lambda";
import { fetchAllPrices } from "./exchanges/fetcher.js";
import { storePriceSnapshots } from "./lib/store.js";

export async function handler(_event: ScheduledEvent, _context: Context): Promise<void> {
  console.log("[Ingestion] Starting price fetch...");
  const startTime = Date.now();

  const snapshots = await fetchAllPrices();

  if (snapshots.length === 0) {
    console.error("[Ingestion] No prices fetched — all exchanges failed");
    return;
  }

  await storePriceSnapshots(snapshots);

  const duration = Date.now() - startTime;
  console.log(`[Ingestion] Complete: ${snapshots.length} snapshots in ${duration}ms`);
}
