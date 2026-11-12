/**
 * /api/workspace/kb-domain PUT and DELETE — auth, role, validation, and the
 * duplicate-domain 409 (Postgres 23505) path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { mockGetUser, mockSelectSingle, mockUpdateResult } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockSelectSingle: vi.fn(),
  mockUpdateResult: vi.fn(),
}))

// Chainable client: `.from().select().eq().single()` resolves the current
// settings; `.from().update().eq()` resolves the write result.
function makeFrom() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        single: mockSelectSingle,
      })),
    })),
    update: vi.fn(() => ({
      eq: mockUpdateResult,
    })),
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => makeFrom()),
  }),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { PUT, DELETE } from "./route"

function makePut(body: unknown): NextRequest {
  return new NextRequest("https://app.example.com/api/workspace/kb-domain", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function authAs(role: string): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "wm-1",
    workspace_id: "ws-1",
    role,
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: settings read succeeds with an empty object, write succeeds.
  mockSelectSingle.mockResolvedValue({ data: { settings: {} }, error: null })
  mockUpdateResult.mockResolvedValue({ error: null })
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN
})

describe("PUT /api/workspace/kb-domain", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await PUT(makePut({ domain: "docs.acme.com" }))
    expect(res.status).toBe(401)
  })

  it("returns 403 for a non-admin role", async () => {
    authAs("viewer")
    const res = await PUT(makePut({ domain: "docs.acme.com" }))
    expect(res.status).toBe(403)
  })

  it("returns 400 for malformed JSON", async () => {
    authAs("admin")
    const res = await PUT(makePut("{not json"))
    expect(res.status).toBe(400)
  })

  it("returns 400 for a syntactically invalid domain", async () => {
    authAs("admin")
    const res = await PUT(makePut({ domain: "not a domain" }))
    expect(res.status).toBe(400)
  })

  it("returns 400 when the domain is the app's own host", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com"
    authAs("owner")
    const res = await PUT(makePut({ domain: "app.example.com" }))
    expect(res.status).toBe(400)
  })

  it("saves a valid domain and echoes it back", async () => {
    authAs("admin")
    const res = await PUT(makePut({ domain: "DOCS.Acme.com" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kb_custom_domain: string }
    expect(body.kb_custom_domain).toBe("docs.acme.com")
  })

  it("returns 409 when the unique index rejects a duplicate domain", async () => {
    authAs("admin")
    mockUpdateResult.mockResolvedValue({ error: { code: "23505" } })
    const res = await PUT(makePut({ domain: "docs.acme.com" }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/already in use/i)
  })

  it("returns 500 on a non-unique write error", async () => {
    authAs("admin")
    mockUpdateResult.mockResolvedValue({ error: { code: "XX000" } })
    const res = await PUT(makePut({ domain: "docs.acme.com" }))
    expect(res.status).toBe(500)
  })
})

describe("DELETE /api/workspace/kb-domain", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await DELETE()
    expect(res.status).toBe(401)
  })

  it("returns 403 for a non-admin role", async () => {
    authAs("editor")
    const res = await DELETE()
    expect(res.status).toBe(403)
  })

  it("clears the domain and returns null", async () => {
    authAs("admin")
    mockSelectSingle.mockResolvedValue({
      data: { settings: { kb_custom_domain: "docs.acme.com" } },
      error: null,
    })
    const res = await DELETE()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kb_custom_domain: string | null }
    expect(body.kb_custom_domain).toBeNull()
  })
})
