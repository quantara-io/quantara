// @ts-nocheck — proxy routes return dynamic Aldero responses
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { alderoPost, getAlderoRedirectUrl, AlderoError } from "../lib/aldero-client.js";
import { OAuthProviderParam, OAuthCallbackQuery, NativeTokenRequest, AuthSuccessResponse } from "../lib/schemas/auth.js";
import { ErrorResponse } from "../lib/schemas/common.js";
import { z } from "@hono/zod-openapi";

const authOAuth = new OpenAPIHono();

// --- GET /oauth/:provider ---
const oauthInitRoute = createRoute({
  method: "get",
  path: "/oauth/:provider",
  tags: ["Auth"],
  summary: "Initiate OAuth login",
  description: "Redirects to the OAuth provider (Google/Apple) for user consent. After consent, redirects back to the callback URL.",
  request: {
    params: OAuthProviderParam,
    query: z.object({
      redirect_uri: z.string().optional().describe("Where to redirect after auth completes"),
    }),
  },
  responses: {
    302: { description: "Redirect to OAuth provider" },
  },
});

authOAuth.openapi(oauthInitRoute, async (c) => {
  const { provider } = c.req.valid("param");
  const { redirect_uri } = c.req.valid("query");

  const callbackUrl = `${c.req.url.split("/oauth")[0]}/oauth/${provider}/callback`;
  const url = getAlderoRedirectUrl(`/v1/auth/oauth/${provider}`, {
    redirect_uri: redirect_uri ?? callbackUrl,
  });

  return c.redirect(url);
});

// --- GET /oauth/:provider/callback ---
const oauthCallbackRoute = createRoute({
  method: "get",
  path: "/oauth/:provider/callback",
  tags: ["Auth"],
  summary: "OAuth callback handler",
  description: "Handles the OAuth callback from the provider. Exchanges the authorization code for tokens.",
  request: {
    params: OAuthProviderParam,
    query: OAuthCallbackQuery,
  },
  responses: {
    200: { content: { "application/json": { schema: AuthSuccessResponse } }, description: "OAuth login successful" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "OAuth error" },
  },
});

authOAuth.openapi(oauthCallbackRoute, async (c) => {
  const { provider } = c.req.valid("param");
  const query = c.req.valid("query");

  if (query.error) {
    return c.json({
      success: false as const,
      error: { code: "OAUTH_ERROR", message: query.error },
    }, 400);
  }

  try {
    const result = await alderoPost(`/v1/auth/oauth/${provider}/callback`, {
      code: query.code,
      state: query.state,
    }) as Record<string, unknown>;

    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "OAUTH_FAILED", message: err.message } }, err.statusCode as 400);
    }
    throw err;
  }
});

// --- POST /oauth/:provider/native ---
const oauthNativeRoute = createRoute({
  method: "post",
  path: "/oauth/:provider/native",
  tags: ["Auth"],
  summary: "Native OAuth token exchange",
  description: "For mobile apps — exchange a native Google/Apple ID token for Quantara tokens.",
  request: {
    params: OAuthProviderParam,
    body: { content: { "application/json": { schema: NativeTokenRequest } } },
  },
  responses: {
    200: { content: { "application/json": { schema: AuthSuccessResponse } }, description: "Token exchanged" },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid token" },
  },
});

authOAuth.openapi(oauthNativeRoute, async (c) => {
  const { provider } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const result = await alderoPost(`/v1/auth/oauth/${provider}/native`, body) as Record<string, unknown>;
    return c.json({ success: true as const, data: result } as any);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "OAUTH_FAILED", message: err.message } }, err.statusCode as 401);
    }
    throw err;
  }
});

export { authOAuth };
