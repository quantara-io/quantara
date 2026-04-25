# Quantara Global

[![CI](https://github.com/quantara-io/quantara/actions/workflows/ci.yml/badge.svg)](https://github.com/quantara-io/quantara/actions/workflows/ci.yml)

Crypto AI prediction engine, coaching, deal flow, and marketing platform.

## Workspaces

| Package | Description | Tests |
|---------|-------------|-------|
| `backend` | Hono API on Lambda — auth, OpenAPI docs | [![Backend](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/nch3ng/f40b69a9ed2a76e6a8f9888d1f552bad/raw/backend-coverage.json)](backend/) |
| `ingestion` | Market data streaming + news pipeline | [![Ingestion](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/nch3ng/f40b69a9ed2a76e6a8f9888d1f552bad/raw/ingestion-coverage.json)](ingestion/) |
| `web` | Next.js landing page | — |
| `packages/shared` | Shared TypeScript types + constants | — |

## Architecture

Diagram: [`docs/diagrams/architecture.svg`](docs/diagrams/architecture.svg) — source [`architecture.excalidraw`](docs/diagrams/architecture.excalidraw) (open in [excalidraw.com](https://excalidraw.com)) — standalone HTML view [`architecture.html`](docs/diagrams/architecture.html).

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

## AI Agent Workflow

Multiple agents (Claude, Codex) work this repo in parallel. Each agent claims a GitHub issue, works in its own git worktree on a dedicated branch, opens a PR, and an Opus reviewer agent gates auto-merge. Tripwire changes (infra, CI, deps, auth, schema, >400 LOC) escalate to human review.

Full protocol in [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md).

### File an issue

Use one of the issue templates from the GitHub UI:

- **Bug (agent-actionable)** — lands as `agent-ready`, dispatchable immediately
- **Tech task (agent-actionable)** — lands as `agent-ready`
- **Feature (proposed)** — lands as `agent-proposed`, you triage to `agent-ready` when you want it picked up

Every issue needs an **Acceptance criteria** section and an **Out of scope** list. Without these, agents will refuse and label `agent-blocked`.

### Dispatch a worker

Inside Claude Code:

```
/dispatch <issue-number>     # manual: claim a specific issue
/dispatch-next               # autonomous: claim the highest-priority agent-ready issue
/agent-status                # inspect in-flight workers, PRs, worktrees, escalations
/review <pr-number>          # manually trigger reviewer on any PR
```

For unattended runs:
```
/loop 10m /dispatch-next     # poll every 10 minutes (uses the loop skill)
```

Concurrency cap is 5 active workers. The dispatcher refuses past that.

### Review flow

1. Worker opens PR on `agent/<slug>-<id>` with auto-merge enabled.
2. `quantara-reviewer` (Opus) is dispatched — reads diff + linked issue only, never the worker's reasoning.
3. Reviewer **approves** → CI runs → auto-merge fires when green.
4. Reviewer **requests changes** → worker iterates (cap 3 rounds, then escalates).
5. Reviewer **escalates** (tripwire, low confidence, scope drift) → labels `needs-human-review`, disables auto-merge, requests your review. You're the gate.

### Worktree cleanup

Each worker creates a worktree at `~/.quantara-worktrees/<task-id>`. Cleanup runs via `tools/agent-sweep.sh` — removes worktrees whose PR has closed.

For automatic background cleanup on macOS, register the LaunchAgent described in [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md#cleanup) (one-time, per-machine).

### Files that define the workflow

| Path | Purpose |
|---|---|
| `.claude/agents/quantara-worker.md` | Worker subagent (claim → implement → PR) |
| `.claude/agents/quantara-reviewer.md` | Reviewer subagent (diff-blind review) |
| `.claude/commands/dispatch.md` | `/dispatch <issue#>` |
| `.claude/commands/dispatch-next.md` | `/dispatch-next` |
| `.claude/commands/agent-status.md` | `/agent-status` |
| `.claude/commands/review.md` | `/review <pr#>` — manually trigger reviewer on any PR |
| `.github/pull_request_template.md` | PR template (used by agents and humans) |
| `.github/ISSUE_TEMPLATE/` | Issue templates |
| `tools/agent-sweep.sh` | Worktree cleanup |
| `docs/AGENT_WORKFLOW.md` | Full protocol + setup checklist |

### One-time setup

Before dispatching the first agent, run the label creation block and configure branch protection — see [docs/AGENT_WORKFLOW.md → Setup checklist](docs/AGENT_WORKFLOW.md#setup-checklist-one-time-run-as-nate).
