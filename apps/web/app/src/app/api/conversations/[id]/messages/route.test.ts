/**
 * /api/conversations/[id]/messages POST — input validation regression guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGetUser, insertedRows } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  insertedRows: [] as Array<Record<string, unknown>>,
}))

// Minimal query-builder stand-in: enough for the route's ownership check
// (conversations → single) and the batch insert whose rows the tests inspect.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({ data: { id: "conversation-1" }, error: null }),
          }),
        }),
      }),
      insert: (rows: Array<Record<string, unknown>>) => {
        if (table === "chat_messages") insertedRows.push(...rows)
        return Promise.resolve({ error: null })
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}))

import { DELETE, POST } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function paramsOf(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function makeRequest(body: unknown): Request {
  return new Request(
    `https://app.example.dev/api/conversations/${VALID_UUID}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  )
}

describe("POST /api/conversations/[id]/messages — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 404 for non-uuid id", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "u@example.com" } },
    })
    const res = await POST(makeRequest({ messages: [] }), paramsOf("nope"))
    expect(res.status).toBe(404)
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ messages: [] }), paramsOf(VALID_UUID))
    expect(res.status).toBe(401)
  })

  // created_at defaults to now(), the TRANSACTION timestamp, so every row of a
  // batch would tie and readers would fall back to a random uuid tiebreak. The
  // portal builder's checkpoint restore truncates the thread by position, so a
  // user/assistant pair that can sort either way corrupts the cut.
  it("stamps batch rows with strictly increasing created_at", async () => {
    insertedRows.length = 0
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "u@example.com" } },
    })
    const res = await POST(
      makeRequest({
        messages: [
          { role: "user", content: "ask" },
          { role: "assistant", content: "reply" },
        ],
      }),
      paramsOf(VALID_UUID),
    )

    expect(res.status).toBe(201)
    expect(insertedRows.map((row) => row.role)).toEqual(["user", "assistant"])
    const stamps = insertedRows.map((row) =>
      Date.parse(row.created_at as string),
    )
    expect(stamps.every(Number.isFinite)).toBe(true)
    expect(stamps[1]).toBeGreaterThan(stamps[0] as number)
  })
})

function makeDeleteRequest(query: string): Request {
  return new Request(
    `https://app.example.dev/api/conversations/${VALID_UUID}/messages${query}`,
    { method: "DELETE" },
  )
}

describe("DELETE /api/conversations/[id]/messages — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 404 for non-uuid id", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "u@example.com" } },
    })
    const res = await DELETE(makeDeleteRequest("?keep=1"), paramsOf("nope"))
    expect(res.status).toBe(404)
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await DELETE(makeDeleteRequest("?keep=1"), paramsOf(VALID_UUID))
    expect(res.status).toBe(401)
  })

  // A missing or non-numeric `keep` must never coerce to 0 — that would wipe
  // the whole thread instead of truncating it.
  it.each(["", "?keep=", "?keep=-1", "?keep=abc", "?keep=1.5"])(
    "rejects %s with 400",
    async (query) => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: "user-1", email: "u@example.com" } },
      })
      const res = await DELETE(makeDeleteRequest(query), paramsOf(VALID_UUID))
      expect(res.status).toBe(400)
    },
  )
})
