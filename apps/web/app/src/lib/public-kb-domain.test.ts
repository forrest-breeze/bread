import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockFrom, mockPortalRouteEq, mockLegacyMaybeSingle } = vi.hoisted(() => {
  const mockPortalRouteEq = vi.fn()
  const mockLegacyMaybeSingle = vi.fn()
  const mockFrom = vi.fn((table: string) => {
    if (table === "portal_domain_routes") {
      return {
        select: vi.fn(() => ({ eq: mockPortalRouteEq })),
      }
    }
    return {
      select: vi.fn(() => ({
        contains: vi.fn(() => ({
          limit: vi.fn(() => ({ maybeSingle: mockLegacyMaybeSingle })),
        })),
      })),
    }
  })
  return { mockFrom, mockPortalRouteEq, mockLegacyMaybeSingle }
})

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: mockFrom })),
}))

import {
  customDomainCanonicalPath,
  customDomainRewritePath,
  matchCustomDomainRoute,
  resolveCustomDomainProjectRoute,
  resolveCustomDomainRoute,
  type ResolvedCustomDomainRoute,
} from "./public-kb-domain"

const rootRoute: ResolvedCustomDomainRoute = {
  workspaceSlug: "acme",
  projectSlug: "docs",
  pathPrefix: "/",
}

const docsRoute: ResolvedCustomDomainRoute = {
  workspaceSlug: "acme",
  projectSlug: "docs",
  pathPrefix: "/docs",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
  mockPortalRouteEq.mockResolvedValue({ data: [], error: null })
  mockLegacyMaybeSingle.mockResolvedValue({ data: null, error: null })
})

afterEach(() => vi.unstubAllEnvs())

describe("matchCustomDomainRoute", () => {
  it("matches a project mounted at a dedicated domain root", () => {
    expect(matchCustomDomainRoute([rootRoute], "/doc/install")).toBe(rootRoute)
  })

  it("requires a path-prefix segment boundary", () => {
    expect(matchCustomDomainRoute([docsRoute], "/docs/doc/install")).toBe(
      docsRoute,
    )
    expect(matchCustomDomainRoute([docsRoute], "/docs-old")).toBeNull()
  })

  it("chooses the longest matching path prefix", () => {
    const apiRoute: ResolvedCustomDomainRoute = {
      workspaceSlug: "acme",
      projectSlug: "api-docs",
      pathPrefix: "/docs/api",
    }
    expect(
      matchCustomDomainRoute(
        [rootRoute, docsRoute, apiRoute],
        "/docs/api/authentication",
      ),
    ).toBe(apiRoute)
  })
})

describe("customDomainRewritePath", () => {
  it("rewrites a dedicated domain without adding its external host", () => {
    expect(customDomainRewritePath(rootRoute, "/doc/install")).toBe(
      "/p/acme/docs/doc/install",
    )
  })

  it("strips the external path mount before rewriting", () => {
    expect(customDomainRewritePath(docsRoute, "/docs")).toBe("/p/acme/docs")
    expect(customDomainRewritePath(docsRoute, "/docs/doc/install")).toBe(
      "/p/acme/docs/doc/install",
    )
  })

  it("uses the workspace root for a default project slug", () => {
    expect(
      customDomainRewritePath(
        { workspaceSlug: "acme", projectSlug: "acme", pathPrefix: "/docs" },
        "/docs/doc/install",
      ),
    ).toBe("/p/acme/doc/install")
  })

  it("does not rewrite a path outside the configured mount", () => {
    expect(customDomainRewritePath(docsRoute, "/help")).toBeNull()
  })

  it("leaves legacy workspace-wide routing to the proxy fallback", () => {
    expect(
      customDomainRewritePath(
        { workspaceSlug: "acme", projectSlug: null, pathPrefix: "/" },
        "/docs",
      ),
    ).toBeNull()
  })
})

describe("customDomainCanonicalPath", () => {
  it("canonicalizes internal links to a shared-domain mount", () => {
    expect(
      customDomainCanonicalPath(docsRoute, "/p/acme/docs/doc/install"),
    ).toBe("/docs/doc/install")
  })

  it("canonicalizes a dedicated project domain to its root", () => {
    expect(customDomainCanonicalPath(rootRoute, "/p/acme/docs")).toBe("/")
    expect(
      customDomainCanonicalPath(rootRoute, "/p/acme/docs/folder/start"),
    ).toBe("/folder/start")
  })

  it("canonicalizes a default project from the workspace root", () => {
    expect(
      customDomainCanonicalPath(
        { workspaceSlug: "acme", projectSlug: "acme", pathPrefix: "/docs" },
        "/p/acme/doc/install",
      ),
    ).toBe("/docs/doc/install")
  })

  it("rejects an internal URL belonging to another project", () => {
    expect(
      customDomainCanonicalPath(docsRoute, "/p/acme/help/doc/install"),
    ).toBeNull()
  })
})

describe("custom-domain route resolution", () => {
  it("resolves a structured shared-domain project route", async () => {
    mockPortalRouteEq.mockResolvedValue({
      data: [
        {
          project_slug: "docs",
          path_prefix: "/docs",
          workspace: { slug: "acme" },
        },
      ],
      error: null,
    })

    await expect(
      resolveCustomDomainRoute("customer-one.com:443", "/docs/doc/install"),
    ).resolves.toEqual({
      workspaceSlug: "acme",
      projectSlug: "docs",
      pathPrefix: "/docs",
    })
    expect(mockPortalRouteEq).toHaveBeenCalledWith("domain", "customer-one.com")
    expect(mockLegacyMaybeSingle).not.toHaveBeenCalled()
  })

  it("does not fall back to the legacy workspace route when a host has non-matching structured routes", async () => {
    mockPortalRouteEq.mockResolvedValue({
      data: [
        {
          project_slug: "docs",
          path_prefix: "/docs",
          workspace: { slug: "acme" },
        },
      ],
      error: null,
    })

    await expect(
      resolveCustomDomainRoute("customer-two.com", "/marketing"),
    ).resolves.toBeNull()
    expect(mockLegacyMaybeSingle).not.toHaveBeenCalled()
  })

  it("keeps the existing workspace custom-domain behavior as a fallback", async () => {
    mockLegacyMaybeSingle.mockResolvedValue({
      data: {
        slug: "legacy-acme",
        settings: { kb_public: true, kb_custom_domain: "legacy-customer.com" },
      },
      error: null,
    })

    await expect(
      resolveCustomDomainRoute("legacy-customer.com", "/help"),
    ).resolves.toEqual({
      workspaceSlug: "legacy-acme",
      projectSlug: null,
      pathPrefix: "/",
    })
  })

  it("finds the configured clean mount for an internal project URL", async () => {
    mockPortalRouteEq.mockResolvedValue({
      data: [
        {
          project_slug: "help",
          path_prefix: "/help",
          workspace: { slug: "acme" },
        },
      ],
      error: null,
    })

    await expect(
      resolveCustomDomainProjectRoute("customer-three.com", "acme", "help"),
    ).resolves.toEqual({
      workspaceSlug: "acme",
      projectSlug: "help",
      pathPrefix: "/help",
    })
  })

  it("matches a default project route when the internal URL omits its duplicate slug", async () => {
    mockPortalRouteEq.mockResolvedValue({
      data: [
        {
          project_slug: "acme",
          path_prefix: "/docs",
          workspace: { slug: "acme" },
        },
      ],
      error: null,
    })

    await expect(
      resolveCustomDomainProjectRoute(
        "customer-default.com",
        "acme",
        null,
      ),
    ).resolves.toEqual({
      workspaceSlug: "acme",
      projectSlug: "acme",
      pathPrefix: "/docs",
    })
  })
})
