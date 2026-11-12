/**
 * GET /api/search
 *
 * Behavioral contract:
 *   - 401 when unauthenticated.
 *   - 400 on missing query, or query > 200 chars (abuse cap on Gemini quota).
 *   - 200 always returns `{ knowledge: [...], settings: [...] }`.
 *   - No-workspace user: knowledge = [] (no pgvector call), settings still
 *     computed from the in-process catalog.
 *   - Embedding failure: knowledge = [], settings keyword-only (graceful
 *     degradation rather than 500 — settings often catches the user's intent
 *     even when Gemini is down).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeEmptyRequest } from "@/test/helpers"

const {
  mockGetUser,
  mockRpc,
  mockGenerateEmbedding,
  mockIsWorkspaceOnPaidTier,
  mockFrom,
  titleQuery,
} =
  vi.hoisted(() => ({
    mockFrom: vi.fn(),
    titleQuery: {
      result: { data: [] as unknown[], error: null as { message: string } | null },
      calls: [] as Array<[string, ...unknown[]]>,
    },
    mockGetUser: vi.fn(),
    mockRpc: vi.fn(),
    mockGenerateEmbedding: vi.fn(),
    mockIsWorkspaceOnPaidTier: vi.fn(),
  }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: mockFrom,
  }),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock("@/lib/db/subscription", () => ({
  isWorkspaceOnPaidTier: mockIsWorkspaceOnPaidTier,
}))

vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: mockGenerateEmbedding,
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { GET } from "./route"

beforeEach(() => {
  mockGetUser.mockReset()
  mockRpc.mockReset()
  mockGenerateEmbedding.mockReset()
  mockIsWorkspaceOnPaidTier.mockReset()
  mockIsWorkspaceOnPaidTier.mockResolvedValue(true)
  vi.mocked(getActiveWorkspace).mockReset()
  mockRpc.mockResolvedValue({ data: [], error: null })
  titleQuery.result = { data: [], error: null }
  titleQuery.calls = []
  mockFrom.mockReset()
  mockFrom.mockImplementation((table: string) => {
    titleQuery.calls.push(["from", table])
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(titleQuery.result).then(resolve, reject),
    }
    for (const method of ["select", "eq", "is", "ilike", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => {
        titleQuery.calls.push([method, ...args])
        return builder
      }
    }
    return builder
  })
})

/** Paid path: match_documents returns `result`; grep_documents returns []. */
function mockMatchDocuments(result: { data: unknown; error: unknown }) {
  mockRpc.mockImplementation(async (name: string) =>
    name === "match_documents" ? result : { data: [], error: null },
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

function searchUrl(params: Record<string, string>): string {
  const url = new URL("https://app.example.dev/api/search")
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

// ---------------------------------------------------------------------------
// Auth + input validation
// ---------------------------------------------------------------------------

describe("GET /api/search — auth + validation", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const req = makeEmptyRequest({ url: searchUrl({ q: "deploy" }) })
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it("returns 400 when query parameter is missing", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "admin",
    })
    const req = makeEmptyRequest({
      url: "https://app.example.dev/api/search",
    })
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it("returns 400 when the query is whitespace-only", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "admin",
    })
    const req = makeEmptyRequest({ url: searchUrl({ q: "    " }) })
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it("returns 400 when query exceeds 200 characters (Gemini quota guard)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "admin",
    })
    const req = makeEmptyRequest({ url: searchUrl({ q: "x".repeat(201) }) })
    const res = await GET(req)
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Successful path: knowledge + settings together
// ---------------------------------------------------------------------------

describe("GET /api/search — combined knowledge + settings response", () => {
  it("returns { knowledge, settings } with both populated when everything works", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "admin",
    })
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.01))
    mockMatchDocuments({
      data: [
        { id: "doc-1", title: "Deploy guide", similarity: 0.91 },
      ],
      error: null,
    })

    const req = makeEmptyRequest({ url: searchUrl({ q: "openapi" }) })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      knowledge: unknown[]
      settings: { id: string }[]
    }
    expect(body.knowledge).toHaveLength(1)
    expect(body.settings.length).toBeGreaterThan(0)
    // 'openapi' as a query should hit the OpenAPI integration via keyword.
    expect(body.settings.some((s) => s.id === "integrations.openapi")).toBe(true)
  })

  it("settings are still computed when the user has no workspace (knowledge degrades)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue(null)

    const req = makeEmptyRequest({ url: searchUrl({ q: "dark" }) })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      knowledge: unknown[]
      settings: { id: string }[]
    }
    expect(body.knowledge).toEqual([])
    expect(body.settings.some((s) => s.id === "preferences")).toBe(true)
    // Embedding generation must NOT have been attempted — no workspace means
    // no knowledge call, and settings hits via the keyword path alone.
    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it("falls back to keyword-only settings when embedding generation fails", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "admin",
    })
    mockGenerateEmbedding.mockRejectedValue(new Error("Gemini quota exhausted"))

    const req = makeEmptyRequest({ url: searchUrl({ q: "openapi" }) })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      knowledge: unknown[]
      settings: { id: string }[]
    }
    expect(body.knowledge).toEqual([])
    // Keyword path on 'openapi' still finds integrations.openapi.
    expect(body.settings.some((s) => s.id === "integrations.openapi")).toBe(true)
    expect(mockRpc).not.toHaveBeenCalledWith("match_documents", expect.anything())
  })

  it("returns knowledge=[] but still surfaces settings when pgvector errors", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "admin",
    })
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.01))
    mockMatchDocuments({
      data: null,
      error: { message: "vector lookup failed" },
    })

    const req = makeEmptyRequest({ url: searchUrl({ q: "openapi" }) })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      knowledge: unknown[]
      settings: { id: string }[]
    }
    expect(body.knowledge).toEqual([])
    expect(body.settings.some((s) => s.id === "integrations.openapi")).toBe(true)
  })

  it("uses keyword-only knowledge search for free workspaces", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "viewer",
    })
    mockIsWorkspaceOnPaidTier.mockResolvedValue(false)
    mockRpc.mockResolvedValue({
      data: [
        {
          document_id: "doc-1",
          title: "Deploy guide",
          line_number: 12,
          line_text: "Use keyword search on the Free plan.",
        },
      ],
      error: null,
    })

    const req = makeEmptyRequest({ url: searchUrl({ q: "keyword" }) })
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      knowledge: Array<{ id: string; title: string; content: string }>
      settings: { id: string }[]
    }
    expect(body.knowledge).toEqual([
      {
        id: "doc-1",
        title: "Deploy guide",
        content: "Use keyword search on the Free plan.",
      },
    ])
    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith("grep_documents", {
      p_workspace_id: "w-1",
      p_pattern: "keyword",
      p_is_regex: false,
      p_max_results: 5,
      p_max_per_doc: 1,
      p_caller_role: "viewer",
    })
  })

  it.each([true, false])(
    "matches documents by title substring (paid=%s), even when vector and grep miss",
    async (paid) => {
      mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
      vi.mocked(getActiveWorkspace).mockResolvedValue({
        id: "m-1",
        workspace_id: "w-1",
        role: "admin",
      })
      mockIsWorkspaceOnPaidTier.mockResolvedValue(paid)
      mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.01))
      titleQuery.result = {
        data: [
          { id: "doc-2", title: "Getting quick wins", updated_at: "2026-11-10" },
          { id: "doc-1", title: "Quick Start", updated_at: "2026-11-01" },
        ],
        error: null,
      }

      const res = await GET(makeEmptyRequest({ url: searchUrl({ q: "quick" }) }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { knowledge: Array<{ id: string }> }
      // Prefix match ranks first.
      expect(body.knowledge.map((k) => k.id)).toEqual(["doc-1", "doc-2"])
      expect(titleQuery.calls).toContainEqual(["from", "documents"])
      expect(titleQuery.calls).toContainEqual(["eq", "workspace_id", "w-1"])
      expect(titleQuery.calls).toContainEqual(["is", "deleted_at", null])
      expect(titleQuery.calls).toContainEqual(["ilike", "title", "%quick%"])
    },
  )

  it("escapes LIKE wildcards in the title query", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "admin",
    })
    mockIsWorkspaceOnPaidTier.mockResolvedValue(false)

    await GET(makeEmptyRequest({ url: searchUrl({ q: "100%_done" }) }))
    expect(titleQuery.calls).toContainEqual(["ilike", "title", "%100\\%\\_done%"])
  })

  it("merges title, vector and content hits without duplicates, capped at limit", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u-1" } } })
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "m-1",
      workspace_id: "w-1",
      role: "admin",
    })
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.01))
    titleQuery.result = { data: [{ id: "doc-t", title: "Deploy" }], error: null }
    mockRpc.mockImplementation(async (name: string) =>
      name === "match_documents"
        ? { data: [{ id: "doc-t", title: "Deploy" }, { id: "doc-v", title: "V" }], error: null }
        : {
            data: [
              { document_id: "doc-v", title: "V", line_number: 1, line_text: "x" },
              { document_id: "doc-g", title: "G", line_number: 1, line_text: "deploy" },
              { document_id: "doc-h", title: "H", line_number: 1, line_text: "deploy" },
            ],
            error: null,
          },
    )

    const res = await GET(
      makeEmptyRequest({ url: searchUrl({ q: "deploy", limit: "3" }) }),
    )
    const body = (await res.json()) as { knowledge: Array<{ id: string }> }
    expect(body.knowledge.map((k) => k.id)).toEqual(["doc-t", "doc-v", "doc-g"])
  })
})
