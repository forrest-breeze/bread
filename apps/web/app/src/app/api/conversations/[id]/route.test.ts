/**
 * /api/conversations/[id] — input validation regression guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGetUser, messageOrderBy } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  // Columns the chat_messages read is ordered by, in order.
  messageOrderBy: [] as string[],
}))

vi.mock("@/lib/supabase/server", () => {
  // Chainable stand-in that records how the chat_messages read is ordered and
  // resolves like a PostgREST builder when awaited.
  const messagesQuery = {
    order(column: string) {
      messageOrderBy.push(column)
      return this
    },
    then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve({ data: [], error: null }).then(resolve)
    },
  }
  return {
    createClient: vi.fn().mockResolvedValue({
      auth: { getUser: mockGetUser },
      from: (table: string) => ({
        select: () =>
          table === "chat_messages"
            ? { eq: () => messagesQuery }
            : {
                eq: () => ({
                  eq: () => ({
                    single: () =>
                      Promise.resolve({
                        data: { id: "c1", title: "t", user_id: "user-1" },
                        error: null,
                      }),
                  }),
                }),
              },
      }),
    }),
  }
})

import { GET, PATCH, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function paramsOf(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function makePatchRequest(body: unknown): Request {
  return new Request(`https://app.example.dev/api/conversations/${VALID_UUID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
}

describe("conversations/[id] — param validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthed()
  })

  it("GET returns 404 for non-uuid id", async () => {
    const res = await GET(
      new Request("https://app.example.dev/api/conversations/nope"),
      paramsOf("nope"),
    )
    expect(res.status).toBe(404)
  })

  it("PATCH returns 404 for non-uuid id", async () => {
    const res = await PATCH(makePatchRequest({ title: "x" }), paramsOf("nope"))
    expect(res.status).toBe(404)
  })

  it("DELETE returns 404 for non-uuid id", async () => {
    const res = await DELETE(
      new Request(`https://app.example.dev/api/conversations/nope`, {
        method: "DELETE",
      }),
      paramsOf("nope"),
    )
    expect(res.status).toBe(404)
  })
})

describe("PATCH /api/conversations/[id] — body validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(makePatchRequest({ title: "x" }), paramsOf(VALID_UUID))
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest("{not json"), paramsOf(VALID_UUID))
    expect(res.status).toBe(400)
  })

  it("returns 400 when title is missing", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest({}), paramsOf(VALID_UUID))
    expect(res.status).toBe(400)
  })

  it("returns 400 when title trims to empty", async () => {
    mockAuthed()
    const res = await PATCH(
      makePatchRequest({ title: "   " }),
      paramsOf(VALID_UUID),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 when title is over 200 chars", async () => {
    mockAuthed()
    const res = await PATCH(
      makePatchRequest({ title: "x".repeat(201) }),
      paramsOf(VALID_UUID),
    )
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Transcript ordering.
//
// chat_messages.created_at defaults to now() — the TRANSACTION timestamp — so
// every row of a batch-inserted exchange shares it. With ties, ordering by
// created_at alone leaves the row order up to the server. The portal builder's
// checkpoint restore truncates a thread BY POSITION, and its DELETE orders by
// (created_at, id): if this read disagrees, the restore cuts different rows
// than the user saw and the removed messages come back on the next load.
// ---------------------------------------------------------------------------
describe("GET /api/conversations/[id] — transcript ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageOrderBy.length = 0
    mockAuthed()
  })

  it("orders messages by created_at then id, matching the truncate DELETE", async () => {
    const res = await GET(
      new Request(`https://app.example.dev/api/conversations/${VALID_UUID}`),
      paramsOf(VALID_UUID),
    )

    expect(res.status).toBe(200)
    expect(messageOrderBy).toEqual(["created_at", "id"])
  })
})
