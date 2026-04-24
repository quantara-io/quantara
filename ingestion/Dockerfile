FROM node:24-alpine AS builder

WORKDIR /app

# Copy workspace root files for npm workspaces
COPY package.json package-lock.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY ingestion/package.json ingestion/tsconfig.json ingestion/esbuild.config.js ./ingestion/
COPY ingestion/src ./ingestion/src

RUN npm ci --workspace=ingestion --workspace=@quantara/shared
RUN cd ingestion && node esbuild.config.js

# ---

FROM node:24-alpine

WORKDIR /app

# Copy built service + production ccxt dependency
COPY --from=builder /app/ingestion/dist/service.js ./dist/service.js
COPY --from=builder /app/ingestion/dist/service.js.map ./dist/service.js.map

# Install externalized runtime dependencies (not the full workspace package.json)
RUN npm init -y > /dev/null 2>&1 && \
    npm install --omit=dev \
      ccxt@^4.4.0 \
      @aws-sdk/client-dynamodb@^3.750.0 \
      @aws-sdk/lib-dynamodb@^3.750.0 \
      @aws-sdk/client-s3@^3.750.0 \
      @aws-sdk/client-sqs@^3.750.0 \
      @aws-sdk/client-ssm@^3.750.0 \
    && rm -rf /root/.npm

EXPOSE 8080

CMD ["node", "dist/service.js"]
