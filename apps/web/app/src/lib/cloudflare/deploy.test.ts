import { describe, expect, it } from "vitest";
import {
  buildProjectPortalRoutes,
  buildWorkspacePortalRoutes,
  cloudflareScriptName,
} from "./deploy";

describe("Cloudflare portal route generation", () => {
  it("mounts every workspace project and handles the root project path", () => {
    expect(buildWorkspacePortalRoutes("acme", ["docs", "help", "acme"])).toEqual({
      "/acme": "/p/acme",
      "/docs": "/p/acme/docs",
      "/help": "/p/acme/help",
    });
  });

  it("bundles every project-specific path saved on the same domain", () => {
    expect(
      buildProjectPortalRoutes("acme", [
        { projectSlug: "docs", pathPrefix: "/manuals" },
        { projectSlug: "help", pathPrefix: "/support" },
      ]),
    ).toEqual({
      "/manuals": "/p/acme/docs",
      "/support": "/p/acme/help",
    });
  });

  it("generates a stable Worker name without exposing workspace or domain", () => {
    const name = cloudflareScriptName(
      "060ae386-b752-4683-ac46-94c30c616a91",
      "customer.com",
    );
    expect(name).toMatch(/^bread-portal-[a-f0-9]{20}$/);
    expect(name).toBe(
      cloudflareScriptName("060ae386-b752-4683-ac46-94c30c616a91", "customer.com"),
    );
  });
});

