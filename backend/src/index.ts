import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { handle } from "hono/aws-lambda";
import { AppError } from "./lib/errors.js";
import { health } from "./routes/health.js";
import { genie } from "./routes/genie.js";
import { coach } from "./routes/coach.js";
import { dealflow } from "./routes/dealflow.js";
import { marketing } from "./routes/marketing.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({
  origin: process.env.CORS_ORIGIN ?? "*",
  allowHeaders: ["Authorization", "Content-Type"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  maxAge: 86400,
}));

app.route("/health", health);
app.route("/api/genie", genie);
app.route("/api/coach", coach);
app.route("/api/dealflow", dealflow);
app.route("/api/marketing", marketing);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ success: false, error: { code: err.code, message: err.message } }, err.statusCode as 500);
  }
  console.error("[Unhandled]", err);
  return c.json({ success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }, 500);
});

app.notFound((c) =>
  c.json({ success: false, error: { code: "NOT_FOUND", message: `Route not found: ${c.req.method} ${c.req.path}` } }, 404),
);

export default app;
export const handler = handle(app);
