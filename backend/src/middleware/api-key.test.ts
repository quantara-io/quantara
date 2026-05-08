import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetParametersByPathCommand: vi.fn().mockImplementation((input) => input),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  delete process.env.SKIP_API_KEY;
});

async function buildApp() {
  const { requireApiKey } = await import("./api-key.js");
  const app = new Hono();
  app.use(requireApiKey);
  app.get("/", (c) => c.json({ client: c.get("apiClient" as never) }));
  return app;
}

describe("requireApiKey", () => {
  it("rejects requests with no x-api-key header", async () => {
    process.env.SKIP_API_KEY = "true"; // skip SSM, focus on header check
    const app = await buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("API_KEY_REQUIRED");
  });

  it("allows the local-dev bypass key when SKIP_API_KEY=true", async () => {
    process.env.SKIP_API_KEY = "true";
    const app = await buildApp();
    const res = await app.request("/", { headers: { "x-api-key": "dev-local" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.client).toBe("local");
  });

  it("rejects an unknown key with INVALID_API_KEY when SSM returns an empty list", async () => {
    sendMock.mockResolvedValue({ Parameters: [] });
    const app = await buildApp();
    const res = await app.request("/", { headers: { "x-api-key": "unknown" } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_API_KEY");
  });

  it("accepts a known key from SSM and sets apiClient to the parameter name", async () => {
    sendMock.mockResolvedValue({
      Parameters: [{ Name: "/quantara/dev/api-keys/dashboard", Value: "secret-key-1" }],
    });
    const app = await buildApp();
    const res = await app.request("/", { headers: { "x-api-key": "secret-key-1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.client).toBe("dashboard");
  });

  it("denies on cold-cache SSM failure (fail-closed)", async () => {
    sendMock.mockRejectedValue(new Error("ssm down"));
    const app = await buildApp();
    const res = await app.request("/", { headers: { "x-api-key": "any-key" } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("INVALID_API_KEY");
  });
});
