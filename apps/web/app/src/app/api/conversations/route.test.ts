/**
 * /api/conversations POST — input validation regression guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

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
import { POST } from "./route"

function makeRequest(body: unknown): Request {
  return new Request("https://app.example.dev/api/conversations", {
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

describe("POST /api/conversations — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(401)
  })

  it("returns 400 for non-string title", async () => {
    mockAuthed()
    const res = await POST(makeRequest({ title: 42 as unknown as string }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for title over 200 chars", async () => {
    mockAuthed()
    const res = await POST(makeRequest({ title: "x".repeat(201) }))
    expect(res.status).toBe(400)
  })
})
