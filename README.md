# Quantara Global

[![CI](https://github.com/quantara-io/quantara/actions/workflows/ci.yml/badge.svg)](https://github.com/quantara-io/quantara/actions/workflows/ci.yml)

Crypto AI prediction engine, coaching, deal flow, and marketing platform.

## Workspaces

| Package | Description | Tests |
|---------|-------------|-------|
| `backend` | Hono API on Lambda — auth, OpenAPI docs | [![Backend](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/quantara-io/quantara/badges/backend-coverage.json)](backend/) |
| `ingestion` | Market data streaming + news pipeline | [![Ingestion](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/quantara-io/quantara/badges/ingestion-coverage.json)](ingestion/) |
| `web` | Next.js landing page | — |
| `packages/shared` | Shared TypeScript types + constants | — |

## Architecture

| Layer | Tech | Status |
|-------|------|--------|
| **Frontend** | Next.js (landing), React+Vite (dashboard), Flutter (mobile) | Planned |
| **Backend API** | Node.js / TypeScript, Hono, OpenAPIHono + Zod | Deployed |
| **Auth** | Email/password, Google/Apple OAuth, MFA (TOTP/email), passkeys | Deployed |
| **Ingestion** | Fargate WebSocket (CCXT Pro), Alpaca News, RSS, Fear & Greed | Deployed |
| **Database** | DynamoDB (12 tables) | Deployed |
| **AI** | Amazon Bedrock (Claude Haiku) — news sentiment enrichment | Deployed |
| **Infrastructure** | AWS (Lambda, Fargate, API Gateway, CloudFront, SQS, S3) | Deployed |

## Quick Start

```bash
# Install
npm ci

# Typecheck
npm run typecheck --workspaces

# Run backend locally
npm run dev --workspace=quantara-backend

# Run ingestion locally
npm run dev --workspace=quantara-ingestion
```

## API Documentation

- **Docs**: [/api/docs](https://d3tavvh2o76dc5.cloudfront.net/api/docs) (IP whitelisted)
- **OpenAPI Spec**: [/api/openapi.json](https://d3tavvh2o76dc5.cloudfront.net/api/openapi.json)
- **Auth Demo**: [/api/docs/demo](https://d3tavvh2o76dc5.cloudfront.net/api/docs/demo)

## Deployment

```bash
# Login to AWS
aws sso login

# Deploy to dev
cd backend/infra/dev && terraform apply -auto-approve
```

See [docs/AWS_SSO_SETUP.md](docs/AWS_SSO_SETUP.md) for full setup instructions.
