import { describe, it, expect, vi, beforeEach } from "vitest";

const alderoPostMock = vi.fn();
const alderoGetMock = vi.fn();

vi.mock("../lib/aldero-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/aldero-client.js")>("../lib/aldero-client.js");
  return {
    ...actual,
    alderoPost: alderoPostMock,
    alderoGet: alderoGetMock,
  };
});

// Pass-through requireAuth that injects a fake auth context. The real
// middleware is covered by middleware/require-auth.test.ts.
const fakeAuth = {
  userId: "user_123",
  email: "a@b.com",
  emailVerified: true,
  authMethod: "password",
  sessionId: "sess_1",
  role: "user",
};
vi.mock("../middleware/require-auth.js", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("auth", fakeAuth);
    await next();
  },
}));

beforeEach(() => {
  vi.resetModules();
  alderoPostMock.mockReset();
  alderoGetMock.mockReset();
});

async function loadApp() {
  const { auth } = await import("./auth.js");
  return auth;
}

describe("GET /config", () => {
  it("returns the full config when Aldero discovery is reachable", async () => {
    alderoGetMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.passkeyEnabled).toBe(true);
    expect(body.data.oauthProviders).toEqual(["google", "apple"]);
    expect(body.data.authMethods).toContain("oauth_google");
  });

  it("returns the reduced fallback config when discovery fails", async () => {
    alderoGetMock.mockRejectedValue(new Error("network down"));
    const app = await loadApp();
    const res = await app.request("/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.passkeyEnabled).toBe(false);
    expect(body.data.oauthProviders).toEqual([]);
    expect(body.data.authMethods).toEqual(["email_password"]);
  });
});

describe("POST /signup", () => {
  it("returns the upstream payload on success", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at", user: { id: "u1" } });
    const app = await loadApp();
    const res = await app.request("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({
      success: true,
      data: { accessToken: "at", user: { id: "u1" } },
    });
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/signup", {
      email: "a@b.com",
      password: "password123",
    });
  });

  it("translates AlderoError into a SIGNUP_FAILED error response", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(409, { error: { message: "email exists" } }));
    const app = await loadApp();
    const res = await app.request("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "SIGNUP_FAILED", message: "email exists" },
    });
  });

  it("rejects bodies that fail zod validation", async () => {
    const app = await loadApp();
    const res = await app.request("/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "short" }),
    });
    expect(res.status).toBe(400);
    expect(alderoPostMock).not.toHaveBeenCalled();
  });
});

describe("POST /login", () => {
  it("returns the upstream payload on success", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at", user: { id: "u1" } });
    const app = await loadApp();
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.accessToken).toBe("at");
  });

  it("translates the mfa_required AlderoError body into a 200 with mfaRequired payload", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(
      new AlderoError(403, {
        error: "mfa_required",
        mfa_token: "mfa_abc",
        available_methods: ["totp", "email"],
      }),
    );
    const app = await loadApp();
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({
      success: true,
      data: {
        mfaRequired: true,
        mfaToken: "mfa_abc",
        availableMethods: ["totp", "email"],
      },
    });
  });

  it("returns 401 INVALID_CREDENTIALS for a generic 401", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(401, {}));
    const app = await loadApp();
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns 423 ACCOUNT_LOCKED when upstream returns 423", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(423, { error: { message: "locked" } }));
    const app = await loadApp();
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(res.status).toBe(423);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("ACCOUNT_LOCKED");
  });
});

describe("POST /logout", () => {
  it("returns success even when the upstream call fails", async () => {
    alderoPostMock.mockRejectedValue(new Error("aldero down"));
    const app = await loadApp();
    const res = await app.request("/logout", {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { message: "Logged out" },
    });
    // Token is forwarded to Aldero
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/logout", {}, "user-jwt");
  });
});

describe("POST /token/refresh", () => {
  it("returns the new tokens on success", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at2", refreshToken: "rt2" });
    const app = await loadApp();
    const res = await app.request("/token/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.accessToken).toBe("at2");
  });

  it("translates AlderoError into 401 INVALID_TOKEN", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(401, { error: { message: "expired" } }));
    const app = await loadApp();
    const res = await app.request("/token/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt1" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_TOKEN");
  });
});

describe("GET /me", () => {
  it("returns the user profile from the auth context (no upstream call)", async () => {
    const app = await loadApp();
    const res = await app.request("/me", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.user).toEqual({
      userId: fakeAuth.userId,
      email: fakeAuth.email,
      emailVerified: fakeAuth.emailVerified,
      displayName: null,
      role: fakeAuth.role,
    });
    expect(alderoPostMock).not.toHaveBeenCalled();
    expect(alderoGetMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /me", () => {
  it("forwards the body and returns the success message", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ displayName: "Nate" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { message: "Profile updated" },
    });
    expect(alderoPostMock).toHaveBeenCalledWith(
      "/v1/auth/profile",
      { displayName: "Nate" },
      "user-jwt",
    );
  });

  it("translates AlderoError into 401 UPDATE_FAILED", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(403, { error: { message: "nope" } }));
    const app = await loadApp();
    const res = await app.request("/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ displayName: "Nate" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("UPDATE_FAILED");
  });
});
