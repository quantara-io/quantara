import { createServer } from "node:http";

interface HealthStatus {
  getStatus: () => Record<string, unknown>;
}

export function startHealthServer(port: number, statusProvider: HealthStatus): void {
  const server = createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const body = JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        ...statusProvider.getStatus(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[Health] Listening on :${port}/health`);
  });
}
