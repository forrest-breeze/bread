/**
 * /api/teams POST/DELETE — input validation regression guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { POST, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/teams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(id?: string): NextRequest {
  const url = id
    ? `https://app.example.dev/api/teams?id=${encodeURIComponent(id)}`
    : "https://app.example.dev/api/teams"
  return new NextRequest(url, { method: "DELETE" })
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

describe("POST /api/teams — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makePostRequest({ name: "Engineering" }))
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await POST(makePostRequest("{not json"))
    expect(res.status).toBe(400)
  })

  it("returns 400 when name is missing", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({}))
    expect(res.status).toBe(400)
  })

  it("returns 400 when name trims to empty", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ name: "   " }))
    expect(res.status).toBe(400)
  })

  it("returns 400 when name is over 120 chars", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ name: "a".repeat(121) }))
    expect(res.status).toBe(400)
  })

  it("returns 400 when description is over 500 chars", async () => {
    mockAuthed()
    const res = await POST(
      makePostRequest({ name: "Eng", description: "a".repeat(501) }),
    )
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/teams — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 when id is missing", async () => {
    mockAuthed()
    const res = await DELETE(makeDeleteRequest())
    expect(res.status).toBe(400)
  })

  it("returns 400 when id is not a uuid", async () => {
    mockAuthed()
    const res = await DELETE(makeDeleteRequest("not-a-uuid"))
    expect(res.status).toBe(400)
  })
})
