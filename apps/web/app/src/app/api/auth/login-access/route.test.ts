import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function request(code: unknown): Request {
  return new Request("http://localhost:3000/api/auth/login-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

describe("POST /api/auth/login-access", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets an HttpOnly access cookie for the configured code", async () => {
    vi.stubEnv("LOGIN_ACCESS_CODE", "preview-passphrase");

    const response = await POST(request("preview-passphrase"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain("breezify-login-access=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Path=/login");
  });

  it("rejects an incorrect code without setting a cookie", async () => {
    vi.stubEnv("LOGIN_ACCESS_CODE", "preview-passphrase");

    const response = await POST(request("wrong-code"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid access code." });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("accepts the legacy access-code environment variable", async () => {
    vi.stubEnv("LOGIN_ACCESS_CODE", "");
    vi.stubEnv("NEXT_PUBLIC_ACCESS_CODE", "legacy-passphrase");

    const response = await POST(request("legacy-passphrase"));

    expect(response.status).toBe(200);
  });

  it("stays disabled when no access code is configured", async () => {
    vi.stubEnv("LOGIN_ACCESS_CODE", "");
    vi.stubEnv("NEXT_PUBLIC_ACCESS_CODE", "");

    const response = await POST(request("anything"));

    expect(response.status).toBe(503);
  });
});
