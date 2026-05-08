import type { Context, MiddlewareHandler } from "hono";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import ipaddr from "ipaddr.js";

import { logger } from "../lib/logger.js";

const ssm = new SSMClient({});
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

let cachedIps: string[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60_000;

async function loadAllowedIps(): Promise<string[]> {
  const now = Date.now();
  if (cachedIps && now < cacheExpiry) return cachedIps;

  if (process.env.SKIP_IP_WHITELIST === "true") {
    cachedIps = ["*"];
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedIps;
  }

  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: `/quantara/${ENVIRONMENT}/docs-allowed-ips`,
        WithDecryption: false,
      }),
    );
    cachedIps = (result.Parameter?.Value ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedIps;
  } catch (err) {
    // Fail closed: if we have a stale cache, use it; otherwise deny.
    logger.error({ err, hasStaleCache: cachedIps !== null }, "ip-whitelist: SSM read failed");
    if (cachedIps) return cachedIps;
    return [];
  }
}

function getClientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "";
}

function matchesEntry(clientIp: string, entry: string): boolean {
  try {
    const client = ipaddr.parse(clientIp);
    if (entry.includes("/")) {
      const range = ipaddr.parseCIDR(entry);
      // parse() returns IPv4 or IPv6; match() requires both sides be same kind.
      if (client.kind() !== range[0].kind()) return false;
      return client.match(range as [ipaddr.IPv4 | ipaddr.IPv6, number]);
    }
    const single = ipaddr.parse(entry);
    if (client.kind() !== single.kind()) return false;
    return client.toNormalizedString() === single.toNormalizedString();
  } catch {
    return false;
  }
}

export const ipWhitelist: MiddlewareHandler = async (c, next) => {
  const allowedIps = await loadAllowedIps();

  if (allowedIps.includes("*")) return next();

  const clientIp = getClientIp(c);
  const allowed = clientIp !== "" && allowedIps.some((entry) => matchesEntry(clientIp, entry));

  if (!allowed) {
    return c.json({ success: false, error: { code: "FORBIDDEN", message: "Access denied" } }, 403);
  }

  await next();
};
