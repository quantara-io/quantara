---
name: quantara-add-hono-route
description: Add or modify a Hono + zod-openapi route in the Quantara backend (backend/src/routes/). Use when adding an API endpoint, changing a route's request/response schema, or wiring a new route group into the app. Covers schema placement, middleware (requireAuth / requireApiKey / ipWhitelist), error mapping, registration in index.ts, and the colocated vitest test.
---

# quantara-add-hono-route

The Quantara backend is a single Hono app (`@hono/zod-openapi`) deployed as a Lambda behind API Gateway. Routes live in `backend/src/routes/`, one file per route group, exported as `OpenAPIHono` instances and mounted in `backend/src/index.ts`.

## Anatomy of a route file

Every route file follows this shape (`backend/src/routes/health.ts` is the smallest reference, `backend/src/routes/auth.ts` shows full coverage):

```ts
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";          // re-exported zod with .openapi()
import { SomeSchema } from "../lib/schemas/<domain>.js";
import { ErrorResponse } from "../lib/schemas/common.js";
import { requireAuth } from "../middleware/require-auth.js";

const myRoutes = new OpenAPIHono();

// Group-level middleware (optional)
myRoutes.use("*", requireAuth);

const route = createRoute({
  method: "get",
  path: "/sessions/:id",
  tags: ["Coach"],            // groups in Scalar docs
  summary: "...",
  security: [{ Bearer: [] }], // when authed
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ ... }),
    body: { content: { "application/json": { schema: SomeSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: ResponseSchema } }, description: "..." },
    401: { content: { "application/json": { schema: ErrorResponse } }, description: "..." },
  },
});

myRoutes.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const auth = c.get("auth");   // populated by requireAuth
  return c.json({ success: true as const, data: { ... } });
});

export { myRoutes };
```

Note the `.js` extension on relative imports — this is an ESM TS project, the runtime path is `.js` even though the source is `.ts`.

## Where things go

| Thing | Path | Notes |
|---|---|---|
| Route handlers | `backend/src/routes/<domain>.ts` | One `OpenAPIHono` per domain, exported by name |
| Zod schemas | `backend/src/lib/schemas/<domain>.ts` | Use `z.object({...}).openapi("Name")` so they appear named in the OpenAPI doc |
| Shared schemas | `backend/src/lib/schemas/common.ts` | `ErrorResponse`, `PaginationMeta` |
| Domain logic / external calls | `backend/src/lib/<helper>.ts` | Don't put business logic in route handlers |
| Vitest test | Colocated next to route or middleware (e.g. `auth.test.ts`) | See `backend/src/middleware/api-key.test.ts` for the canonical pattern |

## Response envelope

Always return either:
- Success: `{ success: true, data: <payload> }` — use `success: true as const` so the literal type narrows for TypeScript
- Error: `{ success: false, error: { code: string, message: string } }`

`ErrorResponse` from `lib/schemas/common.ts` enforces this shape in OpenAPI. The global `app.onError` handler in `index.ts` already maps `AppError` and `AlderoError` into this envelope — throw, don't catch-and-format, unless you need a domain-specific code (see auth routes for the pattern of catching `AlderoError` to remap codes like `INVALID_CREDENTIALS` / `ACCOUNT_LOCKED`).

## Errors

Use the classes in `backend/src/lib/errors.ts`:

- `AppError(statusCode, message, code)` — generic
- `UnauthorizedError(message?)` — 401, `UNAUTHORIZED`
- `ForbiddenError(message?)` — 403, `FORBIDDEN`
- `NotFoundError(message?)` — 404, `NOT_FOUND`

Throw these and the `app.onError` handler turns them into the response envelope. Don't `console.error` — use `logger` from `backend/src/lib/logger.js`.

## Middleware

Three are wired in `index.ts`:

| Middleware | What it does | Where it's applied |
|---|---|---|
| `requireApiKey` | Validates `x-api-key` against SSM-cached keys | All `/api/*` except docs and OAuth callbacks |
| `ipWhitelist` | CIDR-matches client IP against SSM list | `/api/docs*`, `/api/openapi.json` |
| `requireAuth` | Verifies Bearer JWT via Aldero JWKS, sets `c.get("auth")` | Per-route or per-group, not global |

`requireAuth` populates `c.get("auth")` with `AuthContext` (`userId`, `email`, `emailVerified`, `authMethod`, `sessionId`, `role`). The augmentation is declared in `middleware/require-auth.ts` so `c.get("auth")` is typed.

For mixed public/protected routes inside one group, mount per-path:
```ts
auth.use("/me", requireAuth);
auth.use("/me/*", requireAuth);
auth.use("/logout", requireAuth);
```

## Registering a new route group

Two edits in `backend/src/index.ts`:

1. Import the group: `import { coach } from "./routes/coach.js";`
2. Mount it: `app.route("/api/coach", coach);`

Mounting under `/api/*` automatically picks up the `requireApiKey` middleware. Don't add a new `/api/*` exclusion to that middleware unless the path is intentionally public (only `/api/docs*` and `/api/auth/oauth/*` are exempt today).

## Test pattern

Colocated `*.test.ts`, vitest, build a tiny `Hono()` app, mock AWS SDK clients with `vi.mock`. Reference: `backend/src/middleware/api-key.test.ts`. Use `vi.resetModules()` in `beforeEach` and dynamic-import the SUT inside the test so env-var changes take effect.

Run: `npm run test --workspace=quantara-backend`. CI runs this on every PR (`.github/workflows/ci.yml`).

## What NOT to do

- Don't add Bedrock/DynamoDB calls inside the route handler — wrap them in `backend/src/lib/<service>.ts` and call from the handler.
- Don't roll a custom JWT — `requireAuth` already verifies via Aldero JWKS. See the `quantara-aldero-auth` skill.
- Don't `console.log` — use `logger` from `lib/logger.ts` (pino, structured).
- Don't drop the `.js` extension on relative imports — TS won't complain, but the bundled Lambda will fail at runtime.
- Don't forget IAM: if you read/write a new DynamoDB table from a route, add it to `aws_iam_role_policy.lambda_dynamodb` in `backend/infra/modules/quantara-backend/lambda.tf` (see `quantara-terraform`).
