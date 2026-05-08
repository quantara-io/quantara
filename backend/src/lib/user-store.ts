/**
 * user-store — backend DynamoDB helpers for the `users` table.
 *
 * Quantara's auth lives in Aldero; this table is a profile cache.
 * Risk profiles are written here at user creation and on tier change
 * so the signal-fetch route can do read-time risk attachment.
 *
 * Design: Phase 7 follow-up (issue #87) — Corrections 2 & 3.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { UserProfile } from "@quantara/shared";
import {
  defaultRiskProfiles,
  mergeTierRiskProfiles,
  tierIdToTier,
} from "@quantara/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USERS_TABLE =
  process.env.TABLE_USERS ??
  `${process.env.TABLE_PREFIX ?? "quantara-dev-"}users`;

/**
 * Fetch a user record from the users table. Returns null if not found.
 */
export async function getUser(userId: string): Promise<UserProfile | null> {
  const result = await client.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId },
    }),
  );
  if (!result.Item) return null;
  return result.Item as UserProfile;
}

/**
 * Write a new user record seeded with defaultRiskProfiles.
 * Called from the signup/first-login bootstrap path.
 *
 * Correction 2: persists defaultRiskProfiles(tier) at user creation time
 * so new records always carry the field.
 */
export async function bootstrapUser(
  userId: string,
  email: string,
  tierId: string,
  extra?: Partial<Omit<UserProfile, "userId" | "email" | "tierId" | "riskProfiles" | "createdAt" | "updatedAt">>,
): Promise<UserProfile> {
  const now = new Date().toISOString();
  const tier = tierIdToTier(tierId);
  const riskProfiles = defaultRiskProfiles(tier);

  const user: UserProfile = {
    userId,
    email,
    tierId,
    displayName: extra?.displayName ?? email.split("@")[0] ?? userId,
    userType: extra?.userType ?? "retail",
    riskProfiles,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };

  try {
    await client.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: user,
        // Only write if the user doesn't already exist — idempotent bootstrap
        ConditionExpression: "attribute_not_exists(userId)",
      }),
    );
  } catch (err: unknown) {
    // If the user already exists, treat as a no-op (idempotent)
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return user;
    }
    throw err;
  }

  return user;
}

/**
 * Update the user's tier and merge risk profiles accordingly.
 *
 * Correction 2 (tier-change path): calls mergeTierRiskProfiles so that
 * user overrides survive the upgrade/downgrade while tier-defaulted pairs
 * are updated to the new default.
 *
 * @param userId         The user to update.
 * @param newTierId      The new tier id.
 * @param currentUser    Current user record (must be loaded by the caller).
 */
export async function updateUserTier(
  userId: string,
  newTierId: string,
  currentUser: UserProfile,
): Promise<void> {
  const oldTier = tierIdToTier(currentUser.tierId);
  const newTier = tierIdToTier(newTierId);

  // Compute the merged risk profiles, preserving user overrides
  const currentProfiles = currentUser.riskProfiles ?? defaultRiskProfiles(oldTier);
  const mergedProfiles = mergeTierRiskProfiles(currentProfiles, oldTier, newTier);

  const now = new Date().toISOString();
  await client.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: "SET tierId = :tid, riskProfiles = :rp, updatedAt = :now",
      ExpressionAttributeValues: {
        ":tid": newTierId,
        ":rp": mergedProfiles,
        ":now": now,
      },
    }),
  );
}
