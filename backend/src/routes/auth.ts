import { OpenAPIHono, createRoute } from "@hono/zod-openapi";

import { alderoPost, alderoGet, AlderoError } from "../lib/aldero-client.js";
import {
  SignupRequest, LoginRequest, AuthSuccessResponse, RefreshRequest, RefreshResponse,
  AuthConfigResponse, UpdateProfileRequest, SuccessResponse,
} from "../lib/schemas/auth.js";
import { ErrorResponse } from "../lib/schemas/common.js";
import { requireAuth } from "../middleware/require-auth.js";

const auth = new OpenAPIHono();

// Protected paths
auth.use("/me", requireAuth);
auth.use("/me/*", requireAuth);
auth.use("/logout", requireAuth);

// --- GET /config (public) ---
const configRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Auth"],
  summary: "Get supported auth methods",
  description: "Returns which auth methods, MFA policies, and OAuth providers are enabled. No authentication required.",
  responses: {
    200: { content: { "application/json": { schema: AuthConfigResponse } }, description: "Auth configuration" },
  },
});

auth.openapi(configRoute, async (c) => {
  // Confirm Aldero discovery is reachable, then return our static config.
  try {
    await alderoGet("/.well-known/openid-configuration");
    return c.json({
      success: true as const,
      data: {
        authMethods: ["email_password", "oauth_google", "oauth_apple", "magic_link", "passkey"],
        mfaPolicy: "optional" as const,
        mfaMethods: ["totp", "email"] as const,
        passkeyEnabled: true,
        oauthProviders: ["google", "apple"],
      },
    });
  } catch {
    return c.json({
      success: true as const,
      data: {
        authMethods: ["email_password"],
        mfaPolicy: "optional" as const,
        mfaMethods: ["totp", "email"] as const,
        passkeyEnabled: false,
        oauthProviders: [],
      },
    });
  }
});

// --- POST /signup ---
const signupRoute = createRoute({
  method: "post",
  path: "/signup",
  tags: ["Auth"],
  summary: "Sign up with email and password",
  request: { body: { content: { "application/json": { schema: SignupRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: AuthSuccessResponse } }, description: "Account created" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error" },
    409: { content: { "application/json": { schema: ErrorResponse } }, description: "Email already exists" },
  },
});

auth.openapi(signupRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const result = await alderoPost("/v1/auth/signup", body) as Record<string, unknown>;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "SIGNUP_FAILED", message: err.message } }, err.statusCode as 400);
    }
    throw err;
  }
});

// --- POST /login ---
const loginRoute = createRoute({
  method: "post",
  path: "/login",
  tags: ["Auth"],
  summary: "Login with email and password",
  description: "Returns tokens on success. If MFA is enrolled, returns mfaRequired=true with mfaToken for the next step.",
  request: { body: { content: { "application/json": { schema: LoginRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: AuthSuccessResponse } }, description: "Login successful or MFA required" },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid credentials" },
    423: { content: { "application/json": { schema: ErrorResponse } }, description: "Account locked" },
  },
});

auth.openapi(loginRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const result = await alderoPost("/v1/auth/login", body) as Record<string, unknown>;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      // Aldero returns 403 with error="mfa_required" when MFA is enrolled
      const errBody = err.body as Record<string, unknown>;
      if (errBody?.error === "mfa_required") {
        return c.json({
          success: true as const,
          data: {
            mfaRequired: true,
            mfaToken: errBody.mfa_token,
            availableMethods: errBody.available_methods,
          },
        } as any);
      }
      const code = err.statusCode === 423 ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS";
      return c.json({ success: false as const, error: { code, message: err.message } }, err.statusCode as 401);
    }
    throw err;
  }
});

// --- POST /logout ---
const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Auth"],
  summary: "Logout and revoke session",
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Logged out" },
  },
});

auth.openapi(logoutRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  try {
    await alderoPost("/v1/auth/logout", {}, token);
  } catch {
    // Logout should always succeed from client's perspective
  }
  return c.json({ success: true as const, data: { message: "Logged out" } });
});

// --- POST /token/refresh ---
const refreshRoute = createRoute({
  method: "post",
  path: "/token/refresh",
  tags: ["Auth"],
  summary: "Refresh access token",
  request: { body: { content: { "application/json": { schema: RefreshRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: RefreshResponse } }, description: "New tokens" },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid refresh token" },
  },
});

auth.openapi(refreshRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const result = await alderoPost("/v1/auth/token/refresh", body) as Record<string, unknown>;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "INVALID_TOKEN", message: err.message } }, 401);
    }
    throw err;
  }
});

// --- GET /me ---
const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  summary: "Get current user profile",
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { "application/json": { schema: AuthSuccessResponse } }, description: "User profile" },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Not authenticated" },
  },
});

auth.openapi(meRoute, async (c) => {
  // User profile is extracted from JWT claims by requireAuth middleware
  const authCtx = c.get("auth") as any;
  return c.json({
    success: true as const,
    data: {
      user: {
        userId: authCtx.userId,
        email: authCtx.email,
        emailVerified: authCtx.emailVerified,
        displayName: null,
        role: authCtx.role,
      },
    },
  } as any);
});

// --- PATCH /me ---
const updateMeRoute = createRoute({
  method: "patch",
  path: "/me",
  tags: ["Auth"],
  summary: "Update current user profile",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: UpdateProfileRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Profile updated" },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Not authenticated" },
  },
});

auth.openapi(updateMeRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const body = c.req.valid("json");
  try {
    await alderoPost("/v1/auth/profile", body, token);
    return c.json({ success: true as const, data: { message: "Profile updated" } }, 200);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "UPDATE_FAILED", message: err.message } }, 401);
    }
    throw err;
  }
});

export { auth };
