import { describe, it, expect, vi, beforeEach } from "vitest";

const alderoPostMock = vi.fn();
const alderoGetMock = vi.fn();
const alderoDeleteMock = vi.fn();

vi.mock("../lib/aldero-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/aldero-client.js")>("../lib/aldero-client.js");
  return {
    ...actual,
    alderoPost: alderoPostMock,
    alderoGet: alderoGetMock,
    alderoDelete: alderoDeleteMock,
  };
});

vi.mock("../middleware/require-auth.js", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("auth", {
      userId: "user_123",
      email: "a@b.com",
      emailVerified: true,
      authMethod: "password",
      sessionId: "sess_1",
      role: "user",
    });
    await next();
  },
}));

beforeEach(() => {
  vi.resetModules();
  alderoPostMock.mockReset();
  alderoGetMock.mockReset();
  alderoDeleteMock.mockReset();
});

async function loadApp() {
  const { authPasskey } = await import("./auth-passkey.js");
  return authPasskey;
}

describe("POST /passkey/register/options", () => {
  it("returns the upstream registration challenge", async () => {
    alderoPostMock.mockResolvedValue({ challenge: "abc", rp: { id: "example.com" } });
    const app = await loadApp();
    const res = await app.request("/passkey/register/options", {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.challenge).toBe("abc");
    expect(alderoPostMock).toHaveBeenCalledWith(
      "/v1/auth/passkey/register/options",
      {},
      "user-jwt",
    );
  });
});

describe("POST /passkey/register/verify", () => {
  it("returns success when registration succeeds", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/passkey/register/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ id: "cred-1", response: { attestationObject: "..." } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.message).toMatch(/passkey registered/i);
    expect(alderoPostMock).toHaveBeenCalledWith(
      "/v1/auth/passkey/register/verify",
      { id: "cred-1", response: { attestationObject: "..." } },
      "user-jwt",
    );
  });

  it("translates AlderoError into 400 PASSKEY_FAILED", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(
      new AlderoError(400, { error: { message: "bad attestation" } }),
    );
    const app = await loadApp();
    const res = await app.request("/passkey/register/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ id: "cred-1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PASSKEY_FAILED");
  });
});

describe("POST /passkey/login/options", () => {
  it("forwards the email body to Aldero (no auth required)", async () => {
    alderoPostMock.mockResolvedValue({ challenge: "abc", allowCredentials: [] });
    const app = await loadApp();
    const res = await app.request("/passkey/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.challenge).toBe("abc");
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/passkey/authenticate/options", {
      email: "a@b.com",
    });
  });

  it("works with no email in the body (discovery flow)", async () => {
    alderoPostMock.mockResolvedValue({ challenge: "abc" });
    const app = await loadApp();
    const res = await app.request("/passkey/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/passkey/authenticate/options", {});
  });
});

describe("POST /passkey/login/verify", () => {
  it("returns the upstream tokens on success", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at", user: { id: "u1" } });
    const app = await loadApp();
    const res = await app.request("/passkey/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "cred-1", response: { signature: "..." } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.accessToken).toBe("at");
  });

  it("translates AlderoError into 401 PASSKEY_FAILED", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(401, { error: { message: "bad assertion" } }));
    const app = await loadApp();
    const res = await app.request("/passkey/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "cred-1" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("PASSKEY_FAILED");
  });
});

describe("GET /passkey/list", () => {
  it("returns the passkeys array when upstream wraps it in { passkeys }", async () => {
    alderoGetMock.mockResolvedValue({
      passkeys: [
        {
          credentialId: "c1",
          name: "iPhone",
          deviceType: "platform",
          backedUp: true,
          enrolledAt: "2026-01-01",
          lastUsedAt: null,
        },
      ],
    });
    const app = await loadApp();
    const res = await app.request("/passkey/list", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.passkeys).toHaveLength(1);
    expect(body.data.passkeys[0].credentialId).toBe("c1");
  });

  it("returns the array directly when upstream returns a bare array", async () => {
    alderoGetMock.mockResolvedValue([
      {
        credentialId: "c1",
        name: "Mac",
        deviceType: "platform",
        backedUp: true,
        enrolledAt: "x",
        lastUsedAt: null,
      },
    ]);
    const app = await loadApp();
    const res = await app.request("/passkey/list", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    const body = (await res.json()) as any;
    expect(body.data.passkeys).toHaveLength(1);
  });

  it("returns an empty array when upstream returns an unexpected shape", async () => {
    alderoGetMock.mockResolvedValue({ unexpected: "shape" });
    const app = await loadApp();
    const res = await app.request("/passkey/list", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    const body = (await res.json()) as any;
    expect(body.data.passkeys).toEqual([]);
  });
});

describe("DELETE /passkey/:id", () => {
  it("forwards the id and bearer token and returns success", async () => {
    alderoDeleteMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/passkey/pk_xyz", {
      method: "DELETE",
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { message: "Passkey removed" },
    });
    expect(alderoDeleteMock).toHaveBeenCalledWith("/v1/auth/passkey/pk_xyz", "user-jwt");
  });
});
