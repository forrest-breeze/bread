import { afterEach, describe, expect, it, vi } from "vitest";
import { probePortalUrl } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probePortalUrl", () => {
  it("does not treat a redirect to the Bread URL as connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://app.example.com/p/acme/docs" },
        })),
    );

    const result = await probePortalUrl({
      host: "acme.com",
      pathname: "/docs",
      workspaceSlug: "acme",
      requireReverseProxy: true,
    });

    expect(result.connected).toBe(false);
    expect(result.reason).toMatch(/redirecting away/i);
  });

  it("accepts a mounted path with workspace and proxy markers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("ok", {
          headers: {
            "x-bread-portal": "acme",
            "x-bread-proxy": "cloudflare-worker-v1",
          },
        })),
    );

    await expect(
      probePortalUrl({
        host: "acme.com",
        pathname: "/docs",
        workspaceSlug: "acme",
        requireReverseProxy: true,
      }),
    ).resolves.toEqual({ connected: true, host: "acme.com", reason: null });
  });

  it("accepts a managed Cloudflare route when the hosting layer drops the workspace marker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("ok", {
          headers: { "x-bread-proxy": "cloudflare-worker-v1" },
        })),
    );

    await expect(
      probePortalUrl({
        host: "acme.com",
        pathname: "/docs",
        workspaceSlug: "acme",
        requireReverseProxy: true,
        managedCloudflareRoute: true,
      }),
    ).resolves.toEqual({ connected: true, host: "acme.com", reason: null });
  });

  it("does not trust an unmanaged Worker marker without a workspace marker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("ok", {
          headers: { "x-bread-proxy": "cloudflare-worker-v1" },
        })),
    );

    const result = await probePortalUrl({
      host: "acme.com",
      pathname: "/docs",
      workspaceSlug: "acme",
      requireReverseProxy: true,
    });

    expect(result.connected).toBe(false);
    expect(result.reason).toMatch(/not serving this portal/i);
  });

  it("rejects a conflicting workspace marker on a managed Cloudflare route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("ok", {
          headers: {
            "x-bread-portal": "other-workspace",
            "x-bread-proxy": "cloudflare-worker-v1",
          },
        })),
    );

    const result = await probePortalUrl({
      host: "acme.com",
      pathname: "/docs",
      workspaceSlug: "acme",
      requireReverseProxy: true,
      managedCloudflareRoute: true,
    });

    expect(result.connected).toBe(false);
    expect(result.reason).toMatch(/different workspace/i);
  });

  it("rejects an origin response when the Worker route is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("origin")));

    const result = await probePortalUrl({
      host: "acme.com",
      pathname: "/docs",
      workspaceSlug: "acme",
      requireReverseProxy: true,
    });

    expect(result.connected).toBe(false);
    expect(result.reason).toMatch(/reverse-proxy route is not active/i);
  });
});
