import { fetchAllPrices } from "./exchanges/fetcher.js";
import { storePriceSnapshots } from "./lib/store.js";

async function main() {
  console.log("Running local price ingestion...\n");

  const snapshots = await fetchAllPrices();

  console.log("\n--- Price Snapshots ---");
  for (const s of snapshots) {
    const staleFlag = s.stale ? " [STALE]" : "";
    console.log(
      `${s.pair.padEnd(10)} ${s.exchange.padEnd(10)} $${s.price.toFixed(2).padStart(12)}  bid:${s.bid.toFixed(2)} ask:${s.ask.toFixed(2)}  vol:${s.volume24h.toFixed(0)}${staleFlag}`,
    );
  }

  // Optionally store to DynamoDB if TABLE_PREFIX is set
  if (process.env.TABLE_PREFIX) {
    await storePriceSnapshots(snapshots);
    console.log("\nStored to DynamoDB.");
  } else {
    console.log("\nSkipped DynamoDB store (no TABLE_PREFIX set). Set TABLE_PREFIX to write.");
  }
}

main().catch(console.error);
