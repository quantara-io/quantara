import { describe, it, expect } from "vitest";
import { Hono } from "hono";

import { requireAdmin } from "./require-admin.js";

function buildApp(auth: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (auth !== undefined) c.set("auth", auth as never);
    await next();
  });
  app.use("*", requireAdmin);
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

describe("requireAdmin", () => {
  it("returns 403 when auth is missing entirely", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: { code: string } };
    expect(body).toEqual({
      success: false,
      error: { code: "FORBIDDEN", message: "Admin role required" },
    });
  });

  it("returns 403 when role is not admin", async () => {
    const app = buildApp({ userId: "u_1", role: "user" });
    const res = await app.request("/");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 403 when role is undefined", async () => {
    const app = buildApp({ userId: "u_1" });
    const res = await app.request("/");
    expect(res.status).toBe(403);
  });

  it("calls next when role is admin", async () => {
    const app = buildApp({ userId: "u_1", role: "admin" });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
