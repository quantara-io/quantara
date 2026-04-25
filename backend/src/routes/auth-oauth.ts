import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { setSignedCookie, getSignedCookie, deleteCookie } from "hono/cookie";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { alderoPost, getAlderoRedirectUrl, AlderoError } from "../lib/aldero-client.js";
import { OAuthProviderParam, OAuthCallbackQuery, NativeTokenRequest, AuthSuccessResponse } from "../lib/schemas/auth.js";
import { ErrorResponse } from "../lib/schemas/common.js";
import { z } from "@hono/zod-openapi";

const authOAuth = new OpenAPIHono();

const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";
const STATE_COOKIE = "qoauth_cs";
const STATE_TTL_SECONDS = 5 * 60;
const ssm = new SSMClient({});

let cookieSecretPromise: Promise<string> | null = null;

function getCookieSecret(): Promise<string> {
  if (cookieSecretPromise) return cookieSecretPromise;
  cookieSecretPromise = (async () => {
    if (process.env.OAUTH_STATE_SECRET) return process.env.OAUTH_STATE_SECRET;
    try {
      const result = await ssm.send(
        new GetParameterCommand({
          Name: `/quantara/${ENVIRONMENT}/oauth-state-secret`,
          WithDecryption: true,
        }),
      );
      const value = result.Parameter?.Value ?? "";
      if (!value) throw new Error("empty oauth-state-secret");
      return value;
    } catch (err) {
      cookieSecretPromise = null;
      throw err;
    }
  })();
  return cookieSecretPromise;
}

// --- GET /oauth/:provider ---
const oauthInitRoute = createRoute({
  method: "get",
  path: "/oauth/:provider",
  tags: ["Auth"],
  summary: "Initiate OAuth login",
  description: "Sets a CSRF cookie and redirects to the OAuth provider for user consent.",
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

  const cs = crypto.randomUUID();
  const secret = await getCookieSecret();
  await setSignedCookie(c, STATE_COOKIE, cs, secret, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/api/auth/oauth",
    maxAge: STATE_TTL_SECONDS,
  });

  const baseCallback = `${c.req.url.split("/oauth")[0]}/oauth/${provider}/callback`;
  const finalCallback = redirect_uri ?? baseCallback;
  const sep = finalCallback.includes("?") ? "&" : "?";
  const callbackWithState = `${finalCallback}${sep}cs=${encodeURIComponent(cs)}`;

  const url = getAlderoRedirectUrl(`/v1/auth/oauth/${provider}`, {
    redirect_uri: callbackWithState,
  });

  return c.redirect(url);
});

// --- GET /oauth/:provider/callback ---
const oauthCallbackRoute = createRoute({
  method: "get",
  path: "/oauth/:provider/callback",
  tags: ["Auth"],
  summary: "OAuth callback handler",
  description: "Validates the CSRF cookie against the round-tripped `cs` query param, then exchanges the authorization code for tokens.",
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

  const secret = await getCookieSecret();
  const cookieState = await getSignedCookie(c, secret, STATE_COOKIE);
  // Always clear the cookie — single use, regardless of outcome.
  deleteCookie(c, STATE_COOKIE, { path: "/api/auth/oauth" });

  if (!cookieState || !query.cs || cookieState !== query.cs) {
    return c.json({
      success: false as const,
      error: { code: "INVALID_STATE", message: "OAuth state mismatch" },
    }, 400);
  }

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

    return c.json({ success: true as const, data: result } as never, 200);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "OAUTH_FAILED", message: err.message } }, 400);
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
    return c.json({ success: true as const, data: result } as never, 200);
  } catch (err) {
    if (err instanceof AlderoError) {
      return c.json({ success: false as const, error: { code: "OAUTH_FAILED", message: err.message } }, 401);
    }
    throw err;
  }
});

export { authOAuth };
