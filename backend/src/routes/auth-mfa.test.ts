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
  const { authMfa } = await import("./auth-mfa.js");
  return authMfa;
}

describe("GET /mfa/methods", () => {
  it("normalizes Aldero authenticator field variants into the response shape", async () => {
    alderoGetMock.mockResolvedValue([
      { id: "a1", authenticator_type: "totp", enrolled_at: "2026-01-01" },
      { id: "a2", authenticatorType: "email", enrolledAt: "2026-02-01" },
      { id: "a3", type: "recovery", createdAt: "2026-03-01", remaining_codes: 8 },
    ]);
    const app = await loadApp();
    const res = await app.request("/mfa/methods", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.available).toEqual(["totp", "email", "sms"]);
    expect(body.data.enrolled).toEqual([
      { id: "a1", type: "totp", enrolledAt: "2026-01-01" },
      { id: "a2", type: "email", enrolledAt: "2026-02-01" },
      { id: "a3", type: "recovery", enrolledAt: "2026-03-01", remaining_codes: 8 },
    ]);
  });

  it("returns an empty enrolled list when the upstream call fails", async () => {
    alderoGetMock.mockRejectedValue(new Error("aldero down"));
    const app = await loadApp();
    const res = await app.request("/mfa/methods", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.enrolled).toEqual([]);
    expect(body.data.available).toEqual(["totp", "email", "sms"]);
  });

  it("handles a non-array upstream response gracefully", async () => {
    alderoGetMock.mockResolvedValue({ unexpected: "shape" });
    const app = await loadApp();
    const res = await app.request("/mfa/methods", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.enrolled).toEqual([]);
  });
});

describe("POST /mfa/totp/setup", () => {
  it("returns the upstream secret and QR code on success", async () => {
    alderoPostMock.mockResolvedValue({ secret: "ABCD", qrCodeUrl: "otpauth://..." });
    const app = await loadApp();
    const res = await app.request("/mfa/totp/setup", {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.secret).toBe("ABCD");
    expect(alderoPostMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on 409 (pending setup) and returns the fresh secret", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock
      .mockRejectedValueOnce(new AlderoError(409, { error: { message: "pending" } }))
      .mockResolvedValueOnce({ secret: "FRESH" });
    const app = await loadApp();
    const res = await app.request("/mfa/totp/setup", {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.secret).toBe("FRESH");
    expect(alderoPostMock).toHaveBeenCalledTimes(2);
  });

  it("propagates non-409 AlderoErrors to Hono's error boundary", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(500, { error: { message: "server error" } }));
    const app = await loadApp();
    const res = await app.request("/mfa/totp/setup", {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    });
    // Hono default error handler returns 500
    expect(res.status).toBe(500);
  });
});

describe("POST /mfa/totp/confirm", () => {
  it("returns recovery codes on success", async () => {
    alderoPostMock.mockResolvedValue({ recoveryCodes: ["c1", "c2"] });
    const app = await loadApp();
    const res = await app.request("/mfa/totp/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.recoveryCodes).toEqual(["c1", "c2"]);
  });

  it("translates AlderoError into 400 INVALID_CODE", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(400, { error: { message: "bad code" } }));
    const app = await loadApp();
    const res = await app.request("/mfa/totp/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_CODE");
  });
});

describe("POST /mfa/email/setup", () => {
  it("forwards an empty body with bearer token and returns the success message", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/mfa/email/setup", {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.message).toMatch(/verification code sent/i);
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/mfa/email/setup", {}, "user-jwt");
  });
});

describe("POST /mfa/email/confirm", () => {
  it("returns success and propagates upstream payload on success", async () => {
    alderoPostMock.mockResolvedValue({ recoveryCodes: ["c1"] });
    const app = await loadApp();
    const res = await app.request("/mfa/email/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.recoveryCodes).toEqual(["c1"]);
  });

  it("translates AlderoError into 400 INVALID_CODE", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(400, { error: { message: "bad code" } }));
    const app = await loadApp();
    const res = await app.request("/mfa/email/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-jwt",
      },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_CODE");
  });
});

describe("POST /mfa/verify", () => {
  it("translates camelCase + recovery_code into Aldero's expected snake_case + recovery", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at" });
    const app = await loadApp();
    const res = await app.request("/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mfaToken: "mfa_abc",
        method: "recovery_code",
        code: "abcd-efgh",
        trustDevice: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/mfa/verify", {
      mfa_token: "mfa_abc",
      method: "recovery",
      code: "abcd-efgh",
      trustDevice: true,
    });
  });

  it("passes totp method through unchanged", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at" });
    const app = await loadApp();
    await app.request("/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mfaToken: "mfa_abc",
        method: "totp",
        code: "123456",
      }),
    });
    expect(alderoPostMock.mock.calls[0][1].method).toBe("totp");
  });

  it("translates AlderoError into 401 MFA_FAILED", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(401, { error: { message: "bad code" } }));
    const app = await loadApp();
    const res = await app.request("/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mfaToken: "mfa_abc",
        method: "totp",
        code: "000000",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("MFA_FAILED");
  });
});

describe("POST /mfa/challenge", () => {
  it("forwards mfa_token + challenge_type=oob and returns success", async () => {
    alderoPostMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/mfa/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken: "mfa_abc" }),
    });
    expect(res.status).toBe(200);
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/mfa/challenge", {
      mfa_token: "mfa_abc",
      challenge_type: "oob",
      oob_channel: "email",
    });
  });

  it("translates AlderoError into 400 CHALLENGE_FAILED", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(400, { error: { message: "bad token" } }));
    const app = await loadApp();
    const res = await app.request("/mfa/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken: "mfa_abc" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("CHALLENGE_FAILED");
  });
});

describe("POST /mfa/recovery/regenerate", () => {
  it("returns the new recovery codes from upstream", async () => {
    alderoPostMock.mockResolvedValue({ recoveryCodes: ["new1", "new2"] });
    const app = await loadApp();
    const res = await app.request("/mfa/recovery/regenerate", {
      method: "POST",
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.recoveryCodes).toEqual(["new1", "new2"]);
    expect(alderoPostMock).toHaveBeenCalledWith(
      "/v1/auth/mfa/recovery-codes/regenerate",
      {},
      "user-jwt",
    );
  });
});

describe("GET /mfa/authenticators", () => {
  it("normalizes the upstream list", async () => {
    alderoGetMock.mockResolvedValue([
      { id: "a1", type: "totp", enrolledAt: "2026-01-01" },
      { authenticatorId: "a2", authenticatorType: "email", createdAt: "2026-02-01" },
    ]);
    const app = await loadApp();
    const res = await app.request("/mfa/authenticators", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.enrolled).toEqual([
      { id: "a1", type: "totp", enrolledAt: "2026-01-01" },
      { id: "a2", type: "email", enrolledAt: "2026-02-01" },
    ]);
  });

  it("returns available: ['totp','email','sms'] — consistent with GET /mfa/methods", async () => {
    alderoGetMock.mockResolvedValue([]);
    const app = await loadApp();
    const res = await app.request("/mfa/authenticators", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // SMS must be present here to stay consistent with GET /mfa/methods (issue #110)
    expect(body.data.available).toEqual(["totp", "email", "sms"]);
  });

  it("handles non-array responses by returning an empty list", async () => {
    alderoGetMock.mockResolvedValue({ not: "an array" });
    const app = await loadApp();
    const res = await app.request("/mfa/authenticators", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.enrolled).toEqual([]);
  });
});

describe("DELETE /mfa/authenticators/:id", () => {
  it("forwards the id and bearer token to Aldero and returns success", async () => {
    alderoDeleteMock.mockResolvedValue({});
    const app = await loadApp();
    const res = await app.request("/mfa/authenticators/auth_xyz", {
      method: "DELETE",
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { message: "Authenticator removed" },
    });
    expect(alderoDeleteMock).toHaveBeenCalledWith(
      "/v1/auth/mfa/authenticators/auth_xyz",
      "user-jwt",
    );
  });
});
