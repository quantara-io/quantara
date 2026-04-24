import type { MiddlewareHandler } from "hono";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

let cachedIps: string[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60_000;

async function loadAllowedIps(): Promise<string[]> {
  const now = Date.now();
  if (cachedIps && now < cacheExpiry) return cachedIps;

  // Allow bypass in local dev
  if (process.env.SKIP_IP_WHITELIST === "true") {
    cachedIps = ["*"];
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedIps;
  }

  // Read from env var (set by Terraform)
  if (process.env.DOCS_ALLOWED_IPS) {
    cachedIps = process.env.DOCS_ALLOWED_IPS
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedIps;
  }

  // Fallback: read from SSM
  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: `/quantara/${ENVIRONMENT}/docs-allowed-ips`,
        WithDecryption: false,
      })
    );
    cachedIps = (result.Parameter?.Value ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedIps;
  } catch {
    cachedIps = ["*"];
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedIps;
  }
}

function getClientIp(c: any): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

function ipToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function matchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes("/")) return ip === cidr;

  const [network, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);

  // IPv6 CIDR — simple prefix match
  if (network.includes(":")) {
    const expandedIp = expandIpv6(ip);
    const expandedNet = expandIpv6(network);
    // Compare hex chars: each hex char = 4 bits
    const hexChars = Math.floor(bits / 4);
    return expandedIp.slice(0, hexChars) === expandedNet.slice(0, hexChars);
  }

  // IPv4 CIDR
  const mask = ~((1 << (32 - bits)) - 1) >>> 0;
  return (ipToNum(ip) & mask) === (ipToNum(network) & mask);
}

function expandIpv6(ip: string): string {
  // Remove any port suffix
  const clean = ip.split("%")[0];
  // Expand :: shorthand
  let parts = clean.split(":");
  const emptyIdx = parts.indexOf("");
  if (emptyIdx !== -1) {
    const missing = 8 - parts.filter(Boolean).length;
    const fill = Array(missing).fill("0000");
    parts.splice(emptyIdx, parts.filter(p => p === "").length, ...fill);
  }
  return parts.map((p) => p.padStart(4, "0")).join("");
}

export const ipWhitelist: MiddlewareHandler = async (c, next) => {
  const allowedIps = await loadAllowedIps();

  if (allowedIps.includes("*")) return next();

  const clientIp = getClientIp(c);

  const allowed = allowedIps.some((entry) => matchesCidr(clientIp, entry));

  if (!allowed) {
    return c.json(
      { success: false, error: { code: "FORBIDDEN", message: "Access denied" } },
      403
    );
  }

  await next();
};
