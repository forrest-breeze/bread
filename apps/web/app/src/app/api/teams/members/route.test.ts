/**
 * /api/teams/members GET/POST/DELETE — input validation regression guards.
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
import { GET, POST, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"
const OTHER_UUID = "650e8400-e29b-41d4-a716-446655440000"

function makeGetRequest(teamId?: string): NextRequest {
  const url = teamId
    ? `https://app.example.dev/api/teams/members?team_id=${encodeURIComponent(teamId)}`
    : "https://app.example.dev/api/teams/members"
  return new NextRequest(url, { method: "GET" })
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/teams/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(id?: string): NextRequest {
  const url = id
    ? `https://app.example.dev/api/teams/members?id=${encodeURIComponent(id)}`
    : "https://app.example.dev/api/teams/members"
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

describe("GET /api/teams/members — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 400 when team_id is missing", async () => {
    mockAuthed()
    const res = await GET(makeGetRequest())
    expect(res.status).toBe(400)
  })

  it("returns 400 when team_id is not a uuid", async () => {
    mockAuthed()
    const res = await GET(makeGetRequest("not-a-uuid"))
    expect(res.status).toBe(400)
  })
})

describe("POST /api/teams/members — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await POST(makePostRequest("{not json"))
    expect(res.status).toBe(400)
  })

  it("returns 400 when team_id is missing", async () => {
    mockAuthed()
    const res = await POST(
      makePostRequest({ workspace_member_id: VALID_UUID }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 when workspace_member_id is missing", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ team_id: VALID_UUID }))
    expect(res.status).toBe(400)
  })

  it("returns 400 when team_id is not a uuid", async () => {
    mockAuthed()
    const res = await POST(
      makePostRequest({ team_id: "nope", workspace_member_id: OTHER_UUID }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 when workspace_member_id is not a uuid", async () => {
    mockAuthed()
    const res = await POST(
      makePostRequest({ team_id: VALID_UUID, workspace_member_id: "nope" }),
    )
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/teams/members — validation", () => {
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
