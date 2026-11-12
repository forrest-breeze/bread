import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCloudflareAuthorizeUrl,
  loadCloudflareOAuthConfig,
  tokenScopes,
} from "./oauth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Cloudflare OAuth configuration", () => {
  it("builds the registered production callback and optional scope subset", () => {
    vi.stubEnv("CLOUDFLARE_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("CLOUDFLARE_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com/");
    vi.stubEnv(
      "CLOUDFLARE_OAUTH_SCOPES",
      "zone.read, workers_scripts.write workers_routes.write",
    );
    const config = loadCloudflareOAuthConfig();
    expect(config?.redirectUri).toBe(
      "https://app.example.com/api/cloudflare/oauth/callback",
    );
    const url = new URL(buildCloudflareAuthorizeUrl(config!, "state-value"));
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("scope")).toBe(
      "zone.read workers_scripts.write workers_routes.write",
    );
  });

  it("accepts either string or array token scopes", () => {
    expect(tokenScopes({ access_token: "a", scope: "one two" })).toEqual([
      "one",
      "two",
    ]);
    expect(tokenScopes({ access_token: "a", scope: ["one", "two"] })).toEqual([
      "one",
      "two",
    ]);
  });
});

