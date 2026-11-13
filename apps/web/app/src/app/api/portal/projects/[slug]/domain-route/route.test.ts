import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockRequireRouteUser,
  mockGetActiveWorkspace,
  mockListPortalProjects,
  mockMaybeSingleRoute,
  mockUpsert,
  mockDeleteResult,
} = vi.hoisted(() => ({
  mockRequireRouteUser: vi.fn(),
  mockGetActiveWorkspace: vi.fn(),
  mockListPortalProjects: vi.fn(),
  mockMaybeSingleRoute: vi.fn(),
  mockUpsert: vi.fn(),
  mockDeleteResult: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: mockMaybeSingleRoute })),
        })),
      })),
      upsert: mockUpsert,
      delete: vi.fn(() => ({
        eq: vi.fn(() => ({ eq: mockDeleteResult })),
      })),
    })),
  })),
}))

vi.mock("@/lib/auth/route-auth", () => ({
  requireRouteUser: mockRequireRouteUser,
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: mockGetActiveWorkspace,
}))

vi.mock("@/lib/portal/experiences-write", () => ({
  listPortalProjects: mockListPortalProjects,
}))

import { DELETE, GET, PUT } from "./route"

const context = { params: Promise.resolve({ slug: "docs" }) }

function putRequest(body: unknown): Request {
  return new Request(
    "https://app.example.com/api/portal/projects/docs/domain-route",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRouteUser.mockResolvedValue({
    user: { id: "user-1" },
    response: new Response(null, { status: 401 }),
  })
  mockGetActiveWorkspace.mockResolvedValue({
    workspace_id: "ws-1",
    role: "owner",
  })
  mockListPortalProjects.mockResolvedValue([{ slug: "docs" }])
  mockMaybeSingleRoute.mockResolvedValue({ data: null, error: null })
  mockUpsert.mockResolvedValue({ error: null })
  mockDeleteResult.mockResolvedValue({ error: null })
})

afterEach(() => vi.unstubAllEnvs())

describe("project domain route API", () => {
  it("returns 401 when unauthenticated", async () => {
    mockRequireRouteUser.mockResolvedValue({
      user: null,
      response: new Response(null, { status: 401 }),
    })

    const response = await GET(new Request("https://app.example.com"), context)

    expect(response.status).toBe(401)
    expect(mockListPortalProjects).not.toHaveBeenCalled()
  })

  it("returns 403 for non-admin workspace members", async () => {
    mockGetActiveWorkspace.mockResolvedValue({
      workspace_id: "ws-1",
      role: "editor",
    })

    const response = await GET(new Request("https://app.example.com"), context)

    expect(response.status).toBe(403)
  })

  it("returns the configured project route", async () => {
    mockMaybeSingleRoute.mockResolvedValue({
      data: { domain: "acme.com", path_prefix: "/docs" },
      error: null,
    })

    const response = await GET(new Request("https://app.example.com"), context)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      route: {
        projectSlug: "docs",
        domain: "acme.com",
        pathPrefix: "/docs",
        mode: "path",
      },
    })
  })

  it("saves a dedicated project domain", async () => {
    const response = await PUT(
      putRequest({ domain: "DOCS.Acme.com", mode: "domain" }),
      context,
    )

    expect(response.status).toBe(200)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws-1",
        project_slug: "docs",
        domain: "docs.acme.com",
        path_prefix: "/",
      }),
      { onConflict: "workspace_id,project_slug" },
    )
  })

  it("saves a shared-domain route at the project path", async () => {
    const response = await PUT(
      putRequest({ domain: "acme.com", mode: "path" }),
      context,
    )

    expect(response.status).toBe(200)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "acme.com",
        path_prefix: "/docs",
      }),
      { onConflict: "workspace_id,project_slug" },
    )
  })

  it("allows Breezify's apex only for a path-mounted route", async () => {
    vi.stubEnv("NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN", "example.com")

    const pathResponse = await PUT(
      putRequest({ domain: "example.com", mode: "path" }),
      context,
    )
    const domainResponse = await PUT(
      putRequest({ domain: "example.com", mode: "domain" }),
      context,
    )

    expect(pathResponse.status).toBe(200)
    expect(domainResponse.status).toBe(400)
  })

  it("returns 409 when another project owns the domain path", async () => {
    mockUpsert.mockResolvedValue({ error: { code: "23505" } })

    const response = await PUT(
      putRequest({ domain: "acme.com", mode: "path" }),
      context,
    )

    expect(response.status).toBe(409)
  })

  it("removes the project-specific route", async () => {
    const response = await DELETE(
      new Request("https://app.example.com", { method: "DELETE" }),
      context,
    )

    expect(response.status).toBe(200)
    expect(mockDeleteResult).toHaveBeenCalledWith("project_slug", "docs")
    await expect(response.json()).resolves.toEqual({ route: null })
  })
})
