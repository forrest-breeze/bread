import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AuthError } from "@supabase/supabase-js";

const { getClaims } = vi.hoisted(() => ({ getClaims: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims } }) }));
vi.mock("@/lib/portal/login-next", () => ({ sanitizePostLoginNext: async () => "/dashboard" }));
import { updateSession } from "./proxy";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-key");
  getClaims.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
function request(path = "/dashboard", cookie = true) {
  return new NextRequest(`https://app.example.com${path}`, { headers: cookie ? { cookie: "sb-example-auth-token=session" } : {} });
}
describe("session middleware during outages", () => {
  it.each([409, 429, 503])("returns 503 without clearing cookies or redirecting for auth %s", async (status) => {
    getClaims.mockResolvedValue({ data: null, error: new AuthError("unavailable", status) });
    const response = await updateSession(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("2");
  });
  it("fails closed on timeout without redirecting to login", async () => {
    vi.useFakeTimers();
    getClaims.mockImplementation(() => new Promise(() => {}));
    const pending = updateSession(request());
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).status).toBe(503);
    expect(getClaims).toHaveBeenCalledTimes(1);
  });
  it("still redirects a definitively invalid session", async () => {
    getClaims.mockResolvedValue({ data: null, error: new AuthError("invalid", 401) });
    expect((await updateSession(request())).headers.get("location")).toContain("/login");
  });
  it("does not block the login page on an auth outage", async () => {
    getClaims.mockResolvedValue({ data: null, error: new AuthError("unavailable", 503) });
    expect((await updateSession(request("/login"))).status).toBe(200);
  });
  it("fails closed for portals on an auth outage (they are Breeze-only now)", async () => {
    getClaims.mockResolvedValue({ data: null, error: new AuthError("unavailable", 503) });
    expect((await updateSession(request("/p/docs"))).status).toBe(503);
  });
  it("sends signed-out visitors away from portals and 401s signed-out API calls", async () => {
    expect((await updateSession(request("/p/docs", false))).status).toBe(307);
    expect((await updateSession(request("/api/public/search", false))).status).toBe(401);
    expect((await updateSession(request("/api/documents", false))).status).toBe(401);
  });
  it("lets machine endpoints through to their own secret/signature checks", async () => {
    for (const path of ["/api/cron/ingest-all", "/api/github/webhook", "/api/v1/search"]) {
      expect((await updateSession(request(path, false))).status).toBe(200);
    }
  });
  it("skips auth for anonymous requests and protects private routes", async () => {
    expect((await updateSession(request("/dashboard", false))).status).toBe(307);
    expect(getClaims).not.toHaveBeenCalled();
  });
});
