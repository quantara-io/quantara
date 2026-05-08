import { describe, it, expect, vi, beforeEach } from "vitest";

const alderoPostMock = vi.fn();
const getRedirectUrlMock = vi.fn();

vi.mock("../lib/aldero-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/aldero-client.js")>("../lib/aldero-client.js");
  return {
    ...actual,
    alderoPost: alderoPostMock,
    getAlderoRedirectUrl: getRedirectUrlMock,
  };
});

// SSM is only consulted if OAUTH_STATE_SECRET is unset; we set it in
// beforeEach so the mock SSM client is never reached. We still mock the
// SDK so importing the route file doesn't try to hit AWS.
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  GetParameterCommand: vi.fn().mockImplementation((input) => input),
}));

beforeEach(() => {
  vi.resetModules();
  alderoPostMock.mockReset();
  getRedirectUrlMock.mockReset();
  process.env.OAUTH_STATE_SECRET = "test-cookie-secret-at-least-32-chars-long-for-hmac";
  // Default redirect for OAuth init tests.
  getRedirectUrlMock.mockReturnValue("https://aldero.test/v1/auth/oauth/google?redirect_uri=cb");
});

async function loadApp() {
  const { authOAuth } = await import("./auth-oauth.js");
  return authOAuth;
}

describe("GET /oauth/:provider", () => {
  it("sets a signed state cookie and redirects to Aldero with the round-tripped cs", async () => {
    const app = await loadApp();
    const res = await app.request("/oauth/google", {
      headers: { Host: "api.example.com" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://aldero.test/v1/auth/oauth/google?redirect_uri=cb",
    );
    // Cookie was set with HttpOnly + Secure + scoped path
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/qoauth_cs=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\/api\/auth\/oauth/i);

    // Aldero redirect URL was built with a callback that carries the cs param
    expect(getRedirectUrlMock).toHaveBeenCalledTimes(1);
    const [path, params] = getRedirectUrlMock.mock.calls[0];
    expect(path).toBe("/v1/auth/oauth/google");
    expect(params.redirect_uri).toMatch(/[?&]cs=[^&]+$/);
  });

  it("uses an explicit redirect_uri from the query and appends cs with the right separator", async () => {
    const app = await loadApp();
    await app.request("/oauth/google?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Ffoo%3Dbar");
    const params = getRedirectUrlMock.mock.calls[0][1];
    // Already had a query string, so cs should be appended with &
    expect(params.redirect_uri).toMatch(/^https:\/\/app\.example\.com\/cb\?foo=bar&cs=/);
  });

  it("rejects an unknown provider via zod param validation", async () => {
    const app = await loadApp();
    const res = await app.request("/oauth/facebook");
    expect(res.status).toBe(400);
    expect(getRedirectUrlMock).not.toHaveBeenCalled();
  });
});

describe("GET /oauth/:provider/callback", () => {
  // Helper: drive the full init→callback cycle so we have a real cookie
  // signed with the test secret. Saves us from reimplementing the HMAC.
  async function initAndCapture(app: any) {
    const initRes = await app.request("/oauth/google");
    const setCookie = initRes.headers.get("Set-Cookie") ?? "";
    const cookieHeader = setCookie.split(";")[0]; // "qoauth_cs=<signed>"
    // Extract the original cs value from the redirect URL Aldero would have received.
    const params = getRedirectUrlMock.mock.calls.at(-1)![1] as { redirect_uri: string };
    const cs = new URL(params.redirect_uri).searchParams.get("cs")!;
    return { cookieHeader, cs };
  }

  it("succeeds when the cookie state matches the cs query param", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at" });
    const app = await loadApp();
    const { cookieHeader, cs } = await initAndCapture(app);

    const res = await app.request(
      `/oauth/google/callback?code=auth_code&state=s&cs=${encodeURIComponent(cs)}`,
      { headers: { Cookie: cookieHeader } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.accessToken).toBe("at");
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/oauth/google/callback", {
      code: "auth_code",
      state: "s",
    });
    // Cookie is single-use; should be cleared on the response
    const clearCookie = res.headers.get("Set-Cookie") ?? "";
    expect(clearCookie).toMatch(/qoauth_cs=;/);
  });

  it("returns 400 INVALID_STATE when the cookie is missing", async () => {
    const app = await loadApp();
    const res = await app.request("/oauth/google/callback?code=c&state=s&cs=tampered");
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_STATE");
    expect(alderoPostMock).not.toHaveBeenCalled();
  });

  it("returns 400 INVALID_STATE when cookie state and cs don't match", async () => {
    const app = await loadApp();
    const { cookieHeader } = await initAndCapture(app);
    const res = await app.request("/oauth/google/callback?code=c&state=s&cs=wrong-value", {
      headers: { Cookie: cookieHeader },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("returns 400 OAUTH_ERROR when the provider sends back an error", async () => {
    const app = await loadApp();
    const { cookieHeader, cs } = await initAndCapture(app);
    const res = await app.request(
      `/oauth/google/callback?error=access_denied&cs=${encodeURIComponent(cs)}`,
      { headers: { Cookie: cookieHeader } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("OAUTH_ERROR");
    expect(body.error.message).toBe("access_denied");
    expect(alderoPostMock).not.toHaveBeenCalled();
  });

  it("translates AlderoError into 400 OAUTH_FAILED on token exchange failure", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(new AlderoError(400, { error: { message: "bad code" } }));
    const app = await loadApp();
    const { cookieHeader, cs } = await initAndCapture(app);

    const res = await app.request(
      `/oauth/google/callback?code=bad&state=s&cs=${encodeURIComponent(cs)}`,
      { headers: { Cookie: cookieHeader } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("OAUTH_FAILED");
  });
});

describe("POST /oauth/:provider/native", () => {
  it("forwards the native ID token to Aldero and returns the tokens", async () => {
    alderoPostMock.mockResolvedValue({ accessToken: "at" });
    const app = await loadApp();
    const res = await app.request("/oauth/google/native", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "google-id-token", displayName: "Nate" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.accessToken).toBe("at");
    expect(alderoPostMock).toHaveBeenCalledWith("/v1/auth/oauth/google/native", {
      idToken: "google-id-token",
      displayName: "Nate",
    });
  });

  it("translates AlderoError into 401 OAUTH_FAILED", async () => {
    const { AlderoError } = await import("../lib/aldero-client.js");
    alderoPostMock.mockRejectedValue(
      new AlderoError(401, { error: { message: "invalid id token" } }),
    );
    const app = await loadApp();
    const res = await app.request("/oauth/google/native", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "bad" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("OAUTH_FAILED");
  });
});
