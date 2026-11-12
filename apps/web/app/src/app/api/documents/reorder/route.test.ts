import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }))

type SupabaseMock = {
  auth: { getUser: typeof mockGetUser }
}

type AdminMock = {
  from: ReturnType<typeof vi.fn>
}

let supabaseMock: SupabaseMock
let adminMock: AdminMock

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => adminMock),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn,
}))

import { revalidateTag } from "next/cache"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { PATCH } from "./route"

const DOC_A = "550e8400-e29b-41d4-a716-446655440001"
const DOC_B = "550e8400-e29b-41d4-a716-446655440002"

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/documents/reorder", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function mockAuthed(role = "admin"): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com" } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "wm-1",
    workspace_id: "ws-1",
    role,
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {}
  chain.eq = vi.fn(() => chain)
  chain.then = (resolve: (value: { data: null; error: null }) => void) =>
    resolve({ data: null, error: null })
  return chain
}

function makeLookupChain(rows: Array<{ id: string }>) {
  return {
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: rows, error: null }),
  }
}

beforeEach(() => {
  supabaseMock = {
    auth: { getUser: mockGetUser },
  }
  adminMock = {
    from: vi.fn(),
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("PATCH /api/documents/reorder", () => {
  it("returns 403 for non-admins", async () => {
    mockAuthed("editor")

    const res = await PATCH(makeRequest({ ordered_ids: [DOC_A, DOC_B] }))

    expect(res.status).toBe(403)
    expect(adminMock.from).not.toHaveBeenCalled()
  })

  it("rejects duplicate ordered_ids", async () => {
    mockAuthed("admin")

    const res = await PATCH(makeRequest({ ordered_ids: [DOC_A, DOC_A] }))

    expect(res.status).toBe(400)
    expect(adminMock.from).not.toHaveBeenCalled()
  })

  it("rejects ids that are not live workspace documents", async () => {
    mockAuthed("admin")

    adminMock.from.mockReturnValue({
      select: vi.fn().mockReturnValue(makeLookupChain([{ id: DOC_A }])),
      update: vi.fn(),
    })

    const res = await PATCH(makeRequest({ ordered_ids: [DOC_A, DOC_B] }))

    expect(res.status).toBe(400)
  })

  it("updates sort_order in the submitted order and busts the public cache", async () => {
    mockAuthed("owner")

    const updates: Array<{ sort_order: number }> = []
    const updateChains: Array<ReturnType<typeof makeUpdateChain>> = []
    adminMock.from.mockReturnValue({
      select: vi
        .fn()
        .mockReturnValue(makeLookupChain([{ id: DOC_A }, { id: DOC_B }])),
      update: vi.fn((payload: { sort_order: number }) => {
        updates.push(payload)
        const updateChain = makeUpdateChain()
        updateChains.push(updateChain)
        return updateChain
      }),
    })

    const res = await PATCH(makeRequest({ ordered_ids: [DOC_B, DOC_A] }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ordered_ids).toEqual([DOC_B, DOC_A])
    expect(updates).toEqual([{ sort_order: 0 }, { sort_order: 1 }])
    expect(updateChains).toHaveLength(2)
    for (const chain of updateChains) {
      expect(chain.eq).toHaveBeenCalledWith("workspace_id", "ws-1")
    }
    expect(revalidateTag).toHaveBeenCalledWith("public-kb", { expire: 0 })
  })
})
