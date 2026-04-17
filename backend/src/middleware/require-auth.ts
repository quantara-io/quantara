import type { Context, Next } from "hono";
import { authenticate, type AuthContext } from "./auth.js";
import { AppError } from "../lib/errors.js";

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export async function requireAuth(c: Context, next: Next) {
  try {
    const auth = await authenticate(c.req.header("Authorization"));
    c.set("auth", auth);
    await next();
  } catch (err) {
    if (err instanceof AppError) {
      return c.json({ success: false, error: { code: err.code, message: err.message } }, err.statusCode as 401);
    }
    throw err;
  }
}
