import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { handle } from "hono/aws-lambda";

import { AppError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { AlderoError } from "./lib/aldero-client.js";
import { requireApiKey } from "./middleware/api-key.js";
import { ipWhitelist } from "./middleware/ip-whitelist.js";
import { health } from "./routes/health.js";
import { auth } from "./routes/auth.js";
import { authOAuth } from "./routes/auth-oauth.js";
import { authMfa } from "./routes/auth-mfa.js";
import { authPasskey } from "./routes/auth-passkey.js";
import { authPassword } from "./routes/auth-password.js";
import { demo } from "./routes/demo.js";
import { authDocs } from "./routes/auth-docs.js";
import { admin } from "./routes/admin.js";

const app = new OpenAPIHono();

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - start,
    },
    "request",
  );
});

const CORS_ORIGIN = process.env.CORS_ORIGIN;
if (!CORS_ORIGIN) {
  throw new Error(
    "CORS_ORIGIN must be set (e.g. a specific https:// origin, comma-separated list, or '*' for local dev)",
  );
}
const CORS_ORIGINS = CORS_ORIGIN.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (CORS_ORIGINS.includes("*")) return origin || "*";
      return CORS_ORIGINS.includes(origin) ? origin : null;
    },
    allowHeaders: ["Authorization", "Content-Type", "X-Api-Key"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    maxAge: 86400,
  }),
);

// --- Routes ---
app.route("/health", health); // public — no API key

// Temporary: debug endpoint to see what IP Lambda receives
app.get("/debug/ip", (c) => {
  return c.json({
    xff: c.req.header("x-forwarded-for") ?? "none",
    xRealIp: c.req.header("x-real-ip") ?? "none",
    cloudFrontIp: c.req.header("cloudfront-viewer-address") ?? "none",
    firstXff: (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim(),
  });
});

// IP whitelist for docs pages
app.use("/api/docs", ipWhitelist);
app.use("/api/docs/*", ipWhitelist);
app.use("/api/openapi.json", ipWhitelist);

// Demo site (IP whitelisted, no API key)
app.route("/api/docs/demo", demo);

// Auth integration guide (IP whitelisted, no API key)
app.route("/api/docs/auth", authDocs);

// API key required for all /api/* routes (except docs)
app.use("/api/*", async (c, next) => {
  if (
    c.req.path === "/api/docs" ||
    c.req.path.startsWith("/api/docs/") ||
    c.req.path === "/api/openapi.json" ||
    c.req.path.startsWith("/api/auth/oauth/")
  ) {
    return next();
  }
  return requireApiKey(c, next);
});

// Auth (no prefix — mounted at /api/auth/*)
app.route("/api/auth", auth);
app.route("/api/auth", authOAuth);
app.route("/api/auth", authMfa);
app.route("/api/auth", authPasskey);
app.route("/api/auth", authPassword);

app.route("/api/admin", admin);

// --- OpenAPI spec (dynamic servers per environment) ---
const ENV = process.env.ENVIRONMENT ?? "dev";
const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL ?? "";
const API_SERVERS = [
  { url: "http://localhost:3001", description: "Local" },
  ...(CLOUDFRONT_URL
    ? [{ url: CLOUDFRONT_URL, description: `${ENV === "prod" ? "Production" : "Dev"} (CDN)` }]
    : []),
  ...(ENV === "prod"
    ? [{ url: "https://api.quantara.io", description: "Production" }]
    : [
        {
          url: "https://69ybmfzl81.execute-api.us-west-2.amazonaws.com",
          description: "Dev (API Gateway)",
        },
      ]),
];

app.doc("/api/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Quantara Global API",
    version: "1.0.0",
    description: `Crypto AI prediction engine, coaching, deal flow, and marketing platform. Environment: ${ENV}`,
  },
  servers: API_SERVERS,
  security: [{ ApiKey: [] }, { Bearer: [] }],
});

// --- Scalar API Reference (interactive docs) ---
app.get(
  "/api/docs",
  Scalar({
    url: "/api/openapi.json",
    pageTitle: "Quantara API Reference",
  }),
);

// --- OpenAPI security scheme ---
app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "JWT access token from /api/auth/login",
});

app.openAPIRegistry.registerComponent("securitySchemes", "ApiKey", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
  description: "Client API key — identifies which app is calling (dashboard, mobile, landing)",
});

// --- Error handling ---
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { success: false, error: { code: err.code, message: err.message } },
      err.statusCode as 500,
    );
  }
  if (err instanceof AlderoError) {
    const code =
      err.statusCode === 401
        ? "UNAUTHORIZED"
        : err.statusCode === 403
          ? "FORBIDDEN"
          : err.statusCode === 409
            ? "CONFLICT"
            : err.statusCode === 429
              ? "RATE_LIMITED"
              : "REQUEST_FAILED";
    return c.json({ success: false, error: { code, message: err.message } }, err.statusCode as 500);
  }
  logger.error({ err, path: c.req.path, method: c.req.method }, "unhandled error");
  return c.json(
    { success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
    500,
  );
});

app.notFound((c) =>
  c.json(
    {
      success: false,
      error: { code: "NOT_FOUND", message: `Route not found: ${c.req.method} ${c.req.path}` },
    },
    404,
  ),
);

export default app;
export const handler = handle(app);
