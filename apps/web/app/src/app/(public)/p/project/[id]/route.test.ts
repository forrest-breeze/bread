import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { NextRequest } from "next/server"

const {
  mockMaybeSingleProject,
  mockMaybeSingleWorkspace,
  mockMaybeSinglePortalRoute,
  mockFrom,
} = vi.hoisted(() => {
  const mockMaybeSingleProject = vi.fn()
  const mockMaybeSingleWorkspace = vi.fn()
  const mockMaybeSinglePortalRoute = vi.fn()
  const mockFrom = vi.fn((table: string) => {
    const terminal =
      table === "workspace_experiences"
        ? mockMaybeSingleProject
        : table === "portal_domain_routes"
          ? mockMaybeSinglePortalRoute
          : mockMaybeSingleWorkspace
    return {
      select: vi.fn(() => ({
        eq: vi.fn((col: string, val: any) => ({
          eq: vi.fn((col2: string, val2: any) => ({
            eq: vi.fn((col3: string, val3: any) => ({
              maybeSingle: terminal,
            })),
            maybeSingle: terminal,
          })),
          maybeSingle: terminal,
        })),
      })),
    }
  })
  return {
    mockMaybeSingleProject,
    mockMaybeSingleWorkspace,
    mockMaybeSinglePortalRoute,
    mockFrom,
  }
})

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: mockFrom,
  })),
}))

import { GET } from "./route"

function makeRequest(url: string): NextRequest {
  return new NextRequest(url)
}

describe("GET /p/project/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The redirect origin comes from NEXT_PUBLIC_APP_URL; set it explicitly
    // instead of relying on whatever another test file left in process.env.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com")
    mockMaybeSinglePortalRoute.mockResolvedValue({ data: null, error: null })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns 400 for an invalid UUID format", async () => {
    const req = makeRequest("https://app.example.com/p/project/invalid-uuid")
    const params = Promise.resolve({ id: "invalid-uuid" })
    const res = await GET(req, { params })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("Invalid project ID format")
  })

  it("returns 404 if project is not found", async () => {
    mockMaybeSingleProject.mockResolvedValue({ data: null, error: null })
    const req = makeRequest("https://app.example.com/p/project/a992906c-d30d-498b-8c3a-1fd22e0bd397")
    const params = Promise.resolve({ id: "a992906c-d30d-498b-8c3a-1fd22e0bd397" })
    const res = await GET(req, { params })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Project not found")
  })

  it("returns 404 if workspace is not found", async () => {
    mockMaybeSingleProject.mockResolvedValue({
      data: { slug: "help", workspace_id: "ws-1", status: "published" },
      error: null,
    })
    mockMaybeSingleWorkspace.mockResolvedValue({ data: null, error: null })

    const req = makeRequest("https://app.example.com/p/project/a992906c-d30d-498b-8c3a-1fd22e0bd397")
    const params = Promise.resolve({ id: "a992906c-d30d-498b-8c3a-1fd22e0bd397" })
    const res = await GET(req, { params })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Workspace not found")
  })

  it("redirects the default project to the workspace's /p/<slug> path", async () => {
    mockMaybeSingleProject.mockResolvedValue({
      data: { slug: "bread", workspace_id: "ws-1", status: "published" },
      error: null,
    })
    mockMaybeSingleWorkspace.mockResolvedValue({
      data: { slug: "bread", settings: {} },
      error: null,
    })

    const req = makeRequest("https://app.example.com/p/project/a992906c-d30d-498b-8c3a-1fd22e0bd397")
    const params = Promise.resolve({ id: "a992906c-d30d-498b-8c3a-1fd22e0bd397" })
    const res = await GET(req, { params })
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("https://app.example.com/p/bread")
  })

  it("redirects a named project to a nested path under the workspace slug", async () => {
    mockMaybeSingleProject.mockResolvedValue({
      data: { slug: "bread-help", workspace_id: "ws-1", status: "published" },
      error: null,
    })
    mockMaybeSingleWorkspace.mockResolvedValue({
      data: { slug: "bread", settings: {} },
      error: null,
    })

    const req = makeRequest("https://app.example.com/p/project/a992906c-d30d-498b-8c3a-1fd22e0bd397")
    const params = Promise.resolve({ id: "a992906c-d30d-498b-8c3a-1fd22e0bd397" })
    const res = await GET(req, { params })
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("https://app.example.com/p/bread/bread-help")
  })

  it("redirects to custom domain if custom domain is configured", async () => {
    mockMaybeSingleProject.mockResolvedValue({
      data: { slug: "bread-help", workspace_id: "ws-1", status: "published" },
      error: null,
    })
    mockMaybeSingleWorkspace.mockResolvedValue({
      data: { slug: "bread", settings: { kb_custom_domain: "docs.acme.com" } },
      error: null,
    })

    const req = makeRequest("https://app.example.com/p/project/a992906c-d30d-498b-8c3a-1fd22e0bd397")
    const params = Promise.resolve({ id: "a992906c-d30d-498b-8c3a-1fd22e0bd397" })
    const res = await GET(req, { params })
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("https://docs.acme.com/bread-help")
  })

  it("redirects a project to a dedicated project domain root", async () => {
    mockMaybeSingleProject.mockResolvedValue({
      data: { slug: "docs", workspace_id: "ws-1", status: "published" },
      error: null,
    })
    mockMaybeSingleWorkspace.mockResolvedValue({
      data: { slug: "acme", settings: {} },
      error: null,
    })
    mockMaybeSinglePortalRoute.mockResolvedValue({
      data: { domain: "docs.acme.com", path_prefix: "/" },
      error: null,
    })

    const req = makeRequest("https://app.example.com/p/project/a992906c-d30d-498b-8c3a-1fd22e0bd397")
    const params = Promise.resolve({ id: "a992906c-d30d-498b-8c3a-1fd22e0bd397" })
    const res = await GET(req, { params })

    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("https://docs.acme.com/")
  })

  it("redirects a project to its shared-domain path mount", async () => {
    mockMaybeSingleProject.mockResolvedValue({
      data: { slug: "docs", workspace_id: "ws-1", status: "published" },
      error: null,
    })
    mockMaybeSingleWorkspace.mockResolvedValue({
      data: { slug: "acme", settings: { kb_custom_domain: "legacy.acme.com" } },
      error: null,
    })
    mockMaybeSinglePortalRoute.mockResolvedValue({
      data: { domain: "acme.com", path_prefix: "/docs" },
      error: null,
    })

    const req = makeRequest("https://app.example.com/p/project/a992906c-d30d-498b-8c3a-1fd22e0bd397?q=setup")
    const params = Promise.resolve({ id: "a992906c-d30d-498b-8c3a-1fd22e0bd397" })
    const res = await GET(req, { params })

    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("https://acme.com/docs?q=setup")
  })

  it("preserves incoming search params", async () => {
    mockMaybeSingleProject.mockResolvedValue({
      data: { slug: "bread", workspace_id: "ws-1", status: "published" },
      error: null,
    })
    mockMaybeSingleWorkspace.mockResolvedValue({
      data: { slug: "bread", settings: {} },
      error: null,
    })

    const req = makeRequest("https://app.example.com/p/project/a992906c-d30d-498b-8c3a-1fd22e0bd397?q=query&foo=bar")
    const params = Promise.resolve({ id: "a992906c-d30d-498b-8c3a-1fd22e0bd397" })
    const res = await GET(req, { params })
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("https://app.example.com/p/bread?q=query&foo=bar")
  })
})
