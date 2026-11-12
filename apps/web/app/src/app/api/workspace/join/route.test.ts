/**
 * /api/workspace/join POST/PUT/DELETE — input validation regression guards.
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

vi.mock("@/lib/billing/catalog", () => ({
  isBillingPlanId: vi.fn(() => true),
}))

vi.mock("@/lib/db/subscription", () => ({
  getWorkspaceSubscription: vi.fn(),
}))

vi.mock("@/lib/db/workspace", () => ({
  countActiveMembers: vi.fn(),
}))

vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: vi.fn(() => ({
    capture: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock("@/lib/workspace-settings", () => ({
  getAllowedDomains: vi.fn(() => []),
}))

import { createAdminClient } from "@/lib/supabase/admin"
import { GET, POST, PUT, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function makeRequest(method: "POST" | "PUT", body: unknown): NextRequest {
  return new NextRequest("https://app.example.dev/api/workspace/join", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function makeDeleteRequest(id?: string): NextRequest {
  const url = id
    ? `https://app.example.dev/api/workspace/join?id=${encodeURIComponent(id)}`
    : "https://app.example.dev/api/workspace/join"
  return new NextRequest(url, { method: "DELETE" })
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: "user-1",
        email: "u@example.com",
        user_metadata: {},
      },
    },
  })
}

function makeThenableQuery(
  table: string,
  resolveResult: (query: {
    table: string
    selectColumns: string
    filters: Array<[string, unknown]>
    containsFilter: unknown
    inFilter: unknown
  }) => unknown,
) {
  const query = {
    table,
    selectColumns: "",
    filters: [] as Array<[string, unknown]>,
    containsFilter: null as unknown,
    inFilter: null as unknown,
    select: vi.fn((columns: string) => {
      query.selectColumns = columns
      return query
    }),
    eq: vi.fn((column: string, value: unknown) => {
      query.filters.push([column, value])
      return query
    }),
    contains: vi.fn((_column: string, value: unknown) => {
      query.containsFilter = value
      return query
    }),
    in: vi.fn((_column: string, value: unknown) => {
      query.inFilter = value
      return query
    }),
    then: (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(resolveResult(query)).then(resolve, reject),
  }
  return query
}

describe("GET /api/workspace/join", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns domain workspaces excluding existing memberships", async () => {
    mockAuthed()
    const from = vi.fn((table: string) =>
      makeThenableQuery(table, (query) => {
        if (
          query.table === "workspace_members" &&
          query.selectColumns === "id, workspace_id, role, created_at"
        ) {
          return {
            data: [
              {
                id: "invite-1",
                workspace_id: "ws-invite",
                role: "viewer",
                created_at: "2026-05-29T00:00:00.000Z",
              },
            ],
          }
        }
        if (
          query.table === "workspace_members" &&
          query.selectColumns === "workspace_id"
        ) {
          return { data: [{ workspace_id: "ws-existing" }] }
        }
        if (query.table === "workspaces" && query.containsFilter) {
          return {
            data: [
              { id: "ws-existing", name: "Existing", icon_url: null },
              { id: "ws-domain", name: "Domain Match", icon_url: null },
            ],
          }
        }
        if (query.table === "workspaces" && query.inFilter) {
          return {
            data: [{ id: "ws-invite", name: "Invited", icon_url: null }],
          }
        }
        return { data: [] }
      }),
    )

    vi.mocked(createAdminClient).mockReturnValue({
      from,
    } as unknown as ReturnType<typeof createAdminClient>)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      pending_invites: [
        {
          id: "ws-invite",
          name: "Invited",
          icon_url: null,
          role: "viewer",
          invite_id: "invite-1",
        },
      ],
      domain_workspaces: [
        { id: "ws-domain", name: "Domain Match", icon_url: null },
      ],
    })
  })
})

describe("POST /api/workspace/join — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", "{not json"))
    expect(res.status).toBe(400)
  })

  it("returns 400 when both workspace_id and invite_code are missing", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", {}))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-uuid workspace_id", async () => {
    mockAuthed()
    const res = await POST(
      makeRequest("POST", { workspace_id: "not-a-uuid" }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for empty invite_code", async () => {
    mockAuthed()
    const res = await POST(makeRequest("POST", { invite_code: "" }))
    expect(res.status).toBe(400)
  })
})

describe("PUT /api/workspace/join — validation", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns 400 for missing invite_id", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", {}))
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-uuid invite_id", async () => {
    mockAuthed()
    const res = await PUT(makeRequest("PUT", { invite_id: "not-a-uuid" }))
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/workspace/join — validation", () => {
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
