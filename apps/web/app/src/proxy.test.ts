import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

// ---------------------------------------------------------------------------
// Proxy (Next middleware) public-KB subdomain routing.
//
// Focus: with the base domain set to the bare apex "example.com" (a sibling of
// the app host app.example.com), the app host and reserved labels must NEVER be
// rewritten to a portal, and a valid handle must rewrite to /p/<slug>.
//
// proxy.ts reads NEXT_PUBLIC_* at module load, so each scenario stubs env and
// dynamically imports a fresh module instance.
// ---------------------------------------------------------------------------

const {
  mockUpdateSession,
  mockResolveSubdomainSlug,
  mockResolveCustomDomainRoute,
  mockResolveCustomDomainProjectRoute,
} =
  vi.hoisted(() => ({
    mockUpdateSession: vi.fn(),
    mockResolveSubdomainSlug: vi.fn(),
    mockResolveCustomDomainRoute: vi.fn(),
    mockResolveCustomDomainProjectRoute: vi.fn(),
  }))

vi.mock("@/lib/supabase/proxy", () => ({ updateSession: mockUpdateSession }))
vi.mock("@/lib/public-kb-domain", () => ({
  resolveSubdomainSlug: mockResolveSubdomainSlug,
  resolveCustomDomainRoute: mockResolveCustomDomainRoute,
  resolveCustomDomainProjectRoute: mockResolveCustomDomainProjectRoute,
  customDomainRewritePath: (
    route: {
      workspaceSlug: string
      projectSlug: string | null
      pathPrefix: string
    },
    pathname: string,
  ) => {
    if (!route.projectSlug) return null
    const remainder =
      route.pathPrefix === "/"
        ? pathname
        : pathname.slice(route.pathPrefix.length)
    const suffix = !remainder || remainder === "/" ? "" : remainder
    return `/p/${route.workspaceSlug}/${route.projectSlug}${suffix}`
  },
  customDomainCanonicalPath: (
    route: {
      workspaceSlug: string
      projectSlug: string | null
      pathPrefix: string
    },
    pathname: string,
  ) => {
    const internalBase = `/p/${route.workspaceSlug}${
      route.projectSlug ? `/${route.projectSlug}` : ""
    }`
    const remainder = pathname.slice(internalBase.length)
    return route.pathPrefix === "/"
      ? remainder || "/"
      : `${route.pathPrefix}${remainder}`
  },
}))

const SESSION_MARKER = "x-test-session"

function makeReq(
  host: string,
  path = "/",
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`https://${host}${path}`, {
    headers: { host, ...headers },
  })
}

async function loadProxy(): Promise<(req: NextRequest) => Promise<Response>> {
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN", "example.com")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com")
  const mod = await import("./proxy")
  return mod.default as (req: NextRequest) => Promise<Response>
}

function rewriteTarget(res: Response): string | null {
  return res.headers.get("x-middleware-rewrite")
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: a signed-in Breeze user, so the gate passes (plain "next").
  mockUpdateSession.mockImplementation(() => {
    const res = NextResponse.next()
    res.headers.set(SESSION_MARKER, "1")
    return res
  })
  mockResolveCustomDomainRoute.mockResolvedValue(null)
  mockResolveCustomDomainProjectRoute.mockResolvedValue(null)
  mockResolveSubdomainSlug.mockResolvedValue(null)
})

afterEach(() => vi.unstubAllEnvs())

describe("proxy — public-KB subdomain routing on an apex base", () => {
  it("rewrites a valid handle to its workspace's /p/<slug>", async () => {
    mockResolveSubdomainSlug.mockResolvedValue("acme-k3n8")
    const proxy = await loadProxy()

    const res = await proxy(makeReq("acme.example.com", "/"))

    expect(mockResolveSubdomainSlug).toHaveBeenCalledWith("acme")
    expect(rewriteTarget(res)).toContain("/p/acme-k3n8")
    expect(
      res.headers.get("x-middleware-request-x-bread-portal-mount-path"),
    ).toBe("/")
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("preserves the sub-path when rewriting a handle deep link", async () => {
    mockResolveSubdomainSlug.mockResolvedValue("acme-k3n8")
    const proxy = await loadProxy()

    // A non-/p deep path on the subdomain still maps under the workspace.
    const res = await proxy(makeReq("acme.example.com", "/search"))
    expect(rewriteTarget(res)).toContain("/p/acme-k3n8/search")
  })

  it("NEVER rewrites the app host (app.example.com) — no handle lookup at all", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("app.example.com", "/dashboard"))

    expect(mockResolveSubdomainSlug).not.toHaveBeenCalled()
    expect(rewriteTarget(res)).toBeNull()
    expect(res.headers.get(SESSION_MARKER)).toBe("1") // fell through to app
  })

  it.each(["www", "api", "mail", "admin", "docs"])(
    "never rewrites the reserved label %s.example.com",
    async (label) => {
      const proxy = await loadProxy()

      const res = await proxy(makeReq(`${label}.example.com`, "/"))

      expect(mockResolveSubdomainSlug).not.toHaveBeenCalled()
      expect(rewriteTarget(res)).toBeNull()
      expect(res.headers.get(SESSION_MARKER)).toBe("1")
    },
  )

  it("falls through to the app for an unknown/unpublished handle", async () => {
    mockResolveSubdomainSlug.mockResolvedValue(null)
    const proxy = await loadProxy()

    const res = await proxy(makeReq("nope.example.com", "/"))

    expect(mockResolveSubdomainSlug).toHaveBeenCalledWith("nope")
    expect(rewriteTarget(res)).toBeNull()
    expect(res.headers.get(SESSION_MARKER)).toBe("1")
  })

  it("does not touch the apex itself", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("example.com", "/"))

    expect(mockResolveSubdomainSlug).not.toHaveBeenCalled()
    expect(rewriteTarget(res)).toBeNull()
  })

  it("leaves already-internal /p paths on the subdomain untouched", async () => {
    const proxy = await loadProxy()

    // The portal renders /p/<slug>/... links; these must serve directly.
    const res = await proxy(makeReq("acme.example.com", "/p/acme-k3n8/doc/1"))

    expect(mockResolveSubdomainSlug).not.toHaveBeenCalled()
    expect(rewriteTarget(res)).toBeNull()
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("authenticates direct app-host portal routes before serving them", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("app.example.com", "/p/acme-k3n8"))

    expect(rewriteTarget(res)).toBeNull()
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("authenticates PostHog ingest routes too", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("app.example.com", "/ingest/s"))

    expect(rewriteTarget(res)).toBeNull()
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })
})

describe("proxy — project-level custom-domain routing", () => {
  it("resolves a customer path forwarded by the Cloudflare Worker", async () => {
    mockResolveCustomDomainRoute.mockResolvedValue({
      workspaceSlug: "acme",
      projectSlug: "blog",
      pathPrefix: "/blog",
    })
    const proxy = await loadProxy()

    const res = await proxy(
      makeReq("app.example.com", "/blog/doc/launch", {
        "x-forwarded-host": "customer.com",
        "x-bread-base-path": "/blog",
        "x-bread-proxy": "cloudflare-worker-v1",
      }),
    )

    expect(mockResolveCustomDomainRoute).toHaveBeenCalledWith(
      "customer.com",
      "/blog/doc/launch",
    )
    expect(rewriteTarget(res)).toContain("/p/acme/blog/doc/launch")
    expect(res.headers.get("x-middleware-request-x-bread-base-path")).toBe(
      "/blog",
    )
  })

  it("stamps the portal marker on direct /p requests forwarded by the Worker", async () => {
    // The Worker template addresses /p/<ws>/<project> directly (skipping the
    // public-mount redirect hop), so the connection-verify marker must be
    // stamped from the requested path — and the request must be SERVED, never
    // canonicalized back to the clean path (that turns every proxied portal
    // page into a circular redirect through the Worker).
    mockResolveCustomDomainProjectRoute.mockResolvedValue({
      workspaceSlug: "acme",
      projectSlug: "blog",
      pathPrefix: "/blog",
    })
    const proxy = await loadProxy()

    const res = await proxy(
      makeReq("app.example.com", "/p/acme/blog/doc/launch", {
        "x-forwarded-host": "customer.com",
        "x-bread-base-path": "/blog",
        "x-bread-proxy": "cloudflare-worker-v1",
      }),
    )

    expect(res.status).not.toBe(307)
    expect(res.headers.get("x-bread-portal")).toBe("acme")
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("does not stamp the portal marker on direct /p requests without proxy metadata", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("app.example.com", "/p/acme/blog"))

    expect(res.headers.get("x-bread-portal")).toBeNull()
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("stamps the portal marker when the hosting layer rewrites the forwarded host", async () => {
    const proxy = await loadProxy()

    const res = await proxy(
      makeReq("internal-host.netlify.app", "/p/acme/blog", {
        "x-forwarded-host": "app.example.com",
        "x-bread-base-path": "/blog",
        "x-bread-proxy": "cloudflare-worker-v1",
      }),
    )

    expect(res.headers.get("x-bread-portal")).toBe("acme")
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("keeps public portal APIs inside the forwarded mount path", async () => {
    mockResolveCustomDomainRoute.mockResolvedValue({
      workspaceSlug: "acme",
      projectSlug: "blog",
      pathPrefix: "/blog",
    })
    const proxy = await loadProxy()

    const searchResponse = await proxy(
      makeReq("app.example.com", "/blog/_bread/api/search?q=hello", {
        "x-forwarded-host": "customer.com",
        "x-bread-proxy": "reverse-proxy-v1",
      }),
    )
    const translateResponse = await proxy(
      makeReq("app.example.com", "/blog/_bread/api/translate", {
        "x-forwarded-host": "customer.com",
        "x-bread-proxy": "reverse-proxy-v1",
      }),
    )

    expect(rewriteTarget(searchResponse)).toContain("/api/public/search?q=hello")
    expect(rewriteTarget(translateResponse)).toContain("/api/public/translate")
    expect(mockUpdateSession).toHaveBeenCalledTimes(2)
  })

  it("mounts a project at the root of a dedicated custom domain", async () => {
    mockResolveCustomDomainRoute.mockResolvedValue({
      workspaceSlug: "acme",
      projectSlug: "docs",
      pathPrefix: "/",
    })
    const proxy = await loadProxy()

    const res = await proxy(makeReq("docs.customer.com", "/doc/install"))

    expect(mockResolveCustomDomainRoute).toHaveBeenCalledWith(
      "docs.customer.com",
      "/doc/install",
    )
    expect(rewriteTarget(res)).toContain("/p/acme/docs/doc/install")
    expect(res.headers.get("x-bread-portal")).toBe("acme")
    expect(res.headers.get("x-bread-portal-mount-path")).toBe("/")
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("strips a shared-domain path prefix before mounting the project", async () => {
    mockResolveCustomDomainRoute.mockResolvedValue({
      workspaceSlug: "acme",
      projectSlug: "help",
      pathPrefix: "/help",
    })
    const proxy = await loadProxy()

    const res = await proxy(makeReq("customer.com", "/help/doc/billing"))

    expect(rewriteTarget(res)).toContain("/p/acme/help/doc/billing")
    expect(res.headers.get("x-bread-portal-mount-path")).toBe("/help")
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("redirects internal portal links back to a shared-domain clean path", async () => {
    mockResolveCustomDomainProjectRoute.mockResolvedValue({
      workspaceSlug: "acme",
      projectSlug: "docs",
      pathPrefix: "/docs",
    })
    const proxy = await loadProxy()

    const res = await proxy(
      makeReq("customer.com", "/p/acme/docs/doc/install?q=search"),
    )

    expect(mockResolveCustomDomainProjectRoute).toHaveBeenCalledWith(
      "customer.com",
      "acme",
      "docs",
    )
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe(
      "https://customer.com/docs/doc/install?q=search",
    )
  })

  it("redirects internal portal links to a dedicated domain root", async () => {
    mockResolveCustomDomainProjectRoute.mockResolvedValue({
      workspaceSlug: "acme",
      projectSlug: "docs",
      pathPrefix: "/",
    })
    const proxy = await loadProxy()

    const res = await proxy(makeReq("docs.customer.com", "/p/acme/docs"))

    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("https://docs.customer.com/")
  })

  it("keeps app.example.com reserved for the product app", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("app.example.com", "/docs"))

    expect(mockResolveCustomDomainRoute).not.toHaveBeenCalled()
    expect(rewriteTarget(res)).toBeNull()
    expect(res.headers.get(SESSION_MARKER)).toBe("1")
  })
})

describe("proxy — portal llms.txt files", () => {
  // Each mount shape must reach the text route with the resolved portal base;
  // a page route can't answer text/plain, so a missed mapping renders (or 404s)
  // as HTML instead.
  it("maps a subdomain portal's /llms.txt to the text route with a root mount", async () => {
    mockResolveSubdomainSlug.mockResolvedValue("acme-k3n8")
    const proxy = await loadProxy()

    const res = await proxy(makeReq("acme.example.com", "/llms.txt"))

    const target = rewriteTarget(res)
    expect(target).toContain("/api/public/llms")
    expect(target).toContain("portal=acme-k3n8")
    // The portal owns the whole host, so links must not be built from /p/<slug>.
    expect(
      res.headers.get("x-middleware-request-x-bread-portal-mount-path"),
    ).toBe("/")
  })

  it("maps llms-full.txt to the full variant", async () => {
    mockResolveSubdomainSlug.mockResolvedValue("acme-k3n8")
    const proxy = await loadProxy()

    const res = await proxy(makeReq("acme.example.com", "/llms-full.txt"))

    expect(rewriteTarget(res)).toContain("variant=full")
  })

  it("maps a path-mounted custom domain's llms.txt and keeps the mount header", async () => {
    mockResolveCustomDomainRoute.mockResolvedValue({
      workspaceSlug: "acme",
      projectSlug: "help",
      pathPrefix: "/help",
    })
    const proxy = await loadProxy()

    const res = await proxy(makeReq("customer.com", "/help/llms.txt"))

    const target = rewriteTarget(res)
    expect(target).toContain("/api/public/llms")
    expect(target).toContain("portal=acme%2Fhelp")
    expect(res.headers.get("x-bread-portal-mount-path")).toBe("/help")
  })

  it("maps a Worker-forwarded /p/... llms.txt, preserving its base path header", async () => {
    const proxy = await loadProxy()

    const res = await proxy(
      makeReq("app.example.com", "/p/acme/help/llms.txt", {
        "x-forwarded-host": "customer.com",
        "x-bread-base-path": "/help",
        "x-bread-proxy": "cloudflare-worker-v1",
      }),
    )

    expect(rewriteTarget(res)).toContain("portal=acme%2Fhelp")
    expect(res.headers.get("x-middleware-request-x-bread-base-path")).toBe(
      "/help",
    )
  })

  it("serves the internal /p/<ws>/llms.txt address directly", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("app.example.com", "/p/acme/llms.txt"))

    expect(rewriteTarget(res)).toContain("portal=acme")
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("leaves a document whose slug ends in llms.txt as a document", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("app.example.com", "/p/acme/doc/llms.txt"))

    expect(rewriteTarget(res)).toBeNull()
    expect(mockUpdateSession).toHaveBeenCalledTimes(1)
  })

  it("does not hijack /llms.txt on the app host", async () => {
    const proxy = await loadProxy()

    const res = await proxy(makeReq("app.example.com", "/llms.txt"))

    expect(rewriteTarget(res)).toBeNull()
    expect(res.headers.get(SESSION_MARKER)).toBe("1")
  })
})


describe("proxy — Breeze-only gate runs before any portal routing", () => {
  function signedOut(): void {
    mockUpdateSession.mockImplementation(
      () => NextResponse.redirect("https://app.example.com/login"),
    )
  }

  it("turns away a signed-out visitor on a portal subdomain without resolving it", async () => {
    signedOut()
    mockResolveSubdomainSlug.mockResolvedValue("acme-k3n8")
    const proxy = await loadProxy()
    const res = await proxy(makeReq("acme.example.com", "/"))
    expect(res.headers.get("location")).toBe("https://app.example.com/login")
    expect(rewriteTarget(res)).toBeNull()
    expect(mockResolveSubdomainSlug).not.toHaveBeenCalled()
  })

  it("turns away a signed-out visitor on a custom domain without resolving it", async () => {
    signedOut()
    const proxy = await loadProxy()
    const res = await proxy(makeReq("docs.customer.com", "/guide"))
    expect(res.headers.get("location")).toBe("https://app.example.com/login")
    expect(mockResolveCustomDomainProjectRoute).not.toHaveBeenCalled()
    expect(mockResolveCustomDomainRoute).not.toHaveBeenCalled()
  })

  it("turns away a signed-out visitor on /p and on llms.txt", async () => {
    signedOut()
    const proxy = await loadProxy()
    for (const path of ["/p/acme/docs", "/p/acme/llms.txt", "/p/acme/x.png"]) {
      const res = await proxy(makeReq("app.example.com", path))
      expect(res.headers.get("location")).toBe("https://app.example.com/login")
      expect(rewriteTarget(res)).toBeNull()
    }
  })

  it("returns the gate's 401 for a signed-out API call", async () => {
    mockUpdateSession.mockImplementation(
      () => NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    )
    const proxy = await loadProxy()
    const res = await proxy(makeReq("app.example.com", "/api/public/search?q=x"))
    expect(res.status).toBe(401)
  })
})

describe("proxy matcher", () => {
  it("runs on image-like URLs too, so a .png suffix cannot skip auth", async () => {
    const { config } = await import("./proxy")
    const pattern = new RegExp(`^${config.matcher[0]}$`)
    expect(pattern.test("/p/acme/docs/x.png")).toBe(true)
    expect(pattern.test("/api/public/media/abc.svg")).toBe(true)
    expect(pattern.test("/_next/static/chunk.js")).toBe(false)
    expect(pattern.test("/breeze-mark.svg")).toBe(false)
  })
})
