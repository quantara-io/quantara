---
name: quantara-aldero-auth
description: Authentication for the Quantara backend is delegated to an external Aldero service — NOT a self-rolled JWT system. Use this skill whenever working with signup, login, logout, MFA, OAuth, passkey, magic link, password reset, email verification, or JWT verification in the backend. Stops the agent from re-inventing auth or assuming Quantara issues its own tokens.
---

# quantara-aldero-auth

The Quantara backend does not own auth. It is a thin proxy in front of **Aldero** (`https://quantara-sandbox.aldero.io` in dev, configurable via `AUTH_BASE_URL`). Aldero issues access/refresh tokens and exposes a JWKS at `/.well-known/jwks.json`. The backend's job is to:

1. Forward auth requests (signup/login/MFA/etc.) to Aldero, remap errors into Quantara's response envelope.
2. Verify incoming Bearer JWTs against Aldero's JWKS using `jose`.
3. Maintain CSRF state for the OAuth redirect flow (signed cookie, single-use).

Don't introduce password hashing, refresh-token tables, JWT signing keys, or any other persistence — Aldero owns all of that.

## Layout

| File                                     | Responsibility                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `backend/src/lib/aldero-client.ts`       | `alderoPost`, `alderoGet`, `alderoDelete`, `getAlderoRedirectUrl`, `AlderoError` |
| `backend/src/middleware/auth.ts`         | `authenticate(authHeader)` — verifies Bearer JWT via JWKS, returns `AuthContext` |
| `backend/src/middleware/require-auth.ts` | Hono middleware wrapping `authenticate`, sets `c.set("auth", ...)`               |
| `backend/src/routes/auth.ts`             | `/config`, `/signup`, `/login`, `/logout`, `/token/refresh`, `/me`, PATCH `/me`  |
| `backend/src/routes/auth-oauth.ts`       | `/oauth/:provider`, `/oauth/:provider/callback`, `/oauth/:provider/native`       |
| `backend/src/routes/auth-mfa.ts`         | TOTP/email MFA enroll/verify/recovery                                            |
| `backend/src/routes/auth-passkey.ts`     | WebAuthn (passthrough WebAuthn payloads to Aldero)                               |
| `backend/src/routes/auth-password.ts`    | Magic link, password reset, email verify                                         |
| `backend/src/lib/schemas/auth.ts`        | All auth zod schemas (UserProfile, AuthSuccessResponse, MFA shapes, etc.)        |

All five `auth*` route files mount at `/api/auth` in `backend/src/index.ts`.

## Calling Aldero

```ts
import { alderoPost, alderoGet, AlderoError } from "../lib/aldero-client.js";

// Unauthenticated → uses M2M Basic auth (client_id:secret from SSM)
const result = (await alderoPost("/v1/auth/login", body)) as Record<string, unknown>;

// Authenticated → forwards user's Bearer token
const token = c.req.header("Authorization")?.slice(7);
const result = await alderoPost("/v1/auth/profile", body, token);
```

Three helpers, all return `unknown` (cast to `Record<string, unknown>` and pass straight through to the client). On non-2xx they throw `AlderoError(statusCode, body)`.

`getAlderoRedirectUrl(path, params)` builds an HTTPS URL on the Aldero domain — used only by OAuth init to construct the consent redirect.

### Credentials

`AlderoError` carries `statusCode` and `body`. Two paths to credentials:

| Source          | Variable / SSM path                                                            |
| --------------- | ------------------------------------------------------------------------------ |
| Env (local dev) | `ALDERO_M2M_CLIENT_ID`, `ALDERO_CLIENT_SECRET`                                 |
| SSM (deployed)  | `/quantara/<env>/aldero-m2m-client-id`, `/quantara/<env>/aldero-client-secret` |

The client caches both in module scope after the first SSM fetch. There is also a fallback to `APP_ID` env var if no client id is found.

## Error remapping

Catch `AlderoError` at the route boundary and translate it into a Quantara error code. The pattern from `auth.ts` (login):

```ts
try {
  const result = (await alderoPost("/v1/auth/login", body)) as Record<string, unknown>;
  return c.json({ success: true as const, data: result } as any);
} catch (err) {
  if (err instanceof AlderoError) {
    // Aldero signals MFA-required as 403 with error="mfa_required"
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
    return c.json(
      { success: false as const, error: { code, message: err.message } },
      err.statusCode as 401,
    );
  }
  throw err;
}
```

If you don't need a domain-specific code, let it propagate — the global `app.onError` in `index.ts` already maps `AlderoError` to `UNAUTHORIZED` / `FORBIDDEN` / `CONFLICT` / `RATE_LIMITED` / `REQUEST_FAILED` based on the status code.

### Email-enumeration safe endpoints

`/magic-link/request` and `/password/reset-request` always return success regardless of Aldero's response, to prevent enumeration. Don't surface the Aldero error.

## JWT verification

`backend/src/middleware/auth.ts` uses `jose.createRemoteJWKSet` against `${AUTH_BASE_URL}/.well-known/jwks.json`, with:

- `issuer: "auth"` (literal, not the URL)
- `audience: APP_ID` (from env, populated by Terraform from `var.app_id`)

The verified payload is mapped to `AuthContext`:

```ts
{ userId, email?, emailVerified?, authMethod?, sessionId?, role? }
```

`requireAuth` calls `authenticate(c.req.header("Authorization"))` and sets `c.set("auth", ctx)`. Inside a handler, retrieve with `c.get("auth")`. The type is augmented in `require-auth.ts` (`declare module "hono"`).

## OAuth CSRF binding

`auth-oauth.ts` binds the callback to the initiating browser via a signed cookie (`qoauth_cs`) round-tripped through the redirect URI as `?cs=...`. The cookie secret is `process.env.OAUTH_STATE_SECRET` or SSM `/quantara/<env>/oauth-state-secret`. Cookie is single-use — always `deleteCookie` in the callback regardless of outcome.

If you add a new OAuth provider, extend `OAuthProviderParam` enum in `lib/schemas/auth.ts`. Aldero handles the rest.

## Public vs protected paths

The `/api/auth/oauth/*` paths are exempt from `requireApiKey` (see `index.ts`) because the OAuth callback comes from the provider, not a Quantara client.

Within `auth.ts`, protect specific paths individually rather than globally — `/config`, `/signup`, `/login`, `/token/refresh` are public; `/me` and `/logout` are not.

## Don'ts

- Don't store users, sessions, or tokens in DynamoDB. Aldero is the system of record.
- Don't sign or issue JWTs.
- Don't read/manipulate the `users` table from auth routes — it's a profile cache, populated separately.
- Don't add `console.error` for Aldero failures inside the route — let `AlderoError` flow to `app.onError`. Log inside `aldero-client.ts` if you need to.
- Don't bypass the client and `fetch()` Aldero directly — you'll skip the M2M auth header and credential caching.
