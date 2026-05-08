---
name: quantara-tests
description: Write or modify vitest tests for the Quantara backend (and ingestion, when those land). Use when adding tests for routes, middleware, library helpers, or AWS-SDK-touching code. Covers the vi.mock pattern for AWS clients and `jose`, the `vi.resetModules + dynamic import` pattern for env-var-sensitive modules, and how to mock Aldero. Stops the agent from inventing a different testing convention.
---

# quantara-tests

Backend tests use **vitest** with `environment: "node"`. Tests are **colocated** alongside the source file (`api-key.test.ts` lives next to `api-key.ts`). Config: `backend/vitest.config.ts` — picks up `src/**/*.test.ts`. CI runs `npm run test --workspace=quantara-backend` on every PR.

The backend is the only workspace with tests today. Three reference files cover the conventions:

- `backend/src/middleware/api-key.test.ts` — mocking SSM
- `backend/src/middleware/ip-whitelist.test.ts` — mocking SSM, header injection, fail-closed
- `backend/src/middleware/auth.test.ts` — mocking `jose`

## Run

```bash
npm run test --workspace=quantara-backend           # one-shot
npm run test:watch --workspace=quantara-backend     # watch mode
npx vitest run src/middleware/api-key.test.ts       # single file
```

## Canonical pattern (middleware / AWS-SDK-using module)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input) => input),
  // GetParametersByPathCommand: same shape if needed
}));

beforeEach(() => {
  vi.resetModules(); // ← critical when the SUT caches anything in module scope
  sendMock.mockReset();
  delete process.env.SKIP_API_KEY;
});

async function buildApp() {
  const { requireApiKey } = await import("./api-key.js"); // ← dynamic import after resetModules
  const app = new Hono();
  app.use(requireApiKey);
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

describe("requireApiKey", () => {
  it("rejects requests with no x-api-key header", async () => {
    const app = await buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });
});
```

Three things make this pattern work:

1. **Mock at the module boundary.** `vi.mock("@aws-sdk/client-ssm", ...)` replaces the whole module. The mocked `SSMClient` constructor returns `{ send: sendMock }` — you control what every `client.send(...)` returns per test via `sendMock.mockResolvedValue(...)` / `mockRejectedValue(...)`. Mock both `SSMClient` and the command class (the latter as a passthrough `mockImplementation((input) => input)`).
2. **`vi.resetModules()` in `beforeEach`.** Many Quantara modules cache things in module scope (API key map, IP list, JWKS, Aldero client id). Without resetModules, the first test's cache leaks into the second.
3. **Dynamic import the SUT.** Combined with `resetModules`, this re-runs the SUT's top-level code (re-reading env vars, re-instantiating the cached `SSMClient`) per test.

## Testing a Hono route or middleware

Build the smallest possible `Hono()` app, mount the SUT, and use `app.request(path, init)`:

```ts
const app = new Hono();
app.use(requireApiKey);
app.get("/", (c) => c.text("ok"));

const res = await app.request("/", { headers: { "x-api-key": "key1" } });
expect(res.status).toBe(200);
const body = (await res.json()) as any;
expect(body.error.code).toBe("INVALID_API_KEY");
```

Use `Hono` (not `OpenAPIHono`) for tests — fewer moving parts. Cast `await res.json()` to `any` for assertions; the response envelope is well-known.

## Header injection helper

For IP-based middleware, a small helper keeps tests readable:

```ts
function withClientIp(ip: string) {
  return { headers: { "x-forwarded-for": ip } };
}
const res = await app.request("/", withClientIp("198.51.100.5"));
```

## Mocking `jose` (JWT verify)

```ts
const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: vi.fn().mockReturnValue({}),
}));

beforeEach(() => {
  vi.resetModules();
  jwtVerifyMock.mockReset();
});

// Per test:
jwtVerifyMock.mockResolvedValue({ payload: { sub: "user_123", email: "a@b.com" } });
jwtVerifyMock.mockRejectedValue(new Error("signature verification failed"));
```

Same pattern: dynamic-import `authenticate` after the reset.

## Mocking Aldero

`alderoPost` / `alderoGet` / `alderoDelete` use `fetch`. Two ways to mock:

1. **Stub `globalThis.fetch`** for one or two tests:

   ```ts
   const fetchMock = vi.fn();
   beforeEach(() => {
     vi.stubGlobal("fetch", fetchMock);
     fetchMock.mockReset();
   });
   afterEach(() => vi.unstubAllGlobals());

   fetchMock.mockResolvedValueOnce({
     ok: true,
     json: async () => ({ accessToken: "..." }),
   });
   ```

2. **Mock the whole `aldero-client` module** when testing a route:
   ```ts
   vi.mock("../lib/aldero-client.js", () => ({
     alderoPost: vi.fn(),
     alderoGet: vi.fn(),
     AlderoError: class extends Error {
       constructor(
         public statusCode: number,
         public body: unknown,
       ) {
         super("aldero");
       }
     },
   }));
   ```
   Re-export `AlderoError` as a real class — the route's `instanceof AlderoError` check has to work.

Pick (2) for route tests, (1) for tests of `aldero-client.ts` itself.

## What to test

- **Middleware:** every guard branch (missing header, invalid value, fail-closed on dependency error). The api-key and ip-whitelist tests are good templates.
- **Routes:** happy path + key error mappings (e.g. login → MFA-required, login → ACCOUNT_LOCKED). Don't test Aldero's internals; test the remap.
- **Library helpers** (`lib/*.ts`): the function's contract — caching behavior, batching, dedupe — without re-testing AWS SDK internals.

## What NOT to test

- The OpenAPI doc shape (Scalar / `@hono/zod-openapi` produce it from your schemas — testing it is testing the framework).
- Real AWS calls — never. All tests are local, no IAM, no SSM, no Bedrock.
- The Aldero service itself.

## Coverage today

Tested so far: `middleware/{api-key,ip-whitelist,auth,require-auth}.test.ts` and `lib/aldero-client.test.ts`. Routes have no tests yet. When adding tests for new files, follow the same colocated pattern. If you add a route, drop a `*.test.ts` next to it covering the happy path and the most likely error remap. Run `npm run test:coverage --workspace=quantara-backend` to see the current shape — CI uploads the report.

## Don'ts

- Don't reach into `process.env` from inside the test setup without `delete`-ing it in `beforeEach` — leaks across files.
- Don't import the SUT at the top of the file if it caches anything in module scope. Use `await import(...)` after `resetModules()`.
- Don't add an integration test that calls real AWS. Mock at the SDK boundary.
- Don't add jest — vitest only. Don't add testing-library — Hono's `app.request` is enough.
- Don't run `vitest --watch` in CI scripts — `npm run test` already runs `vitest run` (one-shot).
