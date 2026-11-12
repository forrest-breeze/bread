import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NextRequest } from "next/server"

const {
  mockRequireRouteUser,
  mockGetActiveWorkspace,
  mockGetPortalEntitlements,
  mockListPortalVersions,
} = vi.hoisted(() => ({
  mockRequireRouteUser: vi.fn(),
  mockGetActiveWorkspace: vi.fn(),
  mockGetPortalEntitlements: vi.fn(),
  mockListPortalVersions: vi.fn(),
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
  listPortalVersions: mockListPortalVersions,
}))

import { GET } from "./route"

function makeRequest(query = ""): NextRequest {
  return new Request(
    `https://app.example.dev/api/portal/versions${query}`,
  ) as NextRequest
}

const VERSIONS = [
  {
    version: 2,
    status: "published" as const,
    publishedBy: "Ada",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
]

describe("GET /api/portal/versions", () => {
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
    mockGetPortalEntitlements.mockResolvedValue({ portalEditor: true })
    mockListPortalVersions.mockResolvedValue(VERSIONS)
  })

  it("returns the requested project's version history", async () => {
    const res = await GET(makeRequest("?project=help"))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ versions: VERSIONS })
    expect(mockListPortalVersions).toHaveBeenCalledWith("ws-1", "help")
  })

  it("falls back to the default project when no slug is given", async () => {
    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    expect(mockListPortalVersions).toHaveBeenCalledWith("ws-1", undefined)
  })

  it("rejects a malformed project slug", async () => {
    const res = await GET(makeRequest("?project=Not%20A%20Slug"))

    expect(res.status).toBe(400)
    expect(mockListPortalVersions).not.toHaveBeenCalled()
  })

  it("refuses members who cannot manage the portal", async () => {
    mockGetActiveWorkspace.mockResolvedValue({
      workspace_id: "ws-1",
      role: "member",
    })

    const res = await GET(makeRequest())

    expect(res.status).toBe(403)
    expect(mockListPortalVersions).not.toHaveBeenCalled()
  })

  it("refuses workspaces without the portal editor entitlement", async () => {
    mockGetPortalEntitlements.mockResolvedValue({ portalEditor: false })

    const res = await GET(makeRequest())

    expect(res.status).toBe(402)
    expect(mockListPortalVersions).not.toHaveBeenCalled()
  })
})
