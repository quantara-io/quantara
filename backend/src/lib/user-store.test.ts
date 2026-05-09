/**
 * Tests for user-store.ts — profile-cache lazy bootstrap layer.
 *
 * Covers:
 *   - First-time user: record created with tier="free" + conservative defaults
 *   - Existing user: record returned as-is, no duplicate Put
 *   - User without `tier` field (old DDB record): defaults to "free" on read
 *   - getOrCreateUserRecord returns tier="free" always for new and legacy records
 *   - Concurrent bootstrap: ConditionalCheckFailedException treated as success
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultRiskProfiles } from "@quantara/shared";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({ send: sendMock }),
  },
  GetCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "GetCommand" })),
  PutCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: "PutCommand" })),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  delete process.env.TABLE_USERS;
  delete process.env.TABLE_PREFIX;
});

async function loadStore() {
  return await import("./user-store.js");
}

// ---------------------------------------------------------------------------
// getUser
// ---------------------------------------------------------------------------

describe("getUser", () => {
  it("returns undefined when the record does not exist", async () => {
    sendMock.mockResolvedValue({ Item: undefined });
    const { getUser } = await loadStore();
    const result = await getUser("user_new");
    expect(result).toBeUndefined();
  });

  it("returns the user record when it exists", async () => {
    const stored = {
      userId: "user_abc",
      email: "a@b.com",
      displayName: "Alice",
      userType: "retail",
      tier: "free",
      riskProfiles: { "BTC/USDT": "conservative" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    sendMock.mockResolvedValue({ Item: stored });
    const { getUser } = await loadStore();
    const result = await getUser("user_abc");
    expect(result).toMatchObject({ userId: "user_abc", tier: "free" });
  });

  it("defaults tier to 'free' when the stored record has no tier field (legacy record)", async () => {
    const legacyRecord = {
      userId: "user_legacy",
      email: "legacy@b.com",
      displayName: "Bob",
      userType: "retail",
      // no tier field
      riskProfiles: { "BTC/USDT": "conservative" },
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    sendMock.mockResolvedValue({ Item: legacyRecord });
    const { getUser } = await loadStore();
    const result = await getUser("user_legacy");
    expect(result).toBeDefined();
    expect(result!.tier).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// putUser (conditional)
// ---------------------------------------------------------------------------

describe("putUser", () => {
  it("sends a PutCommand with ConditionExpression attribute_not_exists(userId)", async () => {
    sendMock.mockResolvedValue({});
    const { putUser } = await loadStore();
    const profile = {
      userId: "user_x",
      email: "x@b.com",
      displayName: "",
      userType: "retail" as const,
      tier: "free" as const,
      riskProfiles: defaultRiskProfiles("free"),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await putUser(profile);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0];
    expect(call.ConditionExpression).toBe("attribute_not_exists(userId)");
    expect(call.Item.userId).toBe("user_x");
    expect(call.Item.tier).toBe("free");
  });

  it("silently ignores ConditionalCheckFailedException (idempotent bootstrap)", async () => {
    const err = Object.assign(new Error("Conflict"), {
      name: "ConditionalCheckFailedException",
    });
    sendMock.mockRejectedValue(err);
    const { putUser } = await loadStore();
    const profile = {
      userId: "user_race",
      email: "",
      displayName: "",
      userType: "retail" as const,
      tier: "free" as const,
      riskProfiles: defaultRiskProfiles("free"),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    // Should not throw
    await expect(putUser(profile)).resolves.toBeUndefined();
  });

  it("re-throws non-conditional errors", async () => {
    sendMock.mockRejectedValue(new Error("network failure"));
    const { putUser } = await loadStore();
    const profile = {
      userId: "user_err",
      email: "",
      displayName: "",
      userType: "retail" as const,
      tier: "free" as const,
      riskProfiles: defaultRiskProfiles("free"),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(putUser(profile)).rejects.toThrow("network failure");
  });
});

// ---------------------------------------------------------------------------
// getOrCreateUserRecord
// ---------------------------------------------------------------------------

describe("getOrCreateUserRecord", () => {
  it("creates a new record with tier='free' and conservative defaults for a first-time user", async () => {
    // First call (getUser) returns no item; second call (putUser) succeeds.
    sendMock
      .mockResolvedValueOnce({ Item: undefined }) // GetCommand
      .mockResolvedValueOnce({}); // PutCommand

    const { getOrCreateUserRecord } = await loadStore();
    const result = await getOrCreateUserRecord("user_new_001", "new@b.com");

    expect(result.userId).toBe("user_new_001");
    expect(result.tier).toBe("free");
    // All pairs should be "conservative" for a free-tier user.
    const profiles = Object.values(result.riskProfiles);
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.every((p) => p === "conservative")).toBe(true);
    // Email recorded on creation.
    expect(result.email).toBe("new@b.com");
  });

  it("returns the existing record without calling putUser when the record exists", async () => {
    const stored = {
      userId: "user_existing",
      email: "exists@b.com",
      displayName: "Eve",
      userType: "retail",
      tier: "paid",
      riskProfiles: { "BTC/USDT": "moderate" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    sendMock.mockResolvedValueOnce({ Item: stored });

    const { getOrCreateUserRecord } = await loadStore();
    const result = await getOrCreateUserRecord("user_existing");

    // Only one DDB call (the GetCommand) — no PutCommand for existing users.
    expect(sendMock).toHaveBeenCalledOnce();
    expect(result.tier).toBe("paid");
    expect(result.userId).toBe("user_existing");
  });

  it("defaults tier to 'free' for an existing record that has no tier field", async () => {
    const legacyRecord = {
      userId: "user_legacy2",
      email: "leg2@b.com",
      displayName: "Legacy",
      userType: "retail",
      // no tier
      riskProfiles: { "BTC/USDT": "conservative" },
      createdAt: "2025-06-01T00:00:00.000Z",
      updatedAt: "2025-06-01T00:00:00.000Z",
    };
    sendMock.mockResolvedValueOnce({ Item: legacyRecord });

    const { getOrCreateUserRecord } = await loadStore();
    const result = await getOrCreateUserRecord("user_legacy2");

    expect(result.tier).toBe("free");
    // No Put was issued for a legacy read.
    expect(sendMock).toHaveBeenCalledOnce();
  });
});
