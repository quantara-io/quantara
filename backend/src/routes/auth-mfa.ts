import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";

import { alderoPost, alderoGet, alderoDelete, AlderoError } from "../lib/aldero-client.js";
import {
  MfaMethodsResponse,
  MfaTotpSetupResponse,
  MfaConfirmRequest,
  MfaConfirmResponse,
  MfaVerifyRequest,
  AuthSuccessResponse,
  SuccessResponse,
} from "../lib/schemas/auth.js";
import { ErrorResponse } from "../lib/schemas/common.js";
import { requireAuth } from "../middleware/require-auth.js";

const authMfa = new OpenAPIHono();

// All MFA routes except /mfa/verify require auth
authMfa.use("/mfa/methods", requireAuth);
authMfa.use("/mfa/totp/*", requireAuth);
authMfa.use("/mfa/email/*", requireAuth);
authMfa.use("/mfa/recovery/*", requireAuth);
authMfa.use("/mfa/authenticators", requireAuth);
authMfa.use("/mfa/authenticators/*", requireAuth);

// --- GET /mfa/methods ---
const methodsRoute = createRoute({
  method: "get",
  path: "/mfa/methods",
  tags: ["MFA"],
  summary: "List available and enrolled MFA methods",
  description: "Returns which MFA methods the user can enroll in and which are already enrolled.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: MfaMethodsResponse } },
      description: "MFA methods",
    },
  },
});

authMfa.openapi(methodsRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  try {
    const authenticators = (await alderoGet("/v1/auth/mfa/authenticators", token)) as Array<
      Record<string, unknown>
    >;
    const enrolled = (Array.isArray(authenticators) ? authenticators : []).map((a) => ({
      id: String(a.id ?? ""),
      type: String(a.authenticator_type ?? a.authenticatorType ?? a.type ?? ""),
      enrolledAt: String(a.enrolled_at ?? a.enrolledAt ?? a.createdAt ?? ""),
      ...(a.remaining_codes != null ? { remaining_codes: a.remaining_codes } : {}),
    }));
    return c.json({
      success: true as const,
      data: {
        available: ["totp", "email"] as const,
        enrolled,
      },
    });
  } catch {
    return c.json({
      success: true as const,
      data: { available: ["totp", "email"] as const, enrolled: [] },
    });
  }
});

// --- POST /mfa/totp/setup ---
const totpSetupRoute = createRoute({
  method: "post",
  path: "/mfa/totp/setup",
  tags: ["MFA"],
  summary: "Generate TOTP secret for enrollment",
  description: "Returns a TOTP secret and QR code URL. User scans with an authenticator app.",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: MfaTotpSetupResponse } },
      description: "TOTP setup data",
    },
  },
});

authMfa.openapi(totpSetupRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  try {
    const result = (await alderoPost("/v1/auth/mfa/totp/setup", {}, token)) as Record<
      string,
      unknown
    >;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    // 409 = pending setup exists — retry once (Aldero generates fresh secret)
    if (err instanceof AlderoError && err.statusCode === 409) {
      try {
        const result = (await alderoPost("/v1/auth/mfa/totp/setup", {}, token)) as Record<
          string,
          unknown
        >;
        return c.json({ success: true as const, data: result } as any);
      } catch {}
    }
    throw err;
  }
});

// --- POST /mfa/totp/confirm ---
const totpConfirmRoute = createRoute({
  method: "post",
  path: "/mfa/totp/confirm",
  tags: ["MFA"],
  summary: "Confirm TOTP enrollment",
  description: "Verify a TOTP code to complete enrollment. Returns one-time recovery codes.",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: MfaConfirmRequest } } } },
  responses: {
    200: {
      content: { "application/json": { schema: MfaConfirmResponse } },
      description: "Enrolled with recovery codes",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid code",
    },
  },
});

authMfa.openapi(totpConfirmRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const body = c.req.valid("json");
  try {
    const result = (await alderoPost("/v1/auth/mfa/totp/confirm", body, token)) as Record<
      string,
      unknown
    >;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json(
        { success: false as const, error: { code: "INVALID_CODE", message: err.message } },
        400,
      );
    }
    throw err;
  }
});

// --- POST /mfa/email/setup ---
const emailSetupRoute = createRoute({
  method: "post",
  path: "/mfa/email/setup",
  tags: ["MFA"],
  summary: "Setup email OTP MFA",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: SuccessResponse } },
      description: "Email OTP sent",
    },
  },
});

authMfa.openapi(emailSetupRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  await alderoPost("/v1/auth/mfa/email/setup", {}, token);
  return c.json({
    success: true as const,
    data: { message: "Verification code sent to your email" },
  });
});

// --- POST /mfa/email/confirm ---
const emailConfirmRoute = createRoute({
  method: "post",
  path: "/mfa/email/confirm",
  tags: ["MFA"],
  summary: "Confirm email OTP enrollment",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: MfaConfirmRequest } } } },
  responses: {
    200: {
      content: { "application/json": { schema: MfaConfirmResponse } },
      description: "Enrolled",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid code",
    },
  },
});

authMfa.openapi(emailConfirmRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const body = c.req.valid("json");
  try {
    const result = (await alderoPost("/v1/auth/mfa/email/confirm", body, token)) as Record<
      string,
      unknown
    >;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json(
        { success: false as const, error: { code: "INVALID_CODE", message: err.message } },
        400,
      );
    }
    throw err;
  }
});

// --- POST /mfa/verify ---
const verifyRoute = createRoute({
  method: "post",
  path: "/mfa/verify",
  tags: ["MFA"],
  summary: "Verify MFA challenge",
  description:
    "Complete the MFA step after login. Submit the mfaToken from login response with a verification code.",
  request: { body: { content: { "application/json": { schema: MfaVerifyRequest } } } },
  responses: {
    200: {
      content: { "application/json": { schema: AuthSuccessResponse } },
      description: "MFA verified, tokens issued",
    },
    401: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid code or token",
    },
  },
});

authMfa.openapi(verifyRoute, async (c) => {
  const body = c.req.valid("json");
  // Translate from Quantara's camelCase to Aldero's format
  const alderoBody = {
    mfa_token: body.mfaToken,
    method: body.method === "recovery_code" ? "recovery" : body.method,
    code: body.code,
    trustDevice: body.trustDevice,
  };
  try {
    const result = (await alderoPost("/v1/auth/mfa/verify", alderoBody)) as Record<string, unknown>;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json(
        { success: false as const, error: { code: "MFA_FAILED", message: err.message } },
        401,
      );
    }
    throw err;
  }
});

// --- POST /mfa/challenge --- (send email OTP during login)
const challengeRoute = createRoute({
  method: "post",
  path: "/mfa/challenge",
  tags: ["MFA"],
  summary: "Send email OTP code for MFA login",
  description:
    "Triggers an email code send during MFA login challenge. Use the mfaToken from the login response.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            mfaToken: z.string().describe("MFA token from login response"),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Code sent" },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Challenge failed",
    },
  },
});

authMfa.openapi(challengeRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    await alderoPost("/v1/auth/mfa/challenge", {
      mfa_token: body.mfaToken,
      challenge_type: "oob",
    });
    return c.json(
      { success: true as const, data: { message: "Verification code sent to your email" } },
      200,
    );
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json(
        { success: false as const, error: { code: "CHALLENGE_FAILED", message: err.message } },
        400,
      );
    }
    throw err;
  }
});

// --- POST /mfa/recovery/regenerate ---
const regenRoute = createRoute({
  method: "post",
  path: "/mfa/recovery/regenerate",
  tags: ["MFA"],
  summary: "Regenerate recovery codes",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: MfaConfirmResponse } },
      description: "New recovery codes",
    },
  },
});

authMfa.openapi(regenRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const result = (await alderoPost("/v1/auth/mfa/recovery-codes/regenerate", {}, token)) as Record<
    string,
    unknown
  >;
  return c.json({ success: true as const, data: result } as any);
});

// --- GET /mfa/authenticators ---
const listRoute = createRoute({
  method: "get",
  path: "/mfa/authenticators",
  tags: ["MFA"],
  summary: "List enrolled MFA authenticators",
  security: [{ Bearer: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: MfaMethodsResponse } },
      description: "Enrolled authenticators",
    },
  },
});

authMfa.openapi(listRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const result = (await alderoGet("/v1/auth/mfa/authenticators", token)) as unknown[];
  const enrolled = (Array.isArray(result) ? result : []).map((a: any) => ({
    id: String(a.id ?? a.authenticatorId ?? ""),
    type: String(a.type ?? a.authenticatorType ?? ""),
    enrolledAt: String(a.enrolledAt ?? a.createdAt ?? ""),
  }));
  return c.json({
    success: true as const,
    data: { available: ["totp", "email"] as const, enrolled },
  });
});

// --- DELETE /mfa/authenticators/:id ---
const deleteRoute = createRoute({
  method: "delete",
  path: "/mfa/authenticators/:id",
  tags: ["MFA"],
  summary: "Remove an MFA authenticator",
  security: [{ Bearer: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Removed" },
  },
});

authMfa.openapi(deleteRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const { id } = c.req.valid("param");
  await alderoDelete(`/v1/auth/mfa/authenticators/${id}`, token);
  return c.json({ success: true as const, data: { message: "Authenticator removed" } });
});

export { authMfa };
