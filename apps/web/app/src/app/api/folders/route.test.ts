/**
 * /api/folders POST — input validation regression guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { mockGetUser, mockFrom, mockInsert, mockSelect, mockSingle } =
  vi.hoisted(() => ({
    mockGetUser: vi.fn(),
    mockFrom: vi.fn(),
    mockInsert: vi.fn(),
    mockSelect: vi.fn(),
    mockSingle: vi.fn(),
  }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { POST } from "./route"

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/folders", {
    method: "POST",
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

describe("POST /api/folders — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFrom.mockReturnValue({ insert: mockInsert })
    mockInsert.mockReturnValue({ select: mockSelect })
    mockSelect.mockReturnValue({ single: mockSingle })
    mockSingle.mockResolvedValue({
      data: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Docs",
        display_name: "Docs",
        kind: "user",
        parent_folder_id: null,
        visibility: "workspace",
        required_role: null,
        sort_order: null,
        created_at: "2026-06-11T00:00:00.000Z",
        updated_at: "2026-06-11T00:00:00.000Z",
      },
      error: null,
    })
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ name: "Docs" }))
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await POST(makeRequest("{not json"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Invalid JSON")
  })

  it("returns 400 when name is missing", async () => {
    mockAuthed()
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it("returns 400 when name trims to empty", async () => {
    mockAuthed()
    const res = await POST(makeRequest({ name: "   " }))
    expect(res.status).toBe(400)
  })

  it("returns 400 when name is over 120 chars", async () => {
    mockAuthed()
    const res = await POST(makeRequest({ name: "a".repeat(121) }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for an unknown visibility", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest({ name: "Docs", visibility: "private" }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 when visibility=role but required_role is missing", async () => {
    mockAuthed()
    const res = await POST(makeRequest({ name: "Docs", visibility: "role" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 when visibility=role but required_role is null", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest({ name: "Docs", visibility: "role", required_role: null }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 when required_role is unknown", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest({
        name: "Docs",
        visibility: "role",
        required_role: "wizard",
      }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-uuid id", async () => {
    mockAuthed()
    const res = await POST(makeRequest({ name: "Docs", id: "not-a-uuid" }))
    expect(res.status).toBe(400)
  })

  it("accepts workspace folder creation with a null required_role", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Docs",
        visibility: "workspace",
        required_role: null,
      }),
    )

    expect(res.status).toBe(201)
    expect(mockFrom).toHaveBeenCalledWith("folders")
    expect(mockInsert).toHaveBeenCalledWith({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Docs",
      display_name: "Docs",
      kind: "user",
      parent_folder_id: null,
      workspace_id: "ws-1",
      visibility: "workspace",
      required_role: null,
    })
  })
})
