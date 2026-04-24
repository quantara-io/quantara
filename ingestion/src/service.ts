import { MarketStreamManager } from "./exchanges/stream.js";
import { NewsPoller } from "./news/poller.js";
import { startHealthServer } from "./lib/health.js";

const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "8080");

async function main(): Promise<void> {
  console.log("[Service] Starting ingestion service...");

  const marketStream = new MarketStreamManager();
  const newsPoller = new NewsPoller();

  // Health check endpoint
  startHealthServer(HEALTH_PORT, {
    getStatus: () => ({
      ...marketStream.getStatus(),
      news: newsPoller.getStatus(),
    }),
  });

  // Start market WebSocket streaming
  await marketStream.start();

  // Start news polling
  newsPoller.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[Service] Received ${signal}, shutting down...`);
    newsPoller.stop();
    await marketStream.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log("[Service] Ingestion service running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[Service] Fatal error:", err);
  process.exit(1);
});
