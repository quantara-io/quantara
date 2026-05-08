/**
 * signal-service — backend read path for trading signals.
 *
 * On every fetch, the user record is lazily bootstrapped (getOrCreateUserRecord)
 * so that:
 *  - First-time users get tier="free" + conservative risk defaults automatically.
 *  - Existing users' profiles (including per-pair overrides) are preserved.
 *
 * This is the ONLY place where user-store bootstrap is invoked from the
 * signal read path. It is never called from auth routes or JWT middleware.
 */

import type { BlendedSignal } from "@quantara/shared";
import { PAIRS, type TradingPair } from "@quantara/shared";
import { getOrCreateUserRecord } from "./user-store.js";

export type { TradingPair };
export { PAIRS };

/**
 * Fetch the latest signal for a pair, enriching with the user's risk profile.
 * Bootstraps the user record on first call.
 *
 * @param userId  Authenticated user id (AuthContext.userId).
 * @param pair    Trading pair — must be a member of PAIRS.
 * @param email   Optional email from JWT claims passed to bootstrap.
 * @returns       The latest BlendedSignal, or null if no signal is available yet.
 */
export async function getSignalForUser(
  userId: string,
  pair: TradingPair,
  email?: string,
): Promise<BlendedSignal | null> {
  // Lazy bootstrap — creates record with tier="free" on first authenticated request.
  await getOrCreateUserRecord(userId, email);

  // Signal fetch is a placeholder — real implementation wires to the signals
  // DynamoDB table (see admin.service.ts getSignals for the query pattern).
  // `pair` is the lookup key; returning null is valid until the query is wired.
  void pair;
  return null;
}

/**
 * Fetch all latest signals, bootstrapping the user record if needed.
 *
 * @param userId  Authenticated user id.
 * @param email   Optional email from JWT claims.
 * @returns       Array of latest BlendedSignals (empty when none are available).
 */
export async function getAllSignalsForUser(
  userId: string,
  email?: string,
): Promise<BlendedSignal[]> {
  await getOrCreateUserRecord(userId, email);
  return [];
}
