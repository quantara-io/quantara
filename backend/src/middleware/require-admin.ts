import type { Context, Next } from "hono";

export async function requireAdmin(c: Context, next: Next) {
  const auth = c.var.auth;
  if (auth?.role !== "admin") {
    return c.json(
      { success: false, error: { code: "FORBIDDEN", message: "Admin role required" } },
      403,
    );
  }
  await next();
}
