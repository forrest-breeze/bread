/**
 * /api/workspace/icon POST — input validation regression guards.
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

import { getActiveWorkspace } from "@/lib/db/workspace"
import { POST } from "./route"

function makeFormRequest(file?: File | string): NextRequest {
  const fd = new FormData()
  if (file !== undefined) fd.append("file", file as Blob | string)
  return new NextRequest("https://app.example.dev/api/workspace/icon", {
    method: "POST",
    body: fd,
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

describe("POST /api/workspace/icon — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const file = new File(["x"], "icon.png", { type: "image/png" })
    const res = await POST(makeFormRequest(file))
    expect(res.status).toBe(401)
  })

  it("returns 400 when no file is provided", async () => {
    mockAuthed()
    const res = await POST(makeFormRequest())
    expect(res.status).toBe(400)
  })

  it("returns 400 for an unsupported MIME type", async () => {
    mockAuthed()
    const file = new File(["pdf-bytes"], "icon.pdf", { type: "application/pdf" })
    const res = await POST(makeFormRequest(file))
    expect(res.status).toBe(400)
  })

  it("returns 400 for a file over 2 MB", async () => {
    mockAuthed()
    const oversize = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], {
      type: "image/png",
    })
    const file = new File([oversize], "huge.png", { type: "image/png" })
    const res = await POST(makeFormRequest(file))
    expect(res.status).toBe(400)
  })
})
