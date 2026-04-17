import { Hono } from "hono";

const health = new Hono();

health.get("/", (c) =>
  c.json({
    status: "ok",
    service: "quantara-api",
    timestamp: new Date().toISOString(),
  }),
);

export { health };
