/**
 * /api/workspace/invite POST/PATCH/DELETE — input validation regression guards.
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

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock("@/app/api/workspace/route", () => ({
  generateInviteCode: vi.fn(() => "test-code"),
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { POST, PATCH, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/workspace/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makePatchRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/workspace/invite", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(id?: string): NextRequest {
  const url = id
    ? `https://app.example.dev/api/workspace/invite?id=${encodeURIComponent(id)}`
    : "https://app.example.dev/api/workspace/invite"
  return new NextRequest(url, { method: "DELETE" })
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "wm-1",
    workspace_id: "ws-1",
    role: "owner",
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
}

describe("POST /api/workspace/invite — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 400 for an unknown role", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ role: "wizard" }))
    expect(res.status).toBe(400)
  })
})

describe("PATCH /api/workspace/invite — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest("{not json"))
    expect(res.status).toBe(400)
  })

  it("returns 400 when role is missing", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest({}))
    expect(res.status).toBe(400)
  })

  it("returns 400 for an unknown role", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest({ role: "wizard" }))
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/workspace/invite — validation", () => {
  beforeEach(() => vi.clearAllMocks())

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
