import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const authenticateMock = vi.fn();
vi.mock("./auth.js", () => ({
  authenticate: authenticateMock,
}));

beforeEach(() => {
  vi.resetModules();
  authenticateMock.mockReset();
});

async function buildApp() {
  const { requireAuth } = await import("./require-auth.js");
  const app = new Hono();
  app.use(requireAuth);
  app.get("/", (c) => c.json({ auth: c.get("auth") }));
  return app;
}

describe("requireAuth", () => {
  it("returns the AppError code/message as JSON when authenticate throws an AppError", async () => {
    // Dynamic import of UnauthorizedError so we share the same class
    // instance with require-auth.js after vi.resetModules() — instanceof
    // checks against a stale top-level import would silently fall through.
    const { UnauthorizedError } = await import("../lib/errors.js");
    authenticateMock.mockRejectedValue(new UnauthorizedError("Missing or invalid Authorization header"));
    const app = await buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Missing or invalid Authorization header" },
    });
  });

  it("propagates non-AppError exceptions to Hono's error boundary", async () => {
    authenticateMock.mockRejectedValue(new Error("jwks fetch timed out"));
    const app = await buildApp();
    // Hono swallows uncaught errors as 500 by default; the point is that
    // requireAuth itself didn't shape the response — the framework did.
    const res = await app.request("/");
    expect(res.status).toBe(500);
  });

  it("sets the auth context and calls next on success", async () => {
    const ctx = { userId: "user_123", email: "a@b.com" };
    authenticateMock.mockResolvedValue(ctx);
    const app = await buildApp();
    const res = await app.request("/", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.auth).toEqual(ctx);
    expect(authenticateMock).toHaveBeenCalledWith("Bearer t");
  });
});
