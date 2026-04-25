import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input) => input),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  fetchMock.mockReset();
  // Use env vars so we never hit SSM in these tests.
  process.env.AUTH_BASE_URL = "https://aldero.test";
  process.env.ALDERO_M2M_CLIENT_ID = "client-1";
  process.env.ALDERO_CLIENT_SECRET = "shh";
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("alderoPost", () => {
  it("returns the parsed JSON body on a 2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, id: "abc" }));
    const { alderoPost } = await import("./aldero-client.js");
    const result = await alderoPost("/v1/auth/login", { email: "a@b.com" });
    expect(result).toEqual({ ok: true, id: "abc" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://aldero.test/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ email: "a@b.com" }));
  });

  it("uses Bearer auth when a token is provided and skips Basic auth", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { alderoPost } = await import("./aldero-client.js");
    await alderoPost("/v1/auth/me", {}, "user-jwt");

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer user-jwt");
    expect(sendMock).not.toHaveBeenCalled(); // no SSM lookup for client secret
  });

  it("falls back to Basic m2m auth when no bearer token is given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const { alderoPost } = await import("./aldero-client.js");
    await alderoPost("/v1/auth/signup", {});

    const init = fetchMock.mock.calls[0][1];
    const expected = `Basic ${Buffer.from("client-1:shh").toString("base64")}`;
    expect(init.headers.Authorization).toBe(expected);
  });

  it("throws AlderoError carrying the upstream status and body on a non-2xx", async () => {
    // Each fetch returns a fresh Response — the body stream can only
    // be read once, so the rejects.toMatchObject + instanceof check
    // need separate calls.
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: { message: "email exists" } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: { message: "email exists" } }));
    const { alderoPost, AlderoError } = await import("./aldero-client.js");

    await expect(alderoPost("/v1/auth/signup", {})).rejects.toMatchObject({
      statusCode: 409,
      body: { error: { message: "email exists" } },
    });
    await expect(alderoPost("/v1/auth/signup", {})).rejects.toBeInstanceOf(AlderoError);
  });
});

describe("AlderoError", () => {
  it("uses the upstream error.message when present", async () => {
    const { AlderoError } = await import("./aldero-client.js");
    const err = new AlderoError(400, { error: { message: "bad password" } });
    expect(err.message).toBe("bad password");
  });

  it("falls back to a friendly message keyed on the status code", async () => {
    const { AlderoError } = await import("./aldero-client.js");
    expect(new AlderoError(401, {}).message).toBe("Invalid credentials");
    expect(new AlderoError(403, {}).message).toBe("Access denied");
    expect(new AlderoError(429, {}).message).toBe("Too many requests");
    expect(new AlderoError(500, {}).message).toBe("Something went wrong");
  });
});

describe("getAlderoRedirectUrl", () => {
  it("appends the provided params as query strings", async () => {
    const { getAlderoRedirectUrl } = await import("./aldero-client.js");
    const url = getAlderoRedirectUrl("/v1/auth/oauth/google", {
      redirect_uri: "https://example.com/cb?cs=abc",
    });
    expect(url).toBe(
      "https://aldero.test/v1/auth/oauth/google?redirect_uri=https%3A%2F%2Fexample.com%2Fcb%3Fcs%3Dabc",
    );
  });
});
