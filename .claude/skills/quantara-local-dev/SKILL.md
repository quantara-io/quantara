---
name: quantara-local-dev
description: Run Quantara backend, ingestion, or web locally; debug AWS access; understand AWS profiles/SSO; use the ops dashboard. Use when the task involves "run locally", "test against dev", "AWS credentials", "SSO login", profile switching, environment variables, or `npm run dev` for any workspace.
---

# quantara-local-dev

Quantara is a workspace monorepo with three runnables (`backend`, `ingestion`, `web`) and an ops dashboard (`tools/dashboard.ts`). Local dev hits the **dev AWS account** directly — there's no LocalStack or DynamoDB Local. Your AWS SSO session must be active.

## AWS accounts

| Account    | ID           | Profile                  | Role                                     |
| ---------- | ------------ | ------------------------ | ---------------------------------------- |
| Management | 489922707011 | `quantara-management`    | Org/IAM Identity Center, Terraform state |
| Dev        | 442725244722 | `quantara-dev` (default) | All local dev hits this                  |
| Prod       | 351666231984 | `quantara-prod`          | Hands off                                |

SSO start URL: `https://d-9267dc8051.awsapps.com/start`. Region: `us-west-2` (always).

```bash
aws sso login                   # uses the [default] profile (dev)
aws sso login --profile quantara-management   # for terraform
aws sts get-caller-identity     # sanity check
```

Tokens last ~8 hours. Re-`aws sso login` when you see "Token has expired".

If `~/.aws/config` is missing the Quantara profiles, see `docs/AWS_SSO_SETUP.md` for the full block to append.

## Running each workspace

From the repo root:

| Workspace                                | Command                                             | What it does                                                             |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Backend (Hono on Lambda → tsx local)     | `npm run dev --workspace=quantara-backend`          | `tsx --watch src/local.ts`, port 3001, hits real DynamoDB in dev account |
| Ingestion (one-shot)                     | `npm run dev --workspace=quantara-ingestion`        | `tsx src/local.ts` — backfill or single-poll mode                        |
| Ingestion (streaming Fargate-equivalent) | `npm run dev:stream --workspace=quantara-ingestion` | `tsx src/service.ts` — real WebSocket streams + news poller              |
| Web (Next.js 16)                         | `npm run dev --workspace=web`                       | Standard `next dev`                                                      |
| Ops dashboard                            | `npx tsx tools/dashboard.ts`                        | Live status page on `:3333` (DynamoDB / ECS / SQS / Logs)                |

The backend `dev` script bakes in env vars:

```
AWS_REGION=us-west-2
AWS_PROFILE=quantara-dev
TABLE_PREFIX=quantara-dev-
CORS_ORIGIN=*
SKIP_API_KEY=true
SKIP_IP_WHITELIST=true
```

Ingestion `dev` / `dev:stream` scripts set the same `AWS_REGION`, `AWS_PROFILE`, `TABLE_PREFIX`. If you need a different prefix or profile, override on the command line:

```bash
AWS_PROFILE=quantara-prod TABLE_PREFIX=quantara-prod- npm run dev --workspace=quantara-backend
```

## Auth bypass flags

Local dev routes can bypass two middleware checks:

| Flag                     | Effect                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `SKIP_API_KEY=true`      | `requireApiKey` accepts the literal `dev-local` key (or any key when paired with the right SSM stub) |
| `SKIP_IP_WHITELIST=true` | `ipWhitelist` accepts every client IP                                                                |

Both are set in `backend/package.json` for `npm run dev`. Don't ship them. They are checked **only** in the middleware modules (`api-key.ts`, `ip-whitelist.ts`) — not enforced by infrastructure.

For Aldero auth: there's no bypass for `requireAuth`. Hit `/api/auth/login` against the dev Aldero sandbox first, then call protected routes with the returned `accessToken`.

## SSM secrets the local stack reads

Even with the bypasses, several flows still hit SSM in the dev account:

- Aldero M2M client credentials (`/quantara/dev/aldero-m2m-client-id`, `/quantara/dev/aldero-client-secret`).
- API keys (`/quantara/dev/api-keys/*`) — bypassed by `SKIP_API_KEY=true`.
- IP allow list (`/quantara/dev/docs-allowed-ips`) — bypassed by `SKIP_IP_WHITELIST=true`.
- OAuth state secret (`/quantara/dev/oauth-state-secret`).
- News API keys (`/quantara/dev/cryptopanic-api-key`).
- Alpaca creds (`/quantara/dev/alpaca/key-id`, `/quantara/dev/alpaca/secret-key`).

If `aws sts get-caller-identity` works but a local server can't read SSM, your role is fine — the parameter probably doesn't exist yet. Create it:

```bash
aws ssm put-parameter --profile quantara-dev --region us-west-2 \
  --name '/quantara/dev/<param>' --type SecureString --value '<value>' --overwrite
```

To add your roaming IP to the docs allow list:

```bash
MY_IP=$(curl -s https://checkip.amazonaws.com)
CURRENT=$(aws ssm get-parameter --profile quantara-dev --region us-west-2 \
  --name /quantara/dev/docs-allowed-ips --query 'Parameter.Value' --output text)
aws ssm put-parameter --profile quantara-dev --region us-west-2 \
  --name /quantara/dev/docs-allowed-ips --type String \
  --value "${CURRENT},${MY_IP}/32" --overwrite
```

## Ops dashboard

```bash
npx tsx tools/dashboard.ts
```

Opens a server on `:3333` that polls DynamoDB tables, ECS service status, SQS queue depth, recent CloudWatch log events, and Lambda function listings — all in the dev account. Useful for "is the Fargate task healthy?" / "what's queued in enrichment?" without hopping into the AWS console.

The dashboard hardcodes the dev account ID (`442725244722`) and prefix (`quantara-dev`). Update `tools/dashboard.ts` if you ever point it elsewhere.

## Typecheck / build / test

From the repo root, all workspaces in one shot:

```bash
npm run typecheck       # all workspaces
npm run build           # all workspaces
npm run test            # all workspaces (today: backend only)
```

CI runs the same three commands plus the Next.js build (`.github/workflows/ci.yml`).

## Common gotchas

- **"The security token included in the request is invalid"** → `aws sso login` again.
- **`TABLE_PREFIX` mismatch** → if you override `AWS_PROFILE=quantara-prod`, also set `TABLE_PREFIX=quantara-prod-` or you'll read dev tables with prod creds (which the IAM role will block, but the error is opaque).
- **CORS error from a browser** → backend `dev` script sets `CORS_ORIGIN=*`. If you removed that, set it back or to your local origin.
- **Aldero JWT verification fails** → make sure `APP_ID` and `AUTH_BASE_URL` are set; the dev defaults are `app_01KPEJYKSSQB3CVWV0D0NSC3KX` and `https://quantara-sandbox.aldero.io`. See `quantara-aldero-auth`.

## Don'ts

- Don't run anything against `quantara-prod` while iterating. The dev account is the playground.
- Don't commit env files — there is no `.env` in the repo, and SSM is the source of truth.
- Don't change `AWS_REGION` away from `us-west-2`. All resources live there.
- Don't run `terraform apply` from a workspace `dev` script. Terraform lives in `backend/infra/{dev,prod}` and uses the `quantara-management` profile (see `quantara-terraform`).
