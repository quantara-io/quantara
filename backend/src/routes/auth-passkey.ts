// @ts-nocheck — proxy routes return dynamic Aldero responses
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { alderoPost, alderoGet, alderoDelete, AlderoError } from "../lib/aldero-client.js";
import {
  PasskeyOptionsResponse, PasskeyVerifyRequest, PasskeyListResponse,
  AuthSuccessResponse, SuccessResponse,
} from "../lib/schemas/auth.js";
import { ErrorResponse } from "../lib/schemas/common.js";
import { requireAuth } from "../middleware/require-auth.js";

const authPasskey = new OpenAPIHono();

// Protected passkey routes (register + list + delete need auth; login doesn't)
authPasskey.use("/passkey/register/*", requireAuth);
authPasskey.use("/passkey/list", requireAuth);
authPasskey.use("/passkey/:id", requireAuth);

// --- POST /passkey/register/options ---
const registerOptionsRoute = createRoute({
  method: "post",
  path: "/passkey/register/options",
  tags: ["Passkeys"],
  summary: "Get WebAuthn registration options",
  description: "Returns a challenge and options for navigator.credentials.create(). User must be authenticated.",
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { "application/json": { schema: PasskeyOptionsResponse } }, description: "Registration challenge" },
  },
});

authPasskey.openapi(registerOptionsRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const result = await alderoPost("/v1/auth/passkey/register/options", {}, token);
  return c.json({ success: true as const, data: result } as any);
});

// --- POST /passkey/register/verify ---
const registerVerifyRoute = createRoute({
  method: "post",
  path: "/passkey/register/verify",
  tags: ["Passkeys"],
  summary: "Verify WebAuthn registration",
  description: "Submit the credential from navigator.credentials.create() to complete passkey registration.",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: PasskeyVerifyRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Passkey registered" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Verification failed" },
  },
});

authPasskey.openapi(registerVerifyRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const body = await c.req.json();
  try {
    await alderoPost("/v1/auth/passkey/register/verify", body, token);
    return c.json({ success: true as const, data: { message: "Passkey registered" } } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "PASSKEY_FAILED", message: err.message } } as any, 400);
    }
    throw err;
  }
});

// --- POST /passkey/login/options ---
const loginOptionsRoute = createRoute({
  method: "post",
  path: "/passkey/login/options",
  tags: ["Passkeys"],
  summary: "Get WebAuthn login options",
  description: "Returns a challenge and allowed credentials for navigator.credentials.get(). No authentication required.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email().optional().describe("Email to look up passkeys for"),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: PasskeyOptionsResponse } }, description: "Login challenge" },
  },
});

authPasskey.openapi(loginOptionsRoute, async (c) => {
  const body = c.req.valid("json");
  const result = await alderoPost("/v1/auth/passkey/authenticate/options", body);
  return c.json({ success: true as const, data: result } as any);
});

// --- POST /passkey/login/verify ---
const loginVerifyRoute = createRoute({
  method: "post",
  path: "/passkey/login/verify",
  tags: ["Passkeys"],
  summary: "Verify WebAuthn login",
  description: "Submit the assertion from navigator.credentials.get() to complete passwordless login.",
  request: { body: { content: { "application/json": { schema: PasskeyVerifyRequest } } } },
  responses: {
    200: { content: { "application/json": { schema: AuthSuccessResponse } }, description: "Passkey login successful" },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Verification failed" },
  },
});

authPasskey.openapi(loginVerifyRoute, async (c) => {
  const body = await c.req.json();
  try {
    const result = await alderoPost("/v1/auth/passkey/authenticate/verify", body) as Record<string, unknown>;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "PASSKEY_FAILED", message: err.message } } as any, 401);
    }
    throw err;
  }
});

// --- GET /passkey/list ---
const listRoute = createRoute({
  method: "get",
  path: "/passkey/list",
  tags: ["Passkeys"],
  summary: "List enrolled passkeys",
  security: [{ Bearer: [] }],
  responses: {
    200: { content: { "application/json": { schema: PasskeyListResponse } }, description: "Enrolled passkeys" },
  },
});

authPasskey.openapi(listRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const result = await alderoGet("/v1/auth/passkey/list", token) as any;
  const passkeys = result.passkeys || (Array.isArray(result) ? result : []);
  return c.json({ success: true as const, data: { passkeys } } as any);
});

// --- DELETE /passkey/:id ---
const deleteRoute = createRoute({
  method: "delete",
  path: "/passkey/:id",
  tags: ["Passkeys"],
  summary: "Remove a passkey",
  security: [{ Bearer: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Passkey removed" },
  },
});

authPasskey.openapi(deleteRoute, async (c) => {
  const token = c.req.header("Authorization")?.slice(7);
  const { id } = c.req.valid("param");
  await alderoDelete(`/v1/auth/passkey/${id}`, token);
  return c.json({ success: true as const, data: { message: "Passkey removed" } });
});

export { authPasskey };
