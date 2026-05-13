# syntax=docker/dockerfile:1.7
#
# Fargate backtest-runner image — Phase 4 (issue #371).
#
# Multi-stage build mirroring ingestion/Dockerfile so the patterns stay
# consistent: builder installs the workspace deps, then a slim runtime
# image with only what's needed at runtime.
#
# Resolves PR #376 review finding 1 (no runner image / Dockerfile / CI build).

FROM node:24-alpine AS builder

WORKDIR /app

# Workspace root files for npm workspaces.
COPY package.json package-lock.json tsconfig.json ./

# Shared workspace — types + constants used by engine + strategies.
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src

# Ingestion workspace — engine imports indicator + score + gates + blend
# helpers directly from there.
COPY ingestion/package.json ingestion/tsconfig.json ./ingestion/
COPY ingestion/src ./ingestion/src

# Backtest workspace — engine, strategies, runner.
COPY backtest/package.json backtest/tsconfig.json ./backtest/
COPY backtest/src ./backtest/src
COPY backtest/strategies ./backtest/strategies

# Install the three workspaces' deps without dev-deps (tsx + vitest are
# heavy and not needed at runtime — see CMD below).
RUN npm ci --workspace=quantara-backtest \
            --workspace=quantara-ingestion \
            --workspace=@quantara/shared

# --- Runtime image ---
FROM node:24-alpine

WORKDIR /app

# Copy everything the runner imports at runtime. We deliberately keep TS
# source + tsx rather than precompiling because:
#   - backtest/strategies/*.ts are loaded by dynamic import — pre-bundling
#     them via esbuild would bake in compile-time choices that defeat the
#     point of a swappable strategy file.
#   - The image is internal-only and the cold-start cost of tsx is
#     dominated by the Fargate task launch (~30s) anyway.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/ingestion ./ingestion
COPY --from=builder /app/backtest ./backtest
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json

# tsx is installed as a backtest devDependency; we need it at runtime, so
# explicitly install it as a production dep alongside.
RUN npm install --omit=dev --no-save tsx@^4.19.0 \
    && rm -rf /root/.npm

ENV NODE_ENV=production

# Health: the runner doesn't expose an HTTP port — ECS uses task lifecycle.
# Entry script invokes the runner via tsx so TS sources + .ts strategy
# imports resolve identically to local dev.
CMD ["npx", "--prefix", "/app", "tsx", "/app/backtest/src/runner/main.ts"]
