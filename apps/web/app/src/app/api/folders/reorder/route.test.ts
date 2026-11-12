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

const TOPIC_A = "550e8400-e29b-41d4-a716-446655440001"
const TOPIC_B = "550e8400-e29b-41d4-a716-446655440002"

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/folders/reorder", {
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

describe("PATCH /api/folders/reorder", () => {
  it("returns 403 for non-admins", async () => {
    mockAuthed("editor")

    const res = await PATCH(
      makeRequest({ kind: "topic", ordered_ids: [TOPIC_A, TOPIC_B] }),
    )

    expect(res.status).toBe(403)
    expect(adminMock.from).not.toHaveBeenCalled()
  })

  it("rejects duplicate ordered_ids", async () => {
    mockAuthed("admin")

    const res = await PATCH(
      makeRequest({ kind: "topic", ordered_ids: [TOPIC_A, TOPIC_A] }),
    )

    expect(res.status).toBe(400)
    expect(adminMock.from).not.toHaveBeenCalled()
  })

  it("updates sort_order for topics in the submitted order", async () => {
    mockAuthed("admin")

    const lookupChain = {
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ id: TOPIC_A }, { id: TOPIC_B }],
        error: null,
      }),
    }
    const updates: Array<{ sort_order: number }> = []
    const updateChains: Array<ReturnType<typeof makeUpdateChain>> = []
    adminMock.from.mockReturnValue({
      select: vi.fn().mockReturnValue(lookupChain),
      update: vi.fn((payload: { sort_order: number }) => {
        updates.push(payload)
        const updateChain = makeUpdateChain()
        updateChains.push(updateChain)
        return updateChain
      }),
    })

    const res = await PATCH(
      makeRequest({ kind: "topic", ordered_ids: [TOPIC_B, TOPIC_A] }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ordered_ids).toEqual([TOPIC_B, TOPIC_A])
    expect(updates).toEqual([{ sort_order: 0 }, { sort_order: 1 }])
    expect(updateChains).toHaveLength(2)
    for (const chain of updateChains) {
      expect(chain.eq).toHaveBeenCalledWith("workspace_id", "ws-1")
      expect(chain.eq).toHaveBeenCalledWith("kind", "topic")
    }
  })

  it("reorders user folders (portal sidebar headers) and busts the public cache", async () => {
    mockAuthed("owner")

    const lookupChain = {
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ id: TOPIC_A }, { id: TOPIC_B }],
        error: null,
      }),
    }
    const updateChains: Array<ReturnType<typeof makeUpdateChain>> = []
    adminMock.from.mockReturnValue({
      select: vi.fn().mockReturnValue(lookupChain),
      update: vi.fn(() => {
        const updateChain = makeUpdateChain()
        updateChains.push(updateChain)
        return updateChain
      }),
    })

    const res = await PATCH(
      makeRequest({ kind: "user", ordered_ids: [TOPIC_A, TOPIC_B] }),
    )

    expect(res.status).toBe(200)
    for (const chain of updateChains) {
      expect(chain.eq).toHaveBeenCalledWith("kind", "user")
    }
    expect(revalidateTag).toHaveBeenCalledWith("public-kb", { expire: 0 })
  })

  it("rejects unknown folder kinds", async () => {
    mockAuthed("admin")

    const res = await PATCH(
      makeRequest({ kind: "system", ordered_ids: [TOPIC_A] }),
    )

    expect(res.status).toBe(400)
    expect(adminMock.from).not.toHaveBeenCalled()
  })
})
