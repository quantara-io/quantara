import type { MiddlewareHandler } from "hono";
import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

let cachedKeys: Map<string, string> | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

async function loadApiKeys(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cachedKeys && now < cacheExpiry) return cachedKeys;

  // Allow bypass in local dev
  if (process.env.SKIP_API_KEY === "true") {
    cachedKeys = new Map([["dev-local", "local"]]);
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedKeys;
  }

  try {
    const result = await ssm.send(
      new GetParametersByPathCommand({
        Path: `/quantara/${ENVIRONMENT}/api-keys/`,
        WithDecryption: true,
      }),
    );

    const keys = new Map<string, string>();
    for (const param of result.Parameters ?? []) {
      // e.g. /quantara/dev/api-keys/dashboard → client="dashboard", value=key
      const client = param.Name?.split("/").pop() ?? "unknown";
      if (param.Value) keys.set(param.Value, client);
    }

    cachedKeys = keys;
    cacheExpiry = now + CACHE_TTL_MS;
    return keys;
  } catch {
    // Fail closed: serve a stale cache if we have one, otherwise an empty
    // map (which denies every request below with INVALID_API_KEY).
    return cachedKeys ?? new Map();
  }
}

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const apiKey = c.req.header("x-api-key");

  if (!apiKey) {
    return c.json(
      { success: false, error: { code: "API_KEY_REQUIRED", message: "Missing x-api-key header" } },
      401,
    );
  }

  const keys = await loadApiKeys();
  const client = keys.get(apiKey);

  if (!client) {
    return c.json(
      { success: false, error: { code: "INVALID_API_KEY", message: "Invalid API key" } },
      403,
    );
  }

  // Set client identifier for logging/analytics
  c.set("apiClient", client);
  await next();
};
