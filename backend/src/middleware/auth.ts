import { createRemoteJWKSet, jwtVerify } from "jose";

import { UnauthorizedError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

const AUTH_BASE_URL = process.env.AUTH_BASE_URL ?? "https://quantara-sandbox.aldero.io";
const APP_ID = process.env.APP_ID ?? "";

const JWKS_URL = `${AUTH_BASE_URL}/.well-known/jwks.json`;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_URL));
  }
  return jwks;
}

export interface AuthContext {
  userId: string;
  email?: string;
  emailVerified?: boolean;
  authMethod?: string;
  sessionId?: string;
  role?: string;
  /** Aldero tierId claim — used to resolve Tier at bootstrap time. */
  tierId?: string;
}

export async function authenticate(authHeader: string | undefined): Promise<AuthContext> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);

  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: "auth",
      audience: APP_ID,
    });

    const userId = payload.sub;
    if (!userId) {
      throw new UnauthorizedError("Token missing sub claim");
    }

    return {
      userId,
      email: payload.email as string | undefined,
      emailVerified: payload.email_verified as boolean | undefined,
      authMethod: payload.auth_method as string | undefined,
      sessionId: payload.session_id as string | undefined,
      role: payload.role as string | undefined,
      tierId: payload.tier_id as string | undefined,
    };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    logger.warn({ err }, "JWT verification failed");
    throw new UnauthorizedError("Invalid or expired token");
  }
}
