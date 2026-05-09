import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

const BASE_URL = process.env.AUTH_BASE_URL ?? "https://quantara-sandbox.aldero.io";

let cachedClientId: string | null = null;
let cachedSecret: string | null = null;

async function getM2MClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;

  if (process.env.ALDERO_M2M_CLIENT_ID) {
    cachedClientId = process.env.ALDERO_M2M_CLIENT_ID;
    return cachedClientId;
  }

  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: `/quantara/${ENVIRONMENT}/aldero-m2m-client-id`,
        WithDecryption: false,
      }),
    );
    cachedClientId = result.Parameter?.Value ?? "";
    return cachedClientId;
  } catch {
    return process.env.APP_ID ?? "";
  }
}

async function getClientSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;

  if (process.env.ALDERO_CLIENT_SECRET) {
    cachedSecret = process.env.ALDERO_CLIENT_SECRET;
    return cachedSecret;
  }

  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: `/quantara/${ENVIRONMENT}/aldero-client-secret`,
        WithDecryption: true,
      }),
    );
    cachedSecret = result.Parameter?.Value ?? "";
    return cachedSecret;
  } catch {
    return "";
  }
}

async function buildAuthHeader(): Promise<Record<string, string>> {
  const secret = await getClientSecret();
  if (!secret) return {};
  const clientId = await getM2MClientId();
  const encoded = Buffer.from(`${clientId}:${secret}`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

export async function alderoPost(
  path: string,
  body: unknown,
  bearerToken?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  } else {
    const authHeader = await buildAuthHeader();
    Object.assign(headers, authHeader);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new AlderoError(res.status, data);
  }
  return data;
}

export async function alderoGet(path: string, bearerToken?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  } else {
    const authHeader = await buildAuthHeader();
    Object.assign(headers, authHeader);
  }

  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const data = await res.json();
  if (!res.ok) {
    throw new AlderoError(res.status, data);
  }
  return data;
}

export async function alderoDelete(path: string, bearerToken?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  } else {
    const authHeader = await buildAuthHeader();
    Object.assign(headers, authHeader);
  }

  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE", headers });
  if (res.status === 204) return {};
  const data = await res.json();
  if (!res.ok) {
    throw new AlderoError(res.status, data);
  }
  return data;
}

export function getAlderoRedirectUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export class AlderoError extends Error {
  statusCode: number;
  body: unknown;

  constructor(statusCode: number, body: unknown) {
    const raw =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      (body as { message?: string } | null)?.message ??
      "";
    // Strip internal service name from error messages
    const msg =
      raw ||
      (statusCode === 401
        ? "Invalid credentials"
        : statusCode === 403
          ? "Access denied"
          : statusCode === 404
            ? "Not found"
            : statusCode === 409
              ? "Already exists or in progress"
              : statusCode === 429
                ? "Too many requests"
                : "Something went wrong");
    super(msg);
    this.statusCode = statusCode;
    this.body = body;
  }
}
