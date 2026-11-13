/**
 * /api/workspace/api-keys/:id/reveal — access control and recovery paths.
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
import { encryptToken } from "@/lib/security/token-crypto"
import { POST } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"
const ENC_KEY = Buffer.alloc(32, 3).toString("base64")

function makeRequest(): Request {
  return new Request(
    `https://app.example.dev/api/workspace/api-keys/${VALID_UUID}/reveal`,
    { method: "POST" },
  )
}

function call(id: string = VALID_UUID) {
  return POST(makeRequest(), { params: Promise.resolve({ id }) })
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

/** Stub the admin client's single-row lookup with a fixed result. */
function mockKeyRow(result: { data: unknown; error: unknown }): {
  eqWorkspace: ReturnType<typeof vi.fn>
} {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eqWorkspace = vi.fn(() => ({ maybeSingle }))
  vi.mocked(createAdminClient).mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: eqWorkspace })) })),
    })),
  } as unknown as ReturnType<typeof createAdminClient>)
  return { eqWorkspace }
}

describe("POST /api/workspace/api-keys/:id/reveal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.BREEZIFY_TOKEN_ENC_KEY = ENC_KEY
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
    expect((await call("not-a-uuid")).status).toBe(400)
  })

  it("scopes the lookup to the active workspace", async () => {
    mockAuthed()
    const { eqWorkspace } = mockKeyRow({ data: null, error: null })

    const res = await call()

    expect(eqWorkspace).toHaveBeenCalledWith("workspace_id", "ws-1")
    // A key belonging to another workspace is indistinguishable from a
    // nonexistent one.
    expect(res.status).toBe(404)
  })

  it("returns the decrypted secret", async () => {
    mockAuthed()
    const secret = "breezify_sk_abc123"
    mockKeyRow({ data: { key_encrypted: encryptToken(secret) }, error: null })

    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).key).toBe(secret)
  })

  it("returns 409 for a legacy key with no stored ciphertext", async () => {
    mockAuthed()
    mockKeyRow({ data: { key_encrypted: null }, error: null })

    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/can't be recovered/i)
  })

  it("returns 500 when the encryption key no longer decrypts the row", async () => {
    mockAuthed()
    const stale = encryptToken("breezify_sk_abc123")
    mockKeyRow({ data: { key_encrypted: stale }, error: null })
    process.env.BREEZIFY_TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString("base64")

    const res = await call()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/BREEZIFY_TOKEN_ENC_KEY/)
  })
})
