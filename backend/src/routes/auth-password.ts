// @ts-nocheck — proxy routes return dynamic Aldero responses
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { alderoPost, AlderoError } from "../lib/aldero-client.js";
import {
  MagicLinkRequest, MagicLinkVerifyRequest, AuthSuccessResponse,
  PasswordResetRequest, PasswordResetConfirm,
  EmailVerifySendRequest, EmailVerifyConfirmRequest, SuccessResponse,
} from "../lib/schemas/auth.js";
import { ErrorResponse } from "../lib/schemas/common.js";
import { requireAuth } from "../middleware/require-auth.js";

const authPassword = new OpenAPIHono();

// Protected routes
authPassword.use("/email/verify/*", requireAuth);

// --- POST /magic-link/request ---
const magicLinkRoute = createRoute({
  method: "post",
  path: "/magic-link/request",
  tags: ["Auth"],
  summary: "Request a magic link",
  description: "Sends a passwordless login link to the user's email. Link expires in 10 minutes.",
  request: { body: { content: { "application/json": { schema: MagicLinkRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Magic link sent" },
  },
});

authPassword.openapi(magicLinkRoute, async (c) => {
  const body = c.req.valid("json");
  const origin = c.req.header("Origin") || c.req.header("Referer")?.split("/api")[0] || "";
  const redirectUrl = (body as any).redirectUri || (origin ? origin + "/api/docs/demo?magic=true" : undefined);
  try {
    await alderoPost("/v1/auth/magic-link/request", {
      email: body.email,
      ...(redirectUrl ? { redirectUrl } : {}),
    });
  } catch {
    // Always return success to prevent email enumeration
  }
  return c.json({ success: true as const, data: { message: "If an account exists, a magic link has been sent" } });
});

// --- POST /magic-link/verify ---
const magicLinkVerifyRoute = createRoute({
  method: "post",
  path: "/magic-link/verify",
  tags: ["Auth"],
  summary: "Verify magic link token",
  description: "Exchange the magic link token for access tokens.",
  request: { body: { content: { "application/json": { schema: MagicLinkVerifyRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: AuthSuccessResponse } }, description: "Login successful" },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid or expired token" },
  },
});

authPassword.openapi(magicLinkVerifyRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const result = await alderoPost("/v1/auth/magic-link/verify", body) as Record<string, unknown>;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "INVALID_TOKEN", message: err.message } }, 401);
    }
    throw err;
  }
});

// --- POST /password/reset-request ---
const resetRequestRoute = createRoute({
  method: "post",
  path: "/password/reset-request",
  tags: ["Auth"],
  summary: "Request password reset",
  description: "Sends a password reset email. Link expires in 1 hour.",
  request: { body: { content: { "application/json": { schema: PasswordResetRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Reset email sent" },
  },
});

authPassword.openapi(resetRequestRoute, async (c) => {
  const body = c.req.valid("json");
  const origin = c.req.header("Origin") || c.req.header("Referer")?.split("/api")[0] || "";
  const redirectUrl = origin ? origin + "/api/docs/demo?reset=true" : undefined;
  try {
    await alderoPost("/v1/auth/password/reset-request", {
      email: body.email,
      ...(redirectUrl ? { redirectUrl } : {}),
    });
  } catch {
    // Always return success to prevent email enumeration
  }
  return c.json({ success: true as const, data: { message: "If an account exists, a reset link has been sent" } });
});

// --- POST /password/reset ---
const resetRoute = createRoute({
  method: "post",
  path: "/password/reset",
  tags: ["Auth"],
  summary: "Reset password with token",
  description: "Set a new password using the token from the reset email.",
  request: { body: { content: { "application/json": { schema: PasswordResetConfirm } } } },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Password reset" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid or expired token" },
  },
});

authPassword.openapi(resetRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    await alderoPost("/v1/auth/password/reset", body);
    return c.json({ success: true as const, data: { message: "Password has been reset" } });
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "RESET_FAILED", message: err.message } }, 400);
    }
    throw err;
  }
});

// --- POST /email/verify/send ---
const verifyEmailSendRoute = createRoute({
  method: "post",
  path: "/email/verify/send",
  tags: ["Auth"],
  summary: "Send email verification code",
  description: "Sends a 6-digit verification code to the user's email.",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: EmailVerifySendRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Code sent" },
  },
});

authPassword.openapi(verifyEmailSendRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const body = c.req.valid("json");
  await alderoPost("/v1/auth/email/verify/send", body, token);
  return c.json({ success: true as const, data: { message: "Verification code sent" } });
});

// --- POST /email/verify/confirm ---
const verifyEmailConfirmRoute = createRoute({
  method: "post",
  path: "/email/verify/confirm",
  tags: ["Auth"],
  summary: "Confirm email with verification code",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: EmailVerifyConfirmRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Email verified" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid code" },
  },
});

authPassword.openapi(verifyEmailConfirmRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const body = c.req.valid("json");
  try {
    await alderoPost("/v1/auth/email/verify/confirm-code", body, token);
    return c.json({ success: true as const, data: { message: "Email verified" } });
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "INVALID_CODE", message: err.message } }, 400);
    }
    throw err;
  }
});

export { authPassword };
