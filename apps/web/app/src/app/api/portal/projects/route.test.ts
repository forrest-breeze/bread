import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockRequireRouteUser,
  mockGetActiveWorkspace,
  mockGetPortalEntitlements,
  mockListPortalProjects,
  mockCreatePortalProject,
  mockUpdatePortalProjectScope,
} = vi.hoisted(() => ({
  mockRequireRouteUser: vi.fn(),
  mockGetActiveWorkspace: vi.fn(),
  mockGetPortalEntitlements: vi.fn(),
  mockListPortalProjects: vi.fn(),
  mockCreatePortalProject: vi.fn(),
  mockUpdatePortalProjectScope: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}))

vi.mock("@/lib/auth/route-auth", () => ({
  requireRouteUser: mockRequireRouteUser,
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: mockGetActiveWorkspace,
}))

vi.mock("@/lib/db/subscription", () => ({
  getPortalEntitlementsForWorkspace: mockGetPortalEntitlements,
}))

vi.mock("@/lib/portal/experiences-write", () => ({
  createPortalProject: mockCreatePortalProject,
  listPortalProjects: mockListPortalProjects,
  updatePortalProjectScope: mockUpdatePortalProjectScope,
}))

import { POST } from "./route"

function makeRequest(body: unknown): Request {
  return new Request("https://app.example.dev/api/portal/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const VALID_BODY = {
  slug: "help",
  name: "Help Center",
}

describe("POST /api/portal/projects — plan gates", () => {
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
    mockGetPortalEntitlements.mockResolvedValue({
      planId: "basic",
      portalEditor: true,
      portalProjectLimit: 1,
      portalAiBuilder: false,
      portalReporting: false,
      portalReportingMaxDays: 0,
    })
    mockListPortalProjects.mockResolvedValue([])
    mockCreatePortalProject.mockResolvedValue({ slug: "help" })
  })

  it("returns 402 when the plan does not include the portal editor", async () => {
    mockGetPortalEntitlements.mockResolvedValue({
      planId: "free",
      portalEditor: false,
      portalProjectLimit: 0,
      portalAiBuilder: false,
      portalReporting: false,
      portalReportingMaxDays: 0,
    })

    const res = await POST(makeRequest(VALID_BODY))

    expect(res.status).toBe(402)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("payment_required")
    expect(mockListPortalProjects).not.toHaveBeenCalled()
    expect(mockCreatePortalProject).not.toHaveBeenCalled()
  })

  it("returns 409 when the workspace already has its portal", async () => {
    mockListPortalProjects.mockResolvedValue([{ slug: "docs" }])

    const res = await POST(makeRequest(VALID_BODY))

    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("portal_exists")
    expect(mockCreatePortalProject).not.toHaveBeenCalled()
  })

  it("creates the portal when the workspace has none", async () => {
    const res = await POST(makeRequest(VALID_BODY))

    expect(res.status).toBe(201)
    expect(mockCreatePortalProject).toHaveBeenCalledWith("ws-1", "user-1", {
      slug: "help",
      name: "Help Center",
      scope: null,
    })
  })
})
