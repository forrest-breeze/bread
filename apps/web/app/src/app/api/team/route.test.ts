/**
 * /api/team POST/PUT/DELETE — input validation regression guards.
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
  countActiveMembers: vi.fn(),
}))

vi.mock("@/lib/db/subscription", () => ({
  getWorkspaceSubscription: vi.fn(),
}))

vi.mock("@/lib/billing/catalog", () => ({
  getBillingPlan: vi.fn(),
  isBillingPlanId: vi.fn(() => true),
}))

vi.mock("@/lib/email", () => ({
  sendInviteEmail: vi.fn(),
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { POST, PUT, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function makeRequest(method: "POST" | "PUT", body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/team", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(id?: string): NextRequest {
  const url = id
    ? `https://app.example.dev/api/team?id=${encodeURIComponent(id)}`
    : "https://app.example.dev/api/team"
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

describe("POST /api/team — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(
      makeRequest("POST", { email: "test@example.com" }),
    )
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", "{not json"))
    expect(res.status).toBe(400)
  })

  it("returns 400 for missing email", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", {}))
    expect(res.status).toBe(400)
  })

  it("returns 400 for malformed email", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", { email: "not-an-email" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for unknown role", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest("POST", { email: "test@example.com", role: "wizard" }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-boolean resend", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest("POST", {
        email: "test@example.com",
        resend: "yes" as unknown as boolean,
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe("PUT /api/team — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 for missing member_id", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", { role: "editor" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-uuid member_id", async () => {
    mockAuthed()
    const res = await PUT(
      makeRequest("PUT", { member_id: "not-a-uuid", role: "editor" }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for unknown role", async () => {
    mockAuthed()
    const res = await PUT(
      makeRequest("PUT", { member_id: VALID_UUID, role: "wizard" }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for missing role", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", { member_id: VALID_UUID }))
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/team — validation", () => {
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
