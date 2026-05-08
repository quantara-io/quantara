import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";

const health = new OpenAPIHono();

const HealthResponse = z
  .object({
    status: z.string(),
    service: z.string(),
    timestamp: z.string(),
  })
  .openapi("HealthResponse");

const healthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["System"],
  summary: "Health check",
  responses: {
    200: {
      content: { "application/json": { schema: HealthResponse } },
      description: "Service is healthy",
    },
  },
});

health.openapi(healthRoute, (c) => {
  return c.json({
    status: "ok",
    service: "quantara-api",
    timestamp: new Date().toISOString(),
  });
});

export { health };
