import { beforeEach, describe, expect, it, vi } from "vitest"

// Breeze internal tool: portal surfaces require a Breeze user. Default to an
// allowed caller; individual tests override to check the refusal.
const breezeGate = vi.hoisted(() => ({
  breezeOnlyResponse: vi.fn(async (): Promise<Response | null> => null),
  requireBreezeViewer: vi.fn(async () => ({ id: "u1", email: "u1@breeze.com" })),
}))
vi.mock("@/lib/auth/require-breeze", () => breezeGate)

// ---------------------------------------------------------------------------
// /api/public/llms — the text route behind <portal>/llms.txt.
//
// Guards the boundary, not the text shaping (see lib/portal/llms-txt.test.ts):
// unresolvable portals must 404 rather than render, the response must be
// text/plain, the full variant must go through the content read, and the links
// must be built from the PUBLIC mount the proxy forwarded.
// ---------------------------------------------------------------------------

const {
  mockResolvePortalBase,
  mockRateLimit,
  mockGetTaxonomy,
  mockGetDocuments,
  mockGetDocumentsWithContent,
  mockHeaders,
} = vi.hoisted(() => ({
  mockResolvePortalBase: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetTaxonomy: vi.fn(),
  mockGetDocuments: vi.fn(),
  mockGetDocumentsWithContent: vi.fn(),
  mockHeaders: vi.fn(),
}))

vi.mock("@/lib/public-kb", () => ({
  getPublicTaxonomy: mockGetTaxonomy,
  getPublicDocuments: mockGetDocuments,
  getPublicDocumentsWithContent: mockGetDocumentsWithContent,
}))

vi.mock("@/lib/public-kb-portal-base", () => ({
  resolvePortalBase: mockResolvePortalBase,
}))

vi.mock("@/lib/public-kb-ratelimit", () => ({
  checkPublicRateLimit: mockRateLimit,
}))

vi.mock("next/headers", () => ({ headers: mockHeaders }))

import { GET } from "./route"

const RESOLVED = {
  workspace: {
    id: "ws-1",
    name: "Acme",
    slug: "acme",
    branding: { name: "Acme Help", tagline: "Answers", logoUrl: "", accentColor: "#000" },
  },
  experienceId: null,
  scope: null,
  base: "acme/help",
}

const TAXONOMY = {
  topics: [],
  rootFolders: [
    {
      id: "f1",
      display_name: "Guides",
      kind: "user" as const,
      parent_folder_id: null,
      document_count: 1,
      sort_order: null,
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
}

const DOC = {
  id: "d1",
  slug: "install",
  title: "Install",
  source: null,
  folder_id: "f1",
  updated_at: "2026-07-20T10:00:00Z",
}

function request(query: string): Request {
  return new Request(`https://app.example.com/api/public/llms?${query}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRateLimit.mockResolvedValue(true)
  mockResolvePortalBase.mockResolvedValue(RESOLVED)
  mockGetTaxonomy.mockResolvedValue({ ...TAXONOMY, allFolders: TAXONOMY.rootFolders })
  mockGetDocuments.mockResolvedValue([DOC])
  mockGetDocumentsWithContent.mockResolvedValue([
    { ...DOC, content: "<p>Run it.</p>" },
  ])
  mockHeaders.mockResolvedValue(new Headers({ host: "app.example.com" }))
})

describe("GET /api/public/llms", () => {
  it("serves the index as text/plain", async () => {
    const res = await GET(request("portal=acme%2Fhelp"))

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(res.headers.get("cache-control")).toContain("s-maxage=300")
    const body = await res.text()
    expect(body).toContain("# Acme Help")
    expect(body).toContain("/p/acme/help/doc/install")
  })

  it("builds links from the public mount the proxy forwarded", async () => {
    mockHeaders.mockResolvedValue(
      new Headers({
        host: "app.example.com",
        "x-bread-proxy": "cloudflare-worker-v1",
        "x-forwarded-host": "customer.com",
        "x-bread-base-path": "/help",
      }),
    )

    const body = await (await GET(request("portal=acme%2Fhelp"))).text()

    expect(body).toContain("https://customer.com/help/doc/install")
    expect(body).not.toContain("/p/acme/help")
  })

  it("renders document bodies as markdown for the full variant", async () => {
    const body = await (
      await GET(request("portal=acme%2Fhelp&variant=full"))
    ).text()

    expect(mockGetDocumentsWithContent).toHaveBeenCalledWith("ws-1", null)
    expect(body).toContain("## Install")
    expect(body).toContain("Run it.")
    expect(body).not.toContain("<p>")
  })

  it("404s for a portal that does not resolve (private or unknown)", async () => {
    mockResolvePortalBase.mockResolvedValue(null)

    const res = await GET(request("portal=secret"))

    expect(res.status).toBe(404)
    expect(mockGetDocuments).not.toHaveBeenCalled()
  })

  it("404s on a missing or oversized portal param without touching the DB", async () => {
    const res = await GET(request("portal="))

    expect(res.status).toBe(404)
    expect(mockResolvePortalBase).not.toHaveBeenCalled()
  })

  it("429s when rate limited, before reading anything", async () => {
    mockRateLimit.mockResolvedValue(false)

    const res = await GET(request("portal=acme%2Fhelp"))

    expect(res.status).toBe(429)
    expect(mockResolvePortalBase).not.toHaveBeenCalled()
  })

  it("rate-limits the full variant harder than the index", async () => {
    await GET(request("portal=acme%2Fhelp"))
    const indexLimit = mockRateLimit.mock.calls[0][1]
    mockRateLimit.mockClear()

    await GET(request("portal=acme%2Fhelp&variant=full"))
    const fullLimit = mockRateLimit.mock.calls[0][1]

    expect(fullLimit).toBeLessThan(indexLimit)
  })

  it("treats an unknown variant as invalid rather than defaulting to full", async () => {
    const res = await GET(request("portal=acme%2Fhelp&variant=everything"))
    expect(res.status).toBe(404)
  })
})


describe("Breeze-only access", () => {
  it("refuses callers who are not signed-in Breeze users", async () => {
    breezeGate.breezeOnlyResponse.mockResolvedValueOnce(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    )
    const res = await GET(new Request("https://app.test/api/public/llms?workspace=acme") as never)
    expect(res.status).toBe(401)
  })
})
