/**
 * /api/workspace/api-keys POST/DELETE — input validation regression guards.
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
import { createAdminClient } from "@/lib/supabase/admin"
import { decryptToken } from "@/lib/security/token-crypto"
import { GET, POST, PATCH, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/workspace/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(id?: string): NextRequest {
  const url = id
    ? `https://app.example.dev/api/workspace/api-keys?id=${encodeURIComponent(id)}`
    : "https://app.example.dev/api/workspace/api-keys"
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

describe("POST /api/workspace/api-keys — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makePostRequest({}))
    expect(res.status).toBe(401)
  })

  it("returns 400 for empty trimmed name", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ name: "   " }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for name over 120 chars", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ name: "x".repeat(121) }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-string name", async () => {
    mockAuthed()
    const res = await POST(makePostRequest({ name: 42 as unknown as string }))
    expect(res.status).toBe(400)
  })

  it("returns 403 when the requested role exceeds the creator's role", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
    })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "wm-1",
      workspace_id: "ws-1",
      role: "editor",
    } as Awaited<ReturnType<typeof getActiveWorkspace>>)
    const res = await POST(makePostRequest({ name: "k", role: "admin" }))
    expect(res.status).toBe(403)
  })

  it("creates a key with role, scopes, and a TTL expiry", async () => {
    mockAuthed() // creator role = admin
    const single = vi.fn().mockResolvedValue({ data: { id: "key-1" }, error: null })
    const insert = vi.fn(() => ({ select: vi.fn(() => ({ single })) }))
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => ({ insert })),
    } as unknown as ReturnType<typeof createAdminClient>)

    const res = await POST(
      makePostRequest({ name: "k", role: "editor", ttl_days: 30 }),
    )
    expect(res.status).toBe(201)
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "editor",
        scopes: ["read"],
        expires_at: expect.any(String),
      }),
    )
  })

  it("stores an encrypted copy of the raw key so it can be revealed later", async () => {
    mockAuthed()
    process.env.BREEZIFY_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64")
    const single = vi.fn().mockResolvedValue({ data: { id: "key-3" }, error: null })
    const insert = vi.fn(() => ({ select: vi.fn(() => ({ single })) }))
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => ({ insert })),
    } as unknown as ReturnType<typeof createAdminClient>)

    const res = await POST(makePostRequest({ name: "k" }))
    const body = await res.json()
    expect(res.status).toBe(201)

    const [row] = insert.mock.calls[0] as unknown as [{ key_encrypted: string }]
    expect(row.key_encrypted).toEqual(expect.any(String))
    // Round-trips back to exactly the secret handed to the caller, and is not
    // the plaintext sitting in the column.
    expect(row.key_encrypted).not.toContain(body.key)
    expect(decryptToken(row.key_encrypted)).toBe(body.key)

    delete process.env.BREEZIFY_TOKEN_ENC_KEY
  })

  it("still creates the key when BREEZIFY_TOKEN_ENC_KEY is unset", async () => {
    mockAuthed()
    delete process.env.BREEZIFY_TOKEN_ENC_KEY
    const single = vi.fn().mockResolvedValue({ data: { id: "key-4" }, error: null })
    const insert = vi.fn(() => ({ select: vi.fn(() => ({ single })) }))
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => ({ insert })),
    } as unknown as ReturnType<typeof createAdminClient>)

    const res = await POST(makePostRequest({ name: "k" }))
    expect(res.status).toBe(201)
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ key_encrypted: null }),
    )
  })

  it("defaults to a viewer, read-only, never-expiring key", async () => {
    mockAuthed()
    const single = vi.fn().mockResolvedValue({ data: { id: "key-2" }, error: null })
    const insert = vi.fn(() => ({ select: vi.fn(() => ({ single })) }))
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => ({ insert })),
    } as unknown as ReturnType<typeof createAdminClient>)

    const res = await POST(makePostRequest({ name: "k" }))
    expect(res.status).toBe(201)
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "viewer",
        scopes: ["read"],
        expires_at: null,
      }),
    )
  })
})

describe("DELETE /api/workspace/api-keys — validation", () => {
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

describe("GET /api/workspace/api-keys — reveal metadata", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reports revealability without ever returning the ciphertext", async () => {
    mockAuthed()
    const order = vi.fn().mockResolvedValue({
      data: [
        { id: "key-1", name: "new", key_encrypted: "cipher-blob", created_at: "2026-08-19" },
        { id: "key-2", name: "legacy", key_encrypted: null, created_at: "2026-01-01" },
      ],
      error: null,
    })
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: vi.fn(() => ({ order })) })),
      })),
    } as unknown as ReturnType<typeof createAdminClient>)

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.keys[0]).toMatchObject({ id: "key-1", revealable: true })
    expect(body.keys[1]).toMatchObject({ id: "key-2", revealable: false })
    // The encrypted secret must not ride along in the list payload.
    expect(JSON.stringify(body)).not.toContain("cipher-blob")
    expect(body.keys[0]).not.toHaveProperty("key_encrypted")
  })
})

describe("PATCH /api/workspace/api-keys — rename", () => {
  beforeEach(() => vi.clearAllMocks())

  function makePatchRequest(id: string | undefined, body: unknown): NextRequest {
    const url = id
      ? `https://app.example.dev/api/workspace/api-keys?id=${id}`
      : "https://app.example.dev/api/workspace/api-keys"
    return new NextRequest(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function mockUpdate(result: { data: unknown; error: unknown }) {
    const maybeSingle = vi.fn().mockResolvedValue(result)
    const eqWorkspace = vi.fn(() => ({ select: vi.fn(() => ({ maybeSingle })) }))
    const update = vi.fn(() => ({ eq: vi.fn(() => ({ eq: eqWorkspace })) }))
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => ({ update })),
    } as unknown as ReturnType<typeof createAdminClient>)
    return { update, eqWorkspace }
  }

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(makePatchRequest(VALID_UUID, { name: "new" }))
    expect(res.status).toBe(401)
  })

  it("returns 403 for a non-admin member", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
    })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "wm-1",
      workspace_id: "ws-1",
      role: "editor",
    } as Awaited<ReturnType<typeof getActiveWorkspace>>)
    const res = await PATCH(makePatchRequest(VALID_UUID, { name: "new" }))
    expect(res.status).toBe(403)
  })

  it("returns 400 for a missing id", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest(undefined, { name: "new" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 for an empty trimmed name", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest(VALID_UUID, { name: "   " }))
    expect(res.status).toBe(400)
  })

  it("renames within the active workspace only", async () => {
    mockAuthed()
    const { update, eqWorkspace } = mockUpdate({ data: { id: VALID_UUID }, error: null })

    const res = await PATCH(makePatchRequest(VALID_UUID, { name: "  Cursor  " }))

    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledWith({ name: "Cursor" })
    expect(eqWorkspace).toHaveBeenCalledWith("workspace_id", "ws-1")
  })

  it("leaves role, scopes, and the secret untouched", async () => {
    mockAuthed()
    const { update } = mockUpdate({ data: { id: VALID_UUID }, error: null })

    await PATCH(makePatchRequest(VALID_UUID, { name: "renamed", role: "admin" }))

    // Only the name is writable — a rename must never widen a key's authority.
    expect(update).toHaveBeenCalledWith({ name: "renamed" })
  })

  it("returns 404 when the key belongs to another workspace", async () => {
    mockAuthed()
    mockUpdate({ data: null, error: null })
    const res = await PATCH(makePatchRequest(VALID_UUID, { name: "new" }))
    expect(res.status).toBe(404)
  })
})
