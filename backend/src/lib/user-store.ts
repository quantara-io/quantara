/**
 * user-store — profile-cache layer for the Quantara `users` DynamoDB table.
 *
 * Aldero owns identity (JWT, sessions). This module owns the Quantara-side
 * profile cache: subscription tier, risk profiles, and other product fields.
 *
 * Key design rule: this module is NEVER called from auth routes or from the
 * JWT-verification path. Bootstrap happens lazily on first authenticated read
 * (see getOrCreateUserRecord).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { UserProfile, Tier } from "@quantara/shared";
import { defaultRiskProfiles, mergeTierRiskProfiles } from "@quantara/shared";

const USERS_TABLE =
  process.env.TABLE_USERS ?? `${process.env.TABLE_PREFIX ?? "quantara-dev-"}users`;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Fetch a user record by userId. Returns undefined when the record doesn't
 * exist yet (first-time user — call getOrCreateUserRecord instead).
 */
export async function getUser(userId: string): Promise<UserProfile | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId },
    }),
  );
  if (!result.Item) return undefined;
  const item = result.Item as Partial<UserProfile> & { userId: string };
  // Backwards-compat: records without `tier` default to "free".
  return {
    ...item,
    tier: item.tier ?? "free",
  } as UserProfile;
}

/**
 * Persist a user record. Uses a conditional Put with attribute_not_exists(userId)
 * for idempotency — if a concurrent writer already inserted the record this call
 * is a no-op (the condition fails silently; both writers produce the same default
 * values so the result is correct).
 *
 * For updates to existing records, call putUserUnchecked.
 */
export async function putUser(profile: UserProfile): Promise<void> {
  try {
    await client.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: profile,
        ConditionExpression: "attribute_not_exists(userId)",
      }),
    );
  } catch (err: unknown) {
    // ConditionalCheckFailedException means another writer already inserted the
    // record — treat as success (idempotent bootstrap).
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return;
    throw err;
  }
}

/**
 * Unconditional Put — use for updates to fields on existing records (e.g. tier
 * upgrade via a future billing API). Never call this from bootstrap paths.
 */
export async function putUserUnchecked(profile: UserProfile): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: USERS_TABLE,
      Item: profile,
    }),
  );
}

/**
 * Lazy bootstrap: return the user's profile, creating it with tier="free" and
 * conservative defaults if this is their first authenticated request.
 *
 * This is the correct call site for the signal-service read path. It must NOT
 * be called from auth routes, signup handlers, or JWT-verification middleware.
 *
 * @param userId   The `sub` claim from the verified JWT (AuthContext.userId).
 * @param email    Optional email from JWT claims — recorded on first creation.
 */
export async function getOrCreateUserRecord(
  userId: string,
  email?: string,
): Promise<UserProfile & { tier: Tier }> {
  const existing = await getUser(userId);
  if (existing) {
    return { ...existing, tier: existing.tier ?? "free" };
  }

  const now = new Date().toISOString();
  const fresh: UserProfile = {
    userId,
    email: email ?? "",
    displayName: "",
    userType: "retail",
    tier: "free",
    riskProfiles: defaultRiskProfiles("free"),
    createdAt: now,
    updatedAt: now,
  };

  await putUser(fresh);
  return fresh as UserProfile & { tier: Tier };
}

/**
 * Update the user's subscription tier and re-derive risk profiles.
 * Exposed for a future billing API — do not call from auth flows.
 *
 * Uses mergeTierRiskProfiles so per-pair overrides set by the user are
 * preserved on upgrade/downgrade.
 */
export async function updateUserTier(userId: string, newTier: Tier): Promise<UserProfile> {
  const existing = await getOrCreateUserRecord(userId);
  const updatedProfile: UserProfile = {
    ...existing,
    tier: newTier,
    riskProfiles: mergeTierRiskProfiles(existing.riskProfiles, existing.tier, newTier),
    updatedAt: new Date().toISOString(),
  };
  await putUserUnchecked(updatedProfile);
  return updatedProfile;
}
