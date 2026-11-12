import { beforeEach, describe, expect, it, vi } from "vitest"

// Breeze internal tool: portal surfaces require a Breeze user. Default to an
// allowed caller; individual tests override to check the refusal.
const breezeGate = vi.hoisted(() => ({
  breezeOnlyResponse: vi.fn(async (): Promise<Response | null> => null),
  requireBreezeViewer: vi.fn(async () => ({ id: "u1", email: "u1@breeze.com" })),
}))
vi.mock("@/lib/auth/require-breeze", () => breezeGate)

const { mockIsDocInScope } = vi.hoisted(() => ({
  mockIsDocInScope: vi.fn(),
}))

vi.mock("@/lib/public-kb", () => ({
  isDocInScope: mockIsDocInScope,
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}))

import { GET, publiclyReferencesMedia } from "./route"

function query(
  result: { data: unknown; error: unknown },
  paginatedRows?: unknown[],
) {
  const chain: Record<string, any> = {}
  for (const method of [
    "select",
    "eq",
    "is",
    "in",
    "like",
    "limit",
    "neq",
    "order",
  ]) {
    chain[method] = vi.fn(() => chain)
  }
  let activeResult = result
  chain.range = vi.fn((from: number, to: number) => {
    activeResult = paginatedRows
      ? { data: paginatedRows.slice(from, to + 1), error: result.error }
      : result
    return chain
  })
  chain.then = vi.fn((onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(activeResult).then(onFulfilled),
  )
  return chain
}

function adminFor(input: {
  documents: Array<{ id: string; folder_id: string | null }>
  folders?: Array<{ id: string }>
  projects?: Array<{ scope: unknown; spec?: unknown }>
}) {
  const tables = {
    documents: query({ data: input.documents, error: null }, input.documents),
    folders: query({ data: input.folders ?? [], error: null }),
    workspace_experiences: query({
      data: input.projects ?? [],
      error: null,
    }),
  }
  return {
    from: vi.fn((table: keyof typeof tables) => tables[table]),
    tables,
  }
}

describe("public S3 media authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("allows media referenced by a visible document in a public project scope", async () => {
    const admin = adminFor({
      documents: [{ id: "doc-1", folder_id: "folder-1" }],
      folders: [{ id: "folder-1" }],
      projects: [{ scope: ["folder-1"] }],
    })
    mockIsDocInScope.mockResolvedValue(true)

    await expect(
      publiclyReferencesMedia(
        admin as any,
        "workspace-1",
        "media-1",
        false,
      ),
    ).resolves.toBe(true)
    expect(mockIsDocInScope).toHaveBeenCalledWith(
      "workspace-1",
      { id: "doc-1", folder_id: "folder-1" },
      ["folder-1"],
    )
  })

  it("allows media referenced only by a page-specific project scope", async () => {
    const homeFolderId = "11111111-1111-4111-8111-111111111111"
    const pageFolderId = "22222222-2222-4222-8222-222222222222"
    const admin = adminFor({
      documents: [{ id: "page-doc", folder_id: pageFolderId }],
      folders: [{ id: pageFolderId }],
      projects: [
        {
          scope: [homeFolderId],
          spec: {
            schemaVersion: 1,
            theme: {
              brandName: "Acme",
              tagline: "",
              logoUrl: "",
              accentColor: "#334455",
              navLinks: [],
              cta: null,
              font: "sans",
              appearance: "light",
            },
            header: {
              id: "header",
              type: "portal-header",
              search: { enabled: true, placeholder: "Search" },
            },
            body: [],
            pages: [
              {
                id: "page-releases",
                title: "Releases",
                slug: "releases",
                scope: [pageFolderId],
              },
            ],
          },
        },
      ],
    })
    mockIsDocInScope.mockResolvedValue(true)

    await expect(
      publiclyReferencesMedia(
        admin as any,
        "workspace-1",
        "media-1",
        false,
      ),
    ).resolves.toBe(true)
    expect(mockIsDocInScope).toHaveBeenCalledWith(
      "workspace-1",
      { id: "page-doc", folder_id: pageFolderId },
      [homeFolderId, pageFolderId],
    )
  })

  it("does not make an unreferenced media row public", async () => {
    const admin = adminFor({ documents: [] })

    await expect(
      publiclyReferencesMedia(
        admin as any,
        "workspace-1",
        "media-private",
        true,
      ),
    ).resolves.toBe(false)
    expect(admin.from).toHaveBeenCalledTimes(1)
  })

  it("rejects documents in hidden folders before evaluating project scope", async () => {
    const admin = adminFor({
      documents: [{ id: "doc-hidden", folder_id: "folder-hidden" }],
      folders: [],
      projects: [{ scope: null }],
    })

    await expect(
      publiclyReferencesMedia(
        admin as any,
        "workspace-1",
        "media-1",
        false,
      ),
    ).resolves.toBe(false)
    expect(mockIsDocInScope).not.toHaveBeenCalled()
  })

  it("supports legacy workspace-public portals for visible referenced docs", async () => {
    const admin = adminFor({
      documents: [{ id: "doc-1", folder_id: null }],
    })

    await expect(
      publiclyReferencesMedia(
        admin as any,
        "workspace-1",
        "media-1",
        true,
      ),
    ).resolves.toBe(true)
    expect(mockIsDocInScope).not.toHaveBeenCalled()
  })

  it("finds a visible reference after the first 100 candidates", async () => {
    const hiddenDocuments = Array.from({ length: 100 }, (_, index) => ({
      id: `doc-hidden-${String(index).padStart(3, "0")}`,
      folder_id: "folder-hidden",
    }))
    const admin = adminFor({
      documents: [
        ...hiddenDocuments,
        { id: "doc-visible", folder_id: null },
      ],
      folders: [],
    })

    await expect(
      publiclyReferencesMedia(
        admin as any,
        "workspace-1",
        "media-1",
        true,
      ),
    ).resolves.toBe(true)
    expect(admin.tables.documents.range).toHaveBeenNthCalledWith(1, 0, 99)
    expect(admin.tables.documents.range).toHaveBeenNthCalledWith(2, 100, 199)
  })

  it("fails closed when no public project serves the document", async () => {
    const admin = adminFor({
      documents: [{ id: "doc-1", folder_id: null }],
      projects: [{ scope: [] }],
    })
    mockIsDocInScope.mockResolvedValue(false)

    await expect(
      publiclyReferencesMedia(
        admin as any,
        "workspace-1",
        "media-1",
        false,
      ),
    ).resolves.toBe(false)
  })

  it("rejects malformed media ids before querying with the admin client", async () => {
    const response = await GET(new Request("https://app.example.com") as any, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    })

    expect(response.status).toBe(400)
  })
})


describe("Breeze-only access", () => {
  it("refuses callers who are not signed-in Breeze users", async () => {
    breezeGate.breezeOnlyResponse.mockResolvedValueOnce(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    )
    const res = await GET(new Request("https://app.test/api/public/media/x") as never, { params: Promise.resolve({ id: "x" }) } as never)
    expect(res.status).toBe(401)
  })
})
