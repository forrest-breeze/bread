/**
 * /api/profile PUT — input validation regression guards.
 *
 * Covers the Zod schema added to gate display_name / status / avatar_url / role.
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

import { PUT } from "./route"

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
}

describe("PUT /api/profile — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await PUT(makeRequest({ display_name: "Test" }))
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("{not json"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Invalid JSON")
  })

  it("returns 400 with issues for empty display_name", async () => {
    mockAuthed()
    const res = await PUT(makeRequest({ display_name: "" }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: unknown }
    expect(body.error).toBe("Invalid request body")
    expect(body.issues).toBeDefined()
  })

  it("returns 400 for display_name over 120 chars", async () => {
    mockAuthed()
    const res = await PUT(makeRequest({ display_name: "a".repeat(121) }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for status outside the allowed enum", async () => {
    mockAuthed()
    const res = await PUT(makeRequest({ status: "frolicking" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for avatar_url over 2048 chars", async () => {
    mockAuthed()
    const res = await PUT(makeRequest({ avatar_url: "x".repeat(2049) }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for role over 120 chars", async () => {
    mockAuthed()
    const res = await PUT(makeRequest({ role: "x".repeat(121) }))
    expect(res.status).toBe(400)
  })

  it("returns 400 when trying to un-complete the tutorial", async () => {
    mockAuthed()
    const res = await PUT(makeRequest({ tutorial_completed: false }))
    expect(res.status).toBe(400)
  })
})
