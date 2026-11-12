import { describe, expect, it, vi, beforeEach } from "vitest"

// Build a chainable PostgREST-like query stub that ignores .eq()/.select() and
// resolves .maybeSingle() to the configured row. Captures the requested slug so
// the test can assert resolution keyed on slug.
function makeAdmin(rowForSlug: (slug: string) => unknown) {
  let capturedSlug = ""
  const requestedSlugs: string[] = []
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = vi.fn(chain)
  builder.eq = vi.fn((col: string, val: string) => {
    if (col === "slug") {
      capturedSlug = val
      requestedSlugs.push(val)
    }
    return builder
  })
  builder.maybeSingle = vi.fn(async () => ({
    data: rowForSlug(capturedSlug),
    error: null,
  }))
  return {
    from: vi.fn(() => builder),
    requestedSlugs,
  }
}

const PUBLISHED_ROW = {
  id: "f1e2d3c4-b5a6-4789-9012-3456789abcde",
  workspace_id: "d44b116a-99ce-4cbf-ab04-d395266d6a62",
  slug: "bread-help",
  scope: ["a992906c-d30d-498b-8c3a-1fd22e0bd397"],
  // Minimal valid PortalLayout (validatePortalLayout must accept it).
  spec: {
    schemaVersion: 1,
    theme: {
      brandName: "Bread Help Center",
      tagline: "",
      logoUrl: "",
      accentColor: "#2f5520",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
    },
    header: {
      id: "header",
      type: "portal-header",
      search: { enabled: true, placeholder: "Search or ask AI" },
    },
    body: [
      { id: "hero", type: "hero", placement: "full", heading: "How can we help?" },
    ],
  },
}

const adminMock = vi.hoisted(() => ({ current: null as unknown }))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminMock.current,
}))

vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn,
}))

import {
  resolveDefaultPublishedProjectByWorkspace,
  resolvePublishedProjectBySlug,
} from "@/lib/portal/experiences"

describe("resolvePublishedProjectBySlug", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("resolves a published project: workspace + scope + validated layout", async () => {
    adminMock.current = makeAdmin((slug) =>
      slug === "bread-help" ? PUBLISHED_ROW : null,
    )
    const project = await resolvePublishedProjectBySlug("bread-help")
    expect(project).not.toBeNull()
    expect(project?.experienceId).toBe("f1e2d3c4-b5a6-4789-9012-3456789abcde")
    expect(project?.workspaceId).toBe("d44b116a-99ce-4cbf-ab04-d395266d6a62")
    expect(project?.scope).toEqual(["a992906c-d30d-498b-8c3a-1fd22e0bd397"])
    expect(project?.layout).not.toBeNull()
  })

  it("returns null when no published project owns the slug (workspace fallback path)", async () => {
    adminMock.current = makeAdmin(() => null)
    expect(await resolvePublishedProjectBySlug("bread")).toBeNull()
  })

  it("returns a null layout (but still resolves the project) when the stored spec is invalid", async () => {
    adminMock.current = makeAdmin(() => ({
      ...PUBLISHED_ROW,
      spec: { schemaVersion: 1 }, // missing theme/header/body
    }))
    const project = await resolvePublishedProjectBySlug("bread-help")
    expect(project?.slug).toBe("bread-help")
    expect(project?.layout).toBeNull()
  })

  it("preserves an empty scope so a project with no remaining roots stays closed", async () => {
    adminMock.current = makeAdmin(() => ({ ...PUBLISHED_ROW, scope: [] }))
    const project = await resolvePublishedProjectBySlug("bread-help")
    expect(project?.scope).toEqual([])
  })

  it("preserves granular document scope metadata after publish", async () => {
    const rootId = "a992906c-d30d-498b-8c3a-1fd22e0bd397"
    const docId = "c992906c-d30d-498b-8c3a-1fd22e0bd399"
    const scope = [
      {
        id: rootId,
        promote: true,
        rootOnly: true,
        explicitDocs: true,
      },
      { doc: docId },
      { workspaceDocs: true },
    ]
    adminMock.current = makeAdmin(() => ({ ...PUBLISHED_ROW, scope }))

    const project = await resolvePublishedProjectBySlug("bread-help")

    expect(project?.scope).toEqual(scope)
  })
})

describe("resolveDefaultPublishedProjectByWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("prefers the canonical workspace-slug default project", async () => {
    const admin = makeAdmin((slug) =>
      slug === "bread"
        ? { ...PUBLISHED_ROW, slug: "bread", scope: null }
        : null,
    )
    adminMock.current = admin

    const project = await resolveDefaultPublishedProjectByWorkspace(
      "d44b116a-99ce-4cbf-ab04-d395266d6a62",
      "bread",
    )

    expect(project?.slug).toBe("bread")
    expect(admin.requestedSlugs).toEqual(["bread"])
  })

  it("falls back to the legacy docs slug for workspace-root routes", async () => {
    const admin = makeAdmin((slug) =>
      slug === "docs"
        ? { ...PUBLISHED_ROW, slug: "docs", scope: null }
        : null,
    )
    adminMock.current = admin

    const project = await resolveDefaultPublishedProjectByWorkspace(
      "d44b116a-99ce-4cbf-ab04-d395266d6a62",
      "bread",
    )

    expect(project?.slug).toBe("docs")
    expect(admin.requestedSlugs).toEqual(["bread", "docs"])
  })

  it("returns null when neither stored default project exists", async () => {
    const admin = makeAdmin(() => null)
    adminMock.current = admin

    await expect(
      resolveDefaultPublishedProjectByWorkspace(
        "d44b116a-99ce-4cbf-ab04-d395266d6a62",
        "bread",
      ),
    ).resolves.toBeNull()
    expect(admin.requestedSlugs).toEqual(["bread", "docs"])
  })

  it("ignores a stale primary-project setting: only the root and legacy docs slugs are tried", async () => {
    const admin = makeAdmin((slug) =>
      slug === "help" ? { ...PUBLISHED_ROW, slug: "help", scope: null } : null,
    )
    adminMock.current = admin

    await expect(
      resolveDefaultPublishedProjectByWorkspace("d44b116a-99ce-4cbf-ab04-d395266d6a62", "bread"),
    ).resolves.toBeNull()
    expect(admin.requestedSlugs).toEqual(["bread", "docs"])
  })
})
