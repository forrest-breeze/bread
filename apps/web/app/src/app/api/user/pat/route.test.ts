/**
 * /api/user/pat — input validation regression guards for POST and DELETE.
 *
 * POST tolerates empty / malformed bodies (defaults apply) but rejects
 * structurally invalid bodies (bad scope, out-of-range ttl_days). DELETE
 * requires a uuid id query param.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}))

import { POST, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function makePostRequest(body: unknown, contentType?: string): NextRequest {
  return new NextRequest("https://app.example.dev/api/user/pat", {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : undefined,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(id?: string): NextRequest {
  const url = id
    ? `https://app.example.dev/api/user/pat?id=${encodeURIComponent(id)}`
    : "https://app.example.dev/api/user/pat"
  return new NextRequest(url, { method: "DELETE" })
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
}

describe("POST /api/user/pat — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makePostRequest({}))
    expect(res.status).toBe(401)
  })

  it("returns 400 for unknown scope value", async () => {
    mockAuthed()
    const res = await POST(
      makePostRequest({ scopes: ["root"] }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for empty scopes array", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ scopes: [] }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for ttl_days outside 1..365", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ ttl_days: 0 }))
    expect(res.status).toBe(400)
    const res2 = await POST(makePostRequest({ ttl_days: 366 }))
    expect(res2.status).toBe(400)
  })

  it("returns 400 for non-integer ttl_days", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ ttl_days: 30.5 }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for empty trimmed name", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ name: "   " }))
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/user/pat — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await DELETE(makeDeleteRequest(VALID_UUID))
    expect(res.status).toBe(401)
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
