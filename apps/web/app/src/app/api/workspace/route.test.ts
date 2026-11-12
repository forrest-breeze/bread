/**
 * /api/workspace POST and PUT — input validation regression guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { mockGetUser, mockFrom, mockRevalidateTag } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockFrom: vi.fn(),
  mockRevalidateTag: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}))

vi.mock("@/lib/workspace-settings", () => ({
  normalizeWorkspaceSettings: vi.fn((s: unknown) => s ?? {}),
}))

vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: vi.fn(() => ({
    capture: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock("@/lib/db/subscription", () => ({
  getPortalEntitlementsForWorkspace: vi.fn().mockResolvedValue({}),
}))

vi.mock("@/lib/public-kb", () => ({
  PUBLIC_KB_CACHE_TAG: "public-kb",
}))

vi.mock("next/cache", () => ({
  revalidateTag: mockRevalidateTag,
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { POST, PUT } from "./route"

function makeRequest(method: "POST" | "PUT", body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/workspace", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "wm-1",
    workspace_id: "ws-1",
    role: "admin",
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
}

describe("POST /api/workspace — disabled (single Breeze workspace)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest("POST", { name: "Acme" }))
    expect(res.status).toBe(401)
  })

  it("refuses to create a workspace", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", { name: "Acme" }))
    expect(res.status).toBe(403)
  })
})

describe("PUT /api/workspace — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await PUT(makeRequest("PUT", { name: "Acme" }))
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", "{not json"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Invalid JSON")
  })

  it("returns 400 for icon_url over 2048 chars", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", { icon_url: "x".repeat(2049) }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-object settings", async () => {
    mockAuthed()
    const res = await PUT(
      makeRequest("PUT", { settings: "should-be-object" as unknown as object }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for empty trimmed name", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", { name: "   " }))
    expect(res.status).toBe(400)
  })

  it("invalidates the public portal cache after updating visibility", async () => {
    mockAuthed()

    const readSingle = vi.fn().mockResolvedValue({
      data: { settings: { kb_public: false, kb_brand_name: "Bread" } },
      error: null,
    })
    const writeSingle = vi.fn().mockResolvedValue({
      data: {
        id: "ws-1",
        settings: { kb_public: true, kb_brand_name: "Bread" },
      },
      error: null,
    })
    const readChain = {
      eq: vi.fn().mockReturnThis(),
      single: readSingle,
    }
    const writeChain = {
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: writeSingle,
    }
    const table = {
      select: vi.fn(() => readChain),
      update: vi.fn(() => writeChain),
    }
    mockFrom.mockReturnValue(table)

    const res = await PUT(
      makeRequest("PUT", { settings: { kb_public: true } }),
    )

    expect(res.status).toBe(200)
    expect(table.update).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { kb_public: true, kb_brand_name: "Bread" },
      }),
    )
    expect(mockRevalidateTag).toHaveBeenCalledWith("public-kb", { expire: 0 })
  })
})
