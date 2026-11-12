/**
 * /api/workspace/api-keys/:id/rotate — access control and in-place reissue.
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
import { createAdminClient } from "@/lib/supabase/admin"
import { decryptToken } from "@/lib/security/token-crypto"
import { POST } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function call(id: string = VALID_UUID) {
  const request = new Request(
    `https://app.example.dev/api/workspace/api-keys/${id}/rotate`,
    { method: "POST" },
  )
  return POST(request, { params: Promise.resolve({ id }) })
}

function mockAuthed(role: string = "admin"): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "wm-1",
    workspace_id: "ws-1",
    role,
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
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

describe("POST /api/workspace/api-keys/:id/rotate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BREAD_TOKEN_ENC_KEY = Buffer.alloc(32, 5).toString("base64")
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    expect((await call()).status).toBe(401)
  })

  it("returns 403 for a non-admin member", async () => {
    mockAuthed("editor")
    expect((await call()).status).toBe(403)
  })

  it("returns 400 for a non-uuid id", async () => {
    mockAuthed()
    expect((await call("nope")).status).toBe(400)
  })

  it("returns a new secret whose stored hash and ciphertext both match it", async () => {
    mockAuthed()
    const { update } = mockUpdate({ data: { id: VALID_UUID }, error: null })

    const res = await call()
    const body = await res.json()
    expect(res.status).toBe(200)

    const [row] = update.mock.calls[0] as unknown as [
      { key_hash: string; key_encrypted: string; last_used_at: null },
    ]
    const { createHash } = await import("crypto")
    expect(row.key_hash).toBe(
      createHash("sha256").update(body.key).digest("hex"),
    )
    expect(decryptToken(row.key_encrypted)).toBe(body.key)
    // Usage history described the retired secret.
    expect(row.last_used_at).toBeNull()
  })

  it("does not touch name, role, scopes, or expiry", async () => {
    mockAuthed()
    const { update } = mockUpdate({ data: { id: VALID_UUID }, error: null })

    await call()

    const [row] = update.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(Object.keys(row).sort()).toEqual([
      "key_encrypted",
      "key_hash",
      "last_used_at",
    ])
  })

  it("scopes the update to the active workspace and 404s otherwise", async () => {
    mockAuthed()
    const { eqWorkspace } = mockUpdate({ data: null, error: null })

    const res = await call()

    expect(eqWorkspace).toHaveBeenCalledWith("workspace_id", "ws-1")
    expect(res.status).toBe(404)
  })

  it("makes a legacy key revealable by giving it fresh ciphertext", async () => {
    mockAuthed()
    const { update } = mockUpdate({ data: { id: VALID_UUID }, error: null })

    await call()

    const [row] = update.mock.calls[0] as unknown as [{ key_encrypted: string }]
    expect(row.key_encrypted).toEqual(expect.any(String))
  })
})
