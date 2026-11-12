/**
 * /api/conversations/[id]/feedback — POST (upsert rating) + DELETE (clear).
 *
 * Drives the route end-to-end at the application layer: auth gate, input
 * validation, ownership/target checks, and the exact row written on an upsert.
 * Supabase is mocked via the shared per-table builder helper.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeSupabaseClient, type SupabaseClientMock } from "@/test/helpers/supabase"

const h = vi.hoisted(() => ({ client: undefined as unknown as SupabaseClientMock }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => h.client),
}))

import { POST, DELETE } from "./route"

const CONV = "550e8400-e29b-41d4-a716-446655440000"
const MSG = "11111111-1111-4111-8111-111111111111"

function paramsOf(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function reqWith(method: "POST" | "DELETE", body: unknown): Request {
  return new Request(`https://app.example.dev/api/conversations/${CONV}/feedback`, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function authed(): void {
  h.client.auth.getUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com" } },
  })
}

/** Wire the conversation + message lookups to succeed for a valid target. */
function wireValidTarget(): void {
  h.client.builderFor("conversations").setResult({
    data: { id: CONV, workspace_id: "ws-1" },
  })
  h.client.builderFor("chat_messages").setResult({ data: { id: MSG } })
}

beforeEach(() => {
  h.client = makeSupabaseClient()
})

describe("POST /api/conversations/[id]/feedback", () => {
  it("returns 401 when unauthenticated", async () => {
    h.client.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(reqWith("POST", { message_id: MSG, rating: "up" }), paramsOf(CONV))
    expect(res.status).toBe(401)
  })

  it("returns 404 for a non-uuid conversation id", async () => {
    authed()
    const res = await POST(reqWith("POST", { message_id: MSG, rating: "up" }), paramsOf("nope"))
    expect(res.status).toBe(404)
  })

  it("returns 400 when message_id is missing", async () => {
    authed()
    const res = await POST(reqWith("POST", { rating: "up" }), paramsOf(CONV))
    expect(res.status).toBe(400)
  })

  it("returns 400 for an invalid rating value", async () => {
    authed()
    const res = await POST(reqWith("POST", { message_id: MSG, rating: "sideways" }), paramsOf(CONV))
    expect(res.status).toBe(400)
  })

  it("returns 400 for an invalid reason value", async () => {
    authed()
    const res = await POST(
      reqWith("POST", { message_id: MSG, rating: "down", reason: "made_up" }),
      paramsOf(CONV),
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 when the conversation is not the user's", async () => {
    authed()
    h.client.builderFor("conversations").setResult({ data: null })
    const res = await POST(reqWith("POST", { message_id: MSG, rating: "up" }), paramsOf(CONV))
    expect(res.status).toBe(404)
  })

  it("returns 404 when the message is not an assistant reply in the conversation", async () => {
    authed()
    h.client.builderFor("conversations").setResult({ data: { id: CONV, workspace_id: "ws-1" } })
    h.client.builderFor("chat_messages").setResult({ data: null })
    const res = await POST(reqWith("POST", { message_id: MSG, rating: "up" }), paramsOf(CONV))
    expect(res.status).toBe(404)
  })

  it("upserts a thumbs-up and clears any reason/comment", async () => {
    authed()
    wireValidTarget()
    const fb = h.client.builderFor("message_feedback")
    fb.setResult({ data: { id: "f1", rating: "up", reason: null, comment: null }, error: null })

    const res = await POST(
      // reason/comment sent on an "up" must be dropped server-side.
      reqWith("POST", { message_id: MSG, rating: "up", reason: "inaccurate", comment: "x" }),
      paramsOf(CONV),
    )

    expect(res.status).toBe(200)
    // The shared builder mock backs every chain method with one fn, so assert
    // on the call's arguments rather than a per-method count.
    expect(fb.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: MSG,
        conversation_id: CONV,
        workspace_id: "ws-1",
        user_id: "user-1",
        rating: "up",
        reason: null,
        comment: null,
      }),
      { onConflict: "message_id,user_id" },
    )
  })

  it("upserts a thumbs-down with its reason and comment", async () => {
    authed()
    wireValidTarget()
    const fb = h.client.builderFor("message_feedback")
    fb.setResult({
      data: { id: "f2", rating: "down", reason: "inaccurate", comment: "wrong" },
      error: null,
    })

    const res = await POST(
      reqWith("POST", {
        message_id: MSG,
        rating: "down",
        reason: "inaccurate",
        comment: "wrong",
      }),
      paramsOf(CONV),
    )

    expect(res.status).toBe(200)
    expect(fb.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        rating: "down",
        reason: "inaccurate",
        comment: "wrong",
      }),
      { onConflict: "message_id,user_id" },
    )
  })

  it("omits reason/comment on a bare thumbs-down so a stored explanation is preserved", async () => {
    authed()
    wireValidTarget()
    const fb = h.client.builderFor("message_feedback")
    fb.setResult({ data: { id: "f3", rating: "down", reason: null, comment: null }, error: null })

    // Bare downvote (popover just opened, no reason chosen) — must NOT clobber
    // any reason already stored from an earlier "Done".
    const res = await POST(reqWith("POST", { message_id: MSG, rating: "down" }), paramsOf(CONV))

    expect(res.status).toBe(200)
    const upsertCall = fb.upsert.mock.calls.find((c) => c[1] && c[1].onConflict)
    expect(upsertCall).toBeDefined()
    const payload = upsertCall![0]
    // Keys absent entirely → PostgREST leaves those columns untouched on conflict.
    expect(payload).not.toHaveProperty("reason")
    expect(payload).not.toHaveProperty("comment")
    expect(payload).toMatchObject({ rating: "down", message_id: MSG })
  })

  it("clears reason/comment when a downvote sends them as explicit null", async () => {
    authed()
    wireValidTarget()
    const fb = h.client.builderFor("message_feedback")
    fb.setResult({ data: { id: "f4", rating: "down", reason: null, comment: null }, error: null })

    // "Done" with the reason removed / comment emptied sends explicit null,
    // which must overwrite (not preserve) a previously stored explanation.
    const res = await POST(
      reqWith("POST", { message_id: MSG, rating: "down", reason: null, comment: null }),
      paramsOf(CONV),
    )

    expect(res.status).toBe(200)
    const upsertCall = fb.upsert.mock.calls.find((c) => c[1] && c[1].onConflict)
    expect(upsertCall).toBeDefined()
    const payload = upsertCall![0]
    expect(payload).toMatchObject({ rating: "down", reason: null, comment: null })
  })
})

describe("DELETE /api/conversations/[id]/feedback", () => {
  it("returns 401 when unauthenticated", async () => {
    h.client.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await DELETE(reqWith("DELETE", { message_id: MSG }), paramsOf(CONV))
    expect(res.status).toBe(401)
  })

  it("returns 400 when message_id is missing", async () => {
    authed()
    const res = await DELETE(reqWith("DELETE", {}), paramsOf(CONV))
    expect(res.status).toBe(400)
  })

  it("deletes only the caller's rating for the message", async () => {
    authed()
    const fb = h.client.builderFor("message_feedback")
    fb.setResult({ error: null })

    const res = await DELETE(reqWith("DELETE", { message_id: MSG }), paramsOf(CONV))

    expect(res.status).toBe(200)
    // Scoped to the caller's own row for the rated message.
    expect(fb.eq).toHaveBeenCalledWith("message_id", MSG)
    expect(fb.eq).toHaveBeenCalledWith("user_id", "user-1")
  })
})
