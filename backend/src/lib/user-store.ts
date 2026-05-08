import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { defaultRiskProfiles } from "@quantara/shared";
import type { Tier } from "@quantara/shared";

import { logger } from "./logger.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USERS_TABLE =
  process.env.TABLE_USERS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}users`;

/**
 * Seed a brand-new user row in the users table with tier-appropriate risk profiles.
 *
 * - `tier` MUST come from the Aldero JWT claim (via `tierIdToTier(claims.tierId)`).
 * - Never hard-defaults the tier — the caller is responsible for resolving it.
 * - If the user row already exists (idempotent re-call on retry), the existing
 *   row is left untouched (conditional write: only puts when item is absent).
 *
 * @param userId  Aldero user ID (`sub` from JWT).
 * @param tier    Resolved tier ("free" | "paid") — never pass a literal default.
 */
export async function bootstrapUser(userId: string, tier: Tier): Promise<void> {
  const now = new Date().toISOString();
  const item = {
    userId,
    tierId: tier === "free" ? "111" : "paid",
    riskProfiles: defaultRiskProfiles(tier),
    createdAt: now,
    updatedAt: now,
  };

  try {
    await client.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: item,
        // Idempotent: don't overwrite an existing row that may have user overrides.
        ConditionExpression: "attribute_not_exists(userId)",
      }),
    );
    logger.info({ userId, tier }, "User bootstrapped");
  } catch (err: unknown) {
    // ConditionalCheckFailedException means the row already exists — safe to ignore.
    if (
      err instanceof Error &&
      (err as Error & { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      logger.debug({ userId }, "bootstrapUser: row already exists, skipping");
      return;
    }
    throw err;
  }
}

/**
 * Load an existing user row by userId.
 * Returns `null` when the user hasn't been bootstrapped yet.
 */
export async function loadUser(userId: string): Promise<Record<string, unknown> | null> {
  const result = await client.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId },
    }),
  );
  return (result.Item as Record<string, unknown> | undefined) ?? null;
}
