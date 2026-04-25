import { describe, it, expect, vi, beforeEach } from "vitest";

const jwtVerifyMock = vi.fn();
vi.mock("jose", () => ({
  jwtVerify: jwtVerifyMock,
  createRemoteJWKSet: vi.fn().mockReturnValue({}),
}));

beforeEach(() => {
  vi.resetModules();
  jwtVerifyMock.mockReset();
});

async function loadAuthenticate() {
  const { authenticate } = await import("./auth.js");
  return authenticate;
}

describe("authenticate", () => {
  it("rejects a missing Authorization header", async () => {
    const authenticate = await loadAuthenticate();
    await expect(authenticate(undefined)).rejects.toThrow(/Missing or invalid/);
  });

  it("rejects a non-Bearer Authorization header", async () => {
    const authenticate = await loadAuthenticate();
    await expect(authenticate("Basic abc")).rejects.toThrow(/Missing or invalid/);
  });

  it("rejects a token whose payload has no sub claim", async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { email: "a@b.com" } });
    const authenticate = await loadAuthenticate();
    await expect(authenticate("Bearer t")).rejects.toThrow(/sub claim/);
  });

  it("returns an AuthContext built from the verified payload", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "user_123",
        email: "a@b.com",
        email_verified: true,
        auth_method: "password",
        session_id: "sess_1",
        role: "admin",
      },
    });
    const authenticate = await loadAuthenticate();
    const ctx = await authenticate("Bearer t");
    expect(ctx).toEqual({
      userId: "user_123",
      email: "a@b.com",
      emailVerified: true,
      authMethod: "password",
      sessionId: "sess_1",
      role: "admin",
    });
  });

  it("wraps an unrelated jwtVerify error as UnauthorizedError", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("signature verification failed"));
    const authenticate = await loadAuthenticate();
    await expect(authenticate("Bearer t")).rejects.toThrow(/Invalid or expired token/);
  });
});
