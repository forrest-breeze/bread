/**
 * getActiveWorkspace() is the maybeSingle choke-point for workspace scoping (see
 * CLAUDE.md §"Workspace Scoping"). These tests pin its contract:
 *
 *   1. When a `breezify-workspace` cookie is present AND the user is a member,
 *      return that membership.
 *   2. When the cookie is present but the user is NOT a member, fall back to
 *      their first membership.
 *   3. When the cookie is absent, return the first membership.
 *   4. When the user has no memberships at all, return null.
 *   5. When a query FAILS (timeout/connection), throw — never coerce an error
 *      to null, or a transient DB blip masquerades as "no workspace" and the
 *      caller wrongly redirects to onboarding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockCookies } = vi.hoisted(() => ({
  mockCookies: vi.fn(),
}))

const { mockCreateAdminClient } = vi.hoisted(() => ({
  mockCreateAdminClient: vi.fn(),
}))

// Overrides the global setup mock so each test can control the cookie value.
vi.mock("next/headers", () => ({
  cookies: mockCookies,
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}))

import {
  countActiveMembers,
  getActiveWorkspace,
  getActiveWorkspaceForUser,
} from "@/lib/db/workspace"
import type { createClient } from "@/lib/supabase/server"

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

interface QueryChain {
  abortSignal: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  limit: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
}

/**
 * Returns a two-path Supabase client: the first `.from()` call yields a
 * builder that resolves to `preferredResult`, the second yields
 * `fallbackResult`. Matches the real code flow: try preferred, else fall
 * back.
 */
function makeSupabase(
  preferredResult: { data: unknown; error: unknown },
  fallbackResult: { data: unknown; error: unknown },
): { client: SupabaseClient; preferred: QueryChain; fallback: QueryChain } {
  function makeChain(result: { data: unknown; error: unknown }): QueryChain {
    const chain = {} as QueryChain
    chain.abortSignal = vi.fn(() => chain)
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    return chain
  }

  const preferred = makeChain(preferredResult)
  const fallback = makeChain(fallbackResult)
  const calls: QueryChain[] = [preferred, fallback]

  const from = vi.fn(() => {
    const next = calls.shift()
    if (!next) throw new Error("Unexpected extra supabase.from() call")
    return next
  })

  const client = { from } as unknown as SupabaseClient
  return { client, preferred, fallback }
}

function stubCookie(value: string | undefined): void {
  mockCookies.mockResolvedValue({
    get: vi.fn((_name: string) => (value === undefined ? undefined : { value })),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
  })
}

function stubActiveMemberCount(result: { count: number | null; error: { message: string } | null }): {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
} {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValueOnce(chain).mockResolvedValueOnce(result)

  mockCreateAdminClient.mockReturnValue({
    from: vi.fn(() => chain),
  })

  return chain
}

beforeEach(() => {
  mockCookies.mockReset()
  mockCreateAdminClient.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("getActiveWorkspace — cookie happy path", () => {
  it("returns the preferred workspace when the cookie matches a membership", async () => {
    const expected = { id: "wm-1", workspace_id: "ws-preferred", role: "admin" }
    stubCookie("ws-preferred")
    const { client, preferred, fallback } = makeSupabase(
      { data: expected, error: null },
      { data: null, error: null },
    )

    const result = await getActiveWorkspace(client, "user-1")

    expect(result).toEqual(expected)
    // Both eq calls happened on the preferred chain: user_id + workspace_id.
    expect(preferred.eq).toHaveBeenCalledWith("user_id", "user-1")
    expect(preferred.eq).toHaveBeenCalledWith("workspace_id", "ws-preferred")
    // Fallback chain was not touched.
    expect(fallback.maybeSingle).not.toHaveBeenCalled()
  })
})

describe("getActiveWorkspace — cookie miss, fall back", () => {
  it("returns the first membership when the cookie points at a workspace the user doesn't belong to", async () => {
    const fallbackRow = { id: "wm-2", workspace_id: "ws-fallback", role: "member" }
    stubCookie("ws-preferred")
    const { client, preferred, fallback } = makeSupabase(
      { data: null, error: null },
      { data: fallbackRow, error: null },
    )

    const result = await getActiveWorkspace(client, "user-1")

    expect(result).toEqual(fallbackRow)
    expect(preferred.maybeSingle).toHaveBeenCalled()
    expect(fallback.limit).toHaveBeenCalledWith(1)
    expect(preferred.abortSignal.mock.calls[0][0]).toBe(fallback.abortSignal.mock.calls[0][0])
  })
})

describe("getActiveWorkspace — no cookie", () => {
  it("returns the first membership without a preferred lookup", async () => {
    const fallbackRow = { id: "wm-3", workspace_id: "ws-only", role: "viewer" }
    stubCookie(undefined)
    // Without a cookie, the code skips the preferred branch entirely and
    // only makes one .from() call — the fallback. Queue the fallback row
    // in the *first* slot so that first call returns it.
    const { client, preferred, fallback } = makeSupabase(
      { data: fallbackRow, error: null },
      { data: null, error: null },
    )

    const result = await getActiveWorkspace(client, "user-1")

    expect(result).toEqual(fallbackRow)
    // `preferred` chain is the one we stashed data in (since only one
    // .from() call happens with no cookie). What we actually want to prove
    // is that the "fallback" chain — the unused one — was never touched.
    expect(fallback.maybeSingle).not.toHaveBeenCalled()
    expect(preferred.maybeSingle).toHaveBeenCalled()
  })
})

describe("getActiveWorkspace — no memberships", () => {
  it("returns null when the user has no rows (cookie absent)", async () => {
    stubCookie(undefined)
    const { client } = makeSupabase(
      { data: null, error: null },
      { data: null, error: null },
    )

    const result = await getActiveWorkspace(client, "user-1")

    expect(result).toBeNull()
  })
})

describe("getActiveWorkspace — query failure must throw (not null)", () => {
  it("throws when the fallback lookup errors (e.g. statement timeout)", async () => {
    stubCookie(undefined)
    const { client } = makeSupabase(
      { data: null, error: { message: "canceling statement due to statement timeout" } },
      { data: null, error: null },
    )

    // A transient DB failure must surface so callers do NOT treat it as
    // "no workspace" and bounce the user to onboarding.
    await expect(getActiveWorkspace(client, "user-1")).rejects.toThrow(
      /workspace lookup failed/,
    )
  })

  it("throws when the preferred lookup errors (before any fallback)", async () => {
    stubCookie("ws-preferred")
    const { client, fallback } = makeSupabase(
      { data: null, error: { message: "connection reset" } },
      { data: null, error: null },
    )

    await expect(getActiveWorkspace(client, "user-1")).rejects.toThrow(
      /workspace lookup failed/,
    )
    // It must not silently fall through to the fallback on a real error.
    expect(fallback.maybeSingle).not.toHaveBeenCalled()
  })
})

describe("getActiveWorkspaceForUser", () => {
  it("returns the cookie-selected active membership through the service-role client", async () => {
    const expected = { id: "wm-admin-1", workspace_id: "ws-preferred", role: "admin" }
    stubCookie("ws-preferred")
    const { client, preferred, fallback } = makeSupabase(
      { data: expected, error: null },
      { data: null, error: null },
    )
    mockCreateAdminClient.mockReturnValue(client)

    await expect(getActiveWorkspaceForUser("user-1")).resolves.toEqual(expected)

    expect(preferred.eq).toHaveBeenCalledWith("user_id", "user-1")
    expect(preferred.eq).toHaveBeenCalledWith("workspace_id", "ws-preferred")
    expect(preferred.eq).toHaveBeenCalledWith("status", "active")
    expect(fallback.maybeSingle).not.toHaveBeenCalled()
  })

  it("falls back to the first active membership when the cookie is stale", async () => {
    const expected = { id: "wm-admin-2", workspace_id: "ws-fallback", role: "member" }
    stubCookie("ws-stale")
    const { client, fallback } = makeSupabase(
      { data: null, error: null },
      { data: expected, error: null },
    )
    mockCreateAdminClient.mockReturnValue(client)

    await expect(getActiveWorkspaceForUser("user-1")).resolves.toEqual(expected)

    expect(fallback.eq).toHaveBeenCalledWith("status", "active")
    expect(fallback.limit).toHaveBeenCalledWith(1)
  })

  it("returns null when the user has no active memberships", async () => {
    stubCookie(undefined)
    const { client } = makeSupabase(
      { data: null, error: null },
      { data: null, error: null },
    )
    mockCreateAdminClient.mockReturnValue(client)

    await expect(getActiveWorkspaceForUser("user-1")).resolves.toBeNull()
  })

  it("throws on a preferred-membership query failure without falling back", async () => {
    stubCookie("ws-preferred")
    const { client, fallback } = makeSupabase(
      { data: null, error: { message: "service role timeout" } },
      { data: null, error: null },
    )
    mockCreateAdminClient.mockReturnValue(client)

    await expect(getActiveWorkspaceForUser("user-1")).rejects.toThrow(
      "workspace lookup failed: service role timeout",
    )
    expect(fallback.maybeSingle).not.toHaveBeenCalled()
  })

  it("throws on a fallback-membership query failure", async () => {
    stubCookie(undefined)
    const { client } = makeSupabase(
      { data: null, error: { message: "fallback timeout" } },
      { data: null, error: null },
    )
    mockCreateAdminClient.mockReturnValue(client)

    await expect(getActiveWorkspaceForUser("user-1")).rejects.toThrow(
      "workspace lookup failed: fallback timeout",
    )
  })
})

describe("countActiveMembers", () => {
  it("returns the active member count when the query succeeds", async () => {
    const query = stubActiveMemberCount({ count: 3, error: null })

    const result = await countActiveMembers("workspace-1")

    expect(result).toBe(3)
    expect(query.select).toHaveBeenCalledWith("id", { count: "exact", head: true })
    expect(query.eq).toHaveBeenCalledWith("workspace_id", "workspace-1")
    expect(query.eq).toHaveBeenCalledWith("status", "active")
  })

  it("returns zero when the active member count is missing", async () => {
    stubActiveMemberCount({ count: null, error: null })

    await expect(countActiveMembers("workspace-1")).resolves.toBe(0)
  })

  it("returns zero when the active member count is zero", async () => {
    stubActiveMemberCount({ count: 0, error: null })

    await expect(countActiveMembers("workspace-1")).resolves.toBe(0)
  })

  it("throws when the count query fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    stubActiveMemberCount({ count: null, error: { message: "database unavailable" } })

    await expect(countActiveMembers("workspace-1")).rejects.toThrow(
      "Failed to count active members: database unavailable",
    )
    expect(consoleError).toHaveBeenCalledWith("[Breezify] countActiveMembers:", "database unavailable")

    consoleError.mockRestore()
  })
})
