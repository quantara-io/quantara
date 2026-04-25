import { describe, it, expect, vi, beforeEach } from "vitest";

const alderoPostMock = vi.fn();

vi.mock("../lib/aldero-client.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/aldero-client.js")>(
    "../lib/aldero-client.js",
  );
  return { ...actual, alderoPost: alderoPostMock };
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
});

async function loadApp() {
  const { authPassword } = await import("./auth-password.js");
  return authPassword;
}

describe("POST /magic-link/request", () => {
  it("forwards email + derived redirectUrl from Origin header", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/magic-link/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    expect(res.status).toBe(200);
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/magic-link/request", {
      email: "a@b.com",
      redirectUrl: "https://example.com/api/docs/demo?magic=true",
    });
  });

  it("prefers an explicit redirectUri from the body over the Origin-derived one", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    await app.request("/magic-link/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ email: "a@b.com", redirectUri: "https://app.example.com/cb" }),
    });
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/magic-link/request", {
      email: "a@b.com",
      redirectUrl: "https://app.example.com/cb",
    });
  });

  it("returns success even when the upstream call fails (enumeration-safe)", async () => {
    alderoPostMock.mockRejectedValue(new Error("aldero down"));
    const app = await loadApp();
    const res = await app.request("/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.data.message).toMatch(/if an account exists/i);
  });
});

describe("POST /magic-link/verify", () => {
  it("returns the upstream tokens on success", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at" });
    const app = await loadApp();
    const res = await app.request("/magic-link/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "magic_token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.accessToken).toBe("at");
  });

  it("translates AlderoError into 401 INVALID_TOKEN", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(401, { error: { message: "expired" } }));
    const app = await loadApp();
    const res = await app.request("/magic-link/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "magic_token" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_TOKEN");
  });
});

describe("POST /password/reset-request", () => {
  it("forwards the request with derived redirectUrl on success", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/password/reset-request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    expect(res.status).toBe(200);
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/password/reset-request", {
      email: "a@b.com",
      redirectUrl: "https://example.com/api/docs/demo?reset=true",
    });
  });

  it("returns success even when the upstream call fails (enumeration-safe)", async () => {
    alderoPostMock.mockRejectedValue(new Error("aldero down"));
    const app = await loadApp();
    const res = await app.request("/password/reset-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "unknown@example.com" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.message).toMatch(/if an account exists/i);
  });
});

describe("POST /password/reset", () => {
  it("returns success when upstream succeeds", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "reset_token", newPassword: "newpassword123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { message: "Password has been reset" },
    });
  });

  it("translates AlderoError into 400 RESET_FAILED", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(400, { error: { message: "expired" } }));
    const app = await loadApp();
    const res = await app.request("/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "reset_token", newPassword: "newpassword123" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("RESET_FAILED");
  });
});

describe("POST /email/verify/send", () => {
  it("forwards body + bearer token to Aldero", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/email/verify/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    expect(res.status).toBe(200);
    expect(alderoPostMock).toHaveBeenCalledWith(
      "/v1/auth/email/verify/send",
      { email: "a@b.com" },
      "user-jwt",
    );
  });
});

describe("POST /email/verify/confirm", () => {
  it("returns success on confirmation", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/email/verify/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { message: "Email verified" },
    });
    expect(alderoPostMock).toHaveBeenCalledWith(
      "/v1/auth/email/verify/confirm-code",
      { code: "123456" },
      "user-jwt",
    );
  });

  it("translates AlderoError into 400 INVALID_CODE", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(400, { error: { message: "wrong code" } }));
    const app = await loadApp();
    const res = await app.request("/email/verify/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ code: "999999" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_CODE");
  });
});
