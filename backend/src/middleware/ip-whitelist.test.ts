import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetParameterCommand: vi.fn().mockImplementation((input) => input),
}));

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  delete process.env.SKIP_IP_WHITELIST;
});

async function buildApp() {
  const { ipWhitelist } = await import("./ip-whitelist.js");
  const app = new Hono();
  app.use(ipWhitelist);
  app.get("/", (c) => c.text("ok"));
  return app;
}

function withClientIp(ip: string) {
  return { headers: { "x-forwarded-for": ip } };
}

describe("ipWhitelist", () => {
  it("allows everything when SKIP_IP_WHITELIST=true (no SSM call)", async () => {
    process.env.SKIP_IP_WHITELIST = "true";
    const app = await buildApp();
    const res = await app.request("/", withClientIp("198.51.100.5"));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("allows an IPv4 inside a /24 from the SSM allow-list", async () => {
    sendMock.mockResolvedValue({ Parameter: { Value: "68.4.159.0/24" } });
    const app = await buildApp();
    const res = await app.request("/", withClientIp("68.4.159.213"));
    expect(res.status).toBe(200);
  });

  it("denies an IPv4 outside the /24", async () => {
    sendMock.mockResolvedValue({ Parameter: { Value: "68.4.159.0/24" } });
    const app = await buildApp();
    const res = await app.request("/", withClientIp("68.4.160.1"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("allows an IPv6 inside a /64 prefix", async () => {
    sendMock.mockResolvedValue({ Parameter: { Value: "2607:fb91:307:c96::/64" } });
    const app = await buildApp();
    const res = await app.request("/", withClientIp("2607:fb91:307:c96:1234:5678:9abc:def0"));
    expect(res.status).toBe(200);
  });

  it("does not match an IPv4 client against an IPv6 CIDR (no kind cross-talk)", async () => {
    sendMock.mockResolvedValue({ Parameter: { Value: "::/0" } });
    const app = await buildApp();
    const res = await app.request("/", withClientIp("198.51.100.5"));
    expect(res.status).toBe(403);
  });

  it("denies on cold-cache SSM failure (fail-closed)", async () => {
    sendMock.mockRejectedValue(new Error("ssm down"));
    const app = await buildApp();
    const res = await app.request("/", withClientIp("68.4.159.213"));
    expect(res.status).toBe(403);
  });

  it("treats a literal '*' entry as allow-all", async () => {
    sendMock.mockResolvedValue({ Parameter: { Value: "*" } });
    const app = await buildApp();
    const res = await app.request("/", withClientIp("203.0.113.99"));
    expect(res.status).toBe(200);
  });
});
