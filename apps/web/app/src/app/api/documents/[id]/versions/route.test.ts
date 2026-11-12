/**
 * /api/documents/[id]/versions — input validation regression guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

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

import { getActiveWorkspace } from "@/lib/db/workspace"
import { GET, POST } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"
const OTHER_UUID = "650e8400-e29b-41d4-a716-446655440000"

function paramsOf(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function makePostRequest(body: unknown): Request {
  return new Request(
    `https://app.example.dev/api/documents/${VALID_UUID}/versions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  )
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

describe("documents/[id]/versions — validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("GET rejects non-uuid id with 400", async () => {
    mockAuthed()
    const res = await GET(
      new Request("https://app.example.dev/api/documents/nope/versions"),
      paramsOf("nope"),
    )
    expect(res.status).toBe(400)
  })

  it("POST rejects non-uuid id with 400", async () => {
    mockAuthed()
    const res = await POST(
      makePostRequest({ version_id: OTHER_UUID }),
      paramsOf("nope"),
    )
    expect(res.status).toBe(400)
  })

  it("POST returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(
      makePostRequest({ version_id: OTHER_UUID }),
      paramsOf(VALID_UUID),
    )
    expect(res.status).toBe(401)
  })

  it("POST requires an editor-capable workspace role", async () => {
    mockAuthed()
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "wm-1",
      workspace_id: "ws-1",
      role: "viewer",
    } as Awaited<ReturnType<typeof getActiveWorkspace>>)

    const res = await POST(
      makePostRequest({ version_id: OTHER_UUID }),
      paramsOf(VALID_UUID),
    )

    expect(res.status).toBe(403)
  })

  it("POST returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await POST(makePostRequest("{not json"), paramsOf(VALID_UUID))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Invalid JSON")
  })

  it("POST returns 400 when version_id is missing", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({}), paramsOf(VALID_UUID))
    expect(res.status).toBe(400)
  })

  it("POST returns 400 when version_id is not a uuid", async () => {
    mockAuthed()
    const res = await POST(
      makePostRequest({ version_id: "not-a-uuid" }),
      paramsOf(VALID_UUID),
    )
    expect(res.status).toBe(400)
  })
})
