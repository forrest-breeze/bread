import { beforeEach, describe, expect, it, vi } from "vitest"
import { PORTAL_SCHEMA_VERSION, type PortalLayout } from "./schema"

// ---------------------------------------------------------------------------
// createPortalProject + icon defaulting.
//
// createPortalProject runs: workspaces lookup -> slug-clash check ->
// scope-folder validation -> scoped public-KB read (buildPortalLayoutForTemplate)
// -> draft insert. We stub the admin client per-table and stub the public-KB
// read so the test stays focused on the validation + insert contract.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: hoisted.createAdminClient,
}))

vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...args: A) => R) => fn,
  revalidateTag: vi.fn(),
}))

vi.mock("@/lib/public-kb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/public-kb")>()
  return {
    ...actual,
    getPublicTaxonomy: vi.fn(async () => ({ rootFolders: [] })),
    getRootPublicDocuments: vi.fn(async () => []),
    getPublicTaxonomyFresh: vi.fn(async () => ({ rootFolders: [] })),
    getPublicDocumentsFresh: vi.fn(async () => []),
  }
})

vi.mock("@/lib/workspace-settings", () => ({
  getKbBranding: () => ({
    name: "Acme",
    tagline: "",
    logoUrl: "",
    accentColor: "#2f5520",
  }),
  getKbPrimaryProject: () => null,
  getKbFooter: () => null,
  getKbHeader: () => null,
  getPortalChromeScope: () => "workspace",
}))

import {
  saveDraft,
  createPortalProject,
  DEFAULT_PROJECT_ICON,
  listPortalProjects,
  updatePortalProjectPath,
  getDraftOrSynthesize,
  getOrCreateDraft,
  publishDefaultPortalProject,
} from "./experiences-write"

const WORKSPACE_ID = "d44b116a-99ce-4cbf-ab04-d395266d6a62"
const WORKSPACE_SLUG = "acme"

function validSpec(icon?: string): PortalLayout {
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    theme: {
      brandName: "Acme",
      tagline: "",
      logoUrl: "",
      accentColor: "#2f5520",
      ...(icon ? { icon } : {}),
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
    body: [{ id: "hero", type: "hero", placement: "full", heading: "Hi" }],
    footer: { id: "footer", type: "footer", showPoweredBy: true },
  }
}

// Per-table chainable builder. `slugRowExists` controls whether the
// workspace_experiences slug-clash probe finds a row.
function mockAdmin(opts: {
  workspaceSlug?: string | null
  slugRowExists: boolean
  captureInsert?: (row: Record<string, unknown>) => void
}): void {
  const workspaceBuilder = {
    select: vi.fn(() => workspaceBuilder),
    eq: vi.fn(() => workspaceBuilder),
    maybeSingle: vi.fn(async () => ({
      data: opts.workspaceSlug === null
        ? null
        : {
            id: WORKSPACE_ID,
            name: "Acme",
            slug: opts.workspaceSlug ?? WORKSPACE_SLUG,
            icon_url: null,
            settings: {},
          },
      error: null,
    })),
  }

  const insertedRow = {
    id: "new-row",
    workspace_id: WORKSPACE_ID,
    kind: "kb",
    status: "draft",
    version: 1,
    slug: "guides",
    scope: null,
    audience: "public",
    spec: validSpec("📚"),
    name: "Guides",
    created_by: "user-1",
    published_by: null,
    created_at: "now",
    updated_at: "now",
  }

  const expBuilder: Record<string, unknown> = {}
  expBuilder.select = vi.fn(() => expBuilder)
  expBuilder.eq = vi.fn(() => expBuilder)
  expBuilder.in = vi.fn(() => expBuilder)
  expBuilder.limit = vi.fn(() => expBuilder)
  expBuilder.maybeSingle = vi.fn(async () => ({
    data: opts.slugRowExists ? { id: "existing" } : null,
    error: null,
  }))
  expBuilder.insert = vi.fn((row: Record<string, unknown>) => {
    opts.captureInsert?.(row)
    return {
      select: vi.fn(() => ({
        single: vi.fn(async () => ({ data: insertedRow, error: null })),
      })),
    }
  })

  const foldersBuilder = {
    select: vi.fn(() => foldersBuilder),
    eq: vi.fn(() => foldersBuilder),
    in: vi.fn(async () => ({ data: [], error: null })),
  }

  hoisted.createAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === "workspaces") return workspaceBuilder
      if (table === "folders") return foldersBuilder
      return expBuilder
    }),
  })
}

describe("DEFAULT_PROJECT_ICON", () => {
  it("is the docs emoji", () => {
    expect(DEFAULT_PROJECT_ICON).toBe("📚")
  })
})

describe("createPortalProject", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("creates a draft (version 1) and stamps the default icon", async () => {
    let captured: Record<string, unknown> | null = null
    mockAdmin({
      slugRowExists: false,
      captureInsert: (row) => {
        captured = row
      },
    })

    const row = await createPortalProject(WORKSPACE_ID, "user-1", {
      slug: "guides",
      name: "Guides",
    })

    expect(row.status).toBe("draft")
    expect(row.version).toBe(1)
    expect(captured).not.toBeNull()
    const insert = captured as unknown as {
      status: string
      version: number
      slug: string
      name: string
      spec: PortalLayout
    }
    expect(insert.status).toBe("draft")
    expect(insert.version).toBe(1)
    // One portal per workspace at the root: the suggested slug is ignored.
    expect(insert.slug).toBe(WORKSPACE_SLUG)
    expect(insert.name).toBe("Guides")
    expect(insert.spec.theme.icon).toBe("📚")
  })

  it("preserves an intentionally empty scope instead of widening to the workspace", async () => {
    let captured: Record<string, unknown> | null = null
    mockAdmin({
      slugRowExists: false,
      captureInsert: (row) => {
        captured = row
      },
    })

    await createPortalProject(WORKSPACE_ID, "user-1", {
      slug: "guides",
      name: "Guides",
      scope: [],
    })

    expect(captured).toEqual(expect.objectContaining({ scope: [] }))
  })

  it("rejects a slug already taken by an existing project", async () => {
    mockAdmin({ slugRowExists: true })
    await expect(
      createPortalProject(WORKSPACE_ID, "user-1", {
        slug: "guides",
        name: "Guides",
      }),
    ).rejects.toThrow(/already taken/)
  })

  it("creates the portal at the workspace root whatever slug the client suggests", async () => {
    let captured: Record<string, unknown> | null = null
    mockAdmin({
      workspaceSlug: WORKSPACE_SLUG,
      slugRowExists: false,
      captureInsert: (row) => {
        captured = row
      },
    })
    await createPortalProject(WORKSPACE_ID, "user-1", { slug: "breeze-8tfg", name: "Docs" })
    expect((captured as unknown as { slug: string }).slug).toBe(WORKSPACE_SLUG)
  })

  it("rejects a malformed slug before touching the database", async () => {
    mockAdmin({ slugRowExists: false })
    await expect(
      createPortalProject(WORKSPACE_ID, "user-1", {
        slug: "Bad Slug!",
        name: "X",
      }),
    ).rejects.toThrow(/invalid project slug/)
  })
})

describe("listPortalProjects icon defaulting", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  function mockList(rows: Array<Record<string, unknown>>): void {
    const workspaceBuilder = {
      select: vi.fn(() => workspaceBuilder),
      eq: vi.fn(() => workspaceBuilder),
      maybeSingle: vi.fn(async () => ({
        data: { slug: WORKSPACE_SLUG, name: "Acme" },
        error: null,
      })),
    }
    const expBuilder = {
      select: vi.fn(() => expBuilder),
      eq: vi.fn(() => expBuilder),
      order: vi.fn(async () => ({ data: rows, error: null })),
    }
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "workspaces" ? workspaceBuilder : expBuilder,
      ),
    })
  }

  it("uses spec.theme.icon when present, else the default", async () => {
    mockList([
      {
        id: "experience-id-1",
        slug: "help",
        scope: null,
        status: "published",
        version: 1,
        name: "Help",
        spec: validSpec("🚀"),
        updated_at: "now",
      },
      {
        id: "experience-id-2",
        slug: "guides",
        scope: null,
        status: "published",
        version: 1,
        name: "Guides",
        spec: validSpec(), // no icon -> default
        updated_at: "now",
      },
    ])

    const projects = await listPortalProjects(WORKSPACE_ID)
    const help = projects.find((p) => p.slug === "help")
    const guides = projects.find((p) => p.slug === "guides")
    expect(help?.icon).toBe("🚀")
    expect(guides?.icon).toBe("📚")
    expect(projects.find((p) => p.slug === WORKSPACE_SLUG)).toBeUndefined()
  })

  it("synthesizes the root project only when no projects exist", async () => {
    mockList([])

    const projects = await listPortalProjects(WORKSPACE_ID)
    expect(projects).toHaveLength(1)
    expect(projects[0]?.slug).toBe(WORKSPACE_SLUG)
    expect(projects[0]?.icon).toBe("📚")
  })
})

describe("updatePortalProjectPath", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  function mockPathAdmin(opts: {
    knownSlugs: string[]
    captureUpdate?: (input: { patch: Record<string, unknown>; whereSlug: string }) => void
  }): void {
    const known = new Set(opts.knownSlugs)

    const workspaceBuilder = {
      select: vi.fn(() => workspaceBuilder),
      eq: vi.fn(() => workspaceBuilder),
      maybeSingle: vi.fn(async () => ({
        data: { slug: WORKSPACE_SLUG },
        error: null,
      })),
    }

    let selectedSlug = ""
    const selectBuilder = {
      select: vi.fn(() => selectBuilder),
      eq: vi.fn((column: string, value: string) => {
        if (column === "slug") selectedSlug = value
        return selectBuilder
      }),
      limit: vi.fn(() => selectBuilder),
      maybeSingle: vi.fn(async () => ({
        data: known.has(selectedSlug) ? { id: `row-${selectedSlug}` } : null,
        error: null,
      })),
    }

    let updateWhereSlug = ""
    let updatePatch: Record<string, unknown> = {}
    const updateBuilder = {
      eq: vi.fn((column: string, value: string) => {
        if (column === "slug") updateWhereSlug = value
        return updateBuilder
      }),
      select: vi.fn(async () => {
        opts.captureUpdate?.({ patch: updatePatch, whereSlug: updateWhereSlug })
        return {
          data: known.has(updateWhereSlug) ? [{ id: "draft" }, { id: "published" }] : [],
          error: null,
        }
      }),
    }

    const expBuilder = {
      ...selectBuilder,
      update: vi.fn((patch: Record<string, unknown>) => {
        updatePatch = patch
        return updateBuilder
      }),
    }

    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "workspaces" ? workspaceBuilder : expBuilder,
      ),
    })
  }

  it("renames a named project's slug across stored rows", async () => {
    const captured: Array<{ patch: Record<string, unknown>; whereSlug: string }> = []
    mockPathAdmin({
      knownSlugs: ["help"],
      captureUpdate: (input) => {
        captured.push(input)
      },
    })

    await expect(
      updatePortalProjectPath(WORKSPACE_ID, {
        currentSlug: "help",
        slug: "support",
      }),
    ).resolves.toEqual({ previousSlug: "help", slug: "support" })

    expect(captured[0]).toEqual({
      patch: expect.objectContaining({ slug: "support" }),
      whereSlug: "help",
    })
  })

  it("refuses to move the root portal off the workspace root", async () => {
    mockPathAdmin({ knownSlugs: [WORKSPACE_SLUG] })
    await expect(
      updatePortalProjectPath(WORKSPACE_ID, {
        currentSlug: WORKSPACE_SLUG,
        slug: "docs",
      }),
    ).rejects.toThrow(/lives at the workspace root/)
  })

  it("rejects a suffix equal to the workspace slug because it resolves as root", async () => {
    mockPathAdmin({ knownSlugs: ["help"] })
    await expect(
      updatePortalProjectPath(WORKSPACE_ID, {
        currentSlug: "help",
        slug: WORKSPACE_SLUG,
      }),
    ).rejects.toThrow(/reserved for the default project/)
  })

  it("rejects a suffix already used by another project in the workspace", async () => {
    mockPathAdmin({ knownSlugs: ["help", "docs"] })
    await expect(
      updatePortalProjectPath(WORKSPACE_ID, {
        currentSlug: "help",
        slug: "docs",
      }),
    ).rejects.toThrow(/already taken/)
  })
})

describe("getDraftOrSynthesize", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("returns existing draft row when present", async () => {
    const mockDraftRow = {
      id: "draft-id-123",
      workspace_id: WORKSPACE_ID,
      slug: "help",
      status: "draft",
      scope: null,
      spec: validSpec(),
    }

    const expBuilder = {
      select: vi.fn(() => expBuilder),
      eq: vi.fn(() => expBuilder),
      order: vi.fn(() => expBuilder),
      limit: vi.fn(() => expBuilder),
      maybeSingle: vi.fn(async () => ({ data: mockDraftRow, error: null })),
    }

    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn(() => expBuilder),
    })

    const result = await getDraftOrSynthesize(WORKSPACE_ID, "help")
    expect(result.id).toBe("draft-id-123")
    expect(result.status).toBe("draft")
  })

  it("synthesizes an in-memory draft with id empty string if no database row exists", async () => {
    const workspaceBuilder = {
      select: vi.fn(() => workspaceBuilder),
      eq: vi.fn(() => workspaceBuilder),
      maybeSingle: vi.fn(async () => ({ data: { slug: WORKSPACE_SLUG }, error: null })),
    }

    const expBuilder = {
      select: vi.fn(() => expBuilder),
      eq: vi.fn(() => expBuilder),
      order: vi.fn(() => expBuilder),
      limit: vi.fn(() => expBuilder),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    }

    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table) => (table === "workspaces" ? workspaceBuilder : expBuilder)),
    })

    const result = await getDraftOrSynthesize(WORKSPACE_ID, "help")
    expect(result.id).toBe("")
    expect(result.status).toBe("draft")
    expect(result.slug).toBe("help")
  })
})

// ---------------------------------------------------------------------------
// Slug-less writes must target the workspace's default project as the builder
// sees it — never conjure a phantom root project once the root has been moved
// to a suffix. Regression for the "Bread keeps getting recreated" bug.
// ---------------------------------------------------------------------------

type FakeRow = Record<string, unknown>

// Generic in-memory workspace_experiences table: every `.eq()` narrows, `.order`
// sorts by version desc, the builder is awaitable (list reads) and exposes
// `maybeSingle` (row reads). Inserts are captured and appended.
function mockFilteringAdmin(
  rows: FakeRow[],
  beforeInsert?: (row: FakeRow) => { code: string; message: string } | null,
): {
  inserts: FakeRow[]
} {
  const inserts: FakeRow[] = []
  const workspaceBuilder = {
    select: vi.fn(() => workspaceBuilder),
    eq: vi.fn(() => workspaceBuilder),
    maybeSingle: vi.fn(async () => ({
      data: { id: WORKSPACE_ID, name: "Acme", slug: WORKSPACE_SLUG, settings: {} },
      error: null,
    })),
  }
  const foldersBuilder = {
    select: vi.fn(() => foldersBuilder),
    eq: vi.fn(() => foldersBuilder),
    in: vi.fn(async () => ({ data: [], error: null })),
  }
  function makeQuery(): Record<string, unknown> {
    let filters: Array<[string, unknown]> = []
    let sorted = false
    const q: Record<string, unknown> = {}
    const result = (): FakeRow[] => {
      let out = rows.filter((r) => filters.every(([k, v]) => r[k] === v))
      if (sorted) {
        out = [...out].sort(
          (a, b) => (b.version as number) - (a.version as number),
        )
      }
      return out
    }
    q.select = vi.fn(() => {
      filters = []
      return q
    })
    q.eq = vi.fn((k: string, v: unknown) => {
      filters.push([k, v])
      return q
    })
    q.order = vi.fn(() => {
      sorted = true
      return q
    })
    q.limit = vi.fn(() => q)
    q.maybeSingle = vi.fn(async () => ({ data: result()[0] ?? null, error: null }))
    q.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: result(), error: null }).then(resolve)
    q.insert = vi.fn((row: FakeRow) => {
      const injectedError = beforeInsert?.(row)
      const duplicate = rows.some((existing) =>
        ["workspace_id", "kind", "slug", "version"].every((key) => existing[key] === row[key]),
      )
      if (injectedError || duplicate) {
        return {
          select: () => ({
            single: async () => ({
              data: null,
              error: injectedError ?? { code: "23505", message: "duplicate version" },
            }),
          }),
        }
      }
      const stored = { id: `row-${inserts.length + 1}`, ...row }
      inserts.push(stored)
      rows.push(stored)
      return {
        select: vi.fn(() => ({
          single: vi.fn(async () => ({ data: stored, error: null })),
        })),
      }
    })
    return q
  }
  hoisted.createAdminClient.mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === "workspaces") return workspaceBuilder
      if (table === "folders") return foldersBuilder
      return makeQuery()
    }),
  })
  return { inserts }
}

function publishedRow(slug: string, version: number, name: string | null): FakeRow {
  return {
    id: `${slug}-${version}`,
    workspace_id: WORKSPACE_ID,
    kind: "kb",
    audience: "public",
    slug,
    scope: null,
    status: "published",
    version,
    name,
    visibility: "public",
    required_role: null,
    spec: validSpec("📚"),
    created_by: "user-1",
    published_by: "user-1",
    created_at: "now",
    updated_at: "now",
  }
}

describe("slug-less writes resolve to the builder's default project", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("getOrCreateDraft without a slug drafts the moved root project, not a phantom root", async () => {
    // Root was moved to `docs`; nothing lives on the workspace slug.
    const { inserts } = mockFilteringAdmin([publishedRow("docs", 3, "Acme Docs")])

    const draft = await getOrCreateDraft(WORKSPACE_ID, "user-1")

    expect(draft.slug).toBe("docs")
    expect(draft.status).toBe("draft")
    expect(draft.version).toBe(4)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].slug).toBe("docs")
    expect(inserts.some((r) => r.slug === WORKSPACE_SLUG)).toBe(false)
  })

  it("getOrCreateDraft without a slug prefers the root project when one exists", async () => {
    mockFilteringAdmin([
      publishedRow("docs", 3, "Acme Docs"),
      publishedRow(WORKSPACE_SLUG, 1, null),
    ])

    const draft = await getOrCreateDraft(WORKSPACE_ID, "user-1")

    expect(draft.slug).toBe(WORKSPACE_SLUG)
  })

  it("getOrCreateDraft without a slug seeds the root for a project-less workspace", async () => {
    const { inserts } = mockFilteringAdmin([])

    const draft = await getOrCreateDraft(WORKSPACE_ID, "user-1")

    expect(draft.slug).toBe(WORKSPACE_SLUG)
    expect(inserts).toHaveLength(1)
  })

  it("publishDefaultPortalProject is a no-op when any project exists", async () => {
    const { inserts } = mockFilteringAdmin([publishedRow("docs", 3, "Acme Docs")])

    const row = await publishDefaultPortalProject(WORKSPACE_ID, "user-1")

    expect(row).toBeNull()
    expect(inserts).toHaveLength(0)
  })
})


describe("draft version collisions", () => {
  it("allocates versions across audiences, including archived rows", async () => {
    mockFilteringAdmin([
      publishedRow("docs", 3, "Docs"),
      { ...publishedRow("docs", 4, "Internal"), audience: "internal", status: "archived" },
    ])
    const draft = await getOrCreateDraft(WORKSPACE_ID, "user-1", "docs")
    expect(draft.version).toBe(5)
    expect(draft.audience).toBe("public")
  })

  it("returns a competing draft after a unique violation", async () => {
    const rows = [publishedRow("docs", 3, "Docs")]
    const insert = vi.fn((row: FakeRow) => {
      rows.push({ ...row, id: "winning-draft" })
      return { code: "23505", message: "duplicate version" }
    })
    mockFilteringAdmin(rows, insert)
    const draft = await getOrCreateDraft(WORKSPACE_ID, "user-1", "docs")
    expect(draft.id).toBe("winning-draft")
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it("refreshes the version and seed when the competing draft was already published", async () => {
    const rows = [publishedRow("docs", 3, "Docs")]
    const insert = vi.fn(() => {
      if (insert.mock.calls.length > 1) return null
      rows[0].status = "archived"
      rows.push(publishedRow("docs", 4, "Updated docs"))
      return { code: "23505", message: "duplicate version" }
    })
    mockFilteringAdmin(rows, insert)
    const draft = await getOrCreateDraft(WORKSPACE_ID, "user-1", "docs")
    expect(draft.version).toBe(5)
    expect(draft.name).toBe("Updated docs")
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it("bounds retries when a unique violation cannot be recovered", async () => {
    const insert = vi.fn(() => ({ code: "23505", message: "persistent collision" }))
    mockFilteringAdmin([publishedRow("docs", 3, "Docs")], insert)
    await expect(getOrCreateDraft(WORKSPACE_ID, "user-1", "docs"))
      .rejects.toThrow("draft create failed: persistent collision")
    expect(insert).toHaveBeenCalledTimes(3)
  })

  it("does not retry other database errors", async () => {
    const insert = vi.fn(() => ({ code: "42501", message: "permission denied" }))
    mockFilteringAdmin([publishedRow("docs", 3, "Docs")], insert)
    await expect(getOrCreateDraft(WORKSPACE_ID, "user-1", "docs"))
      .rejects.toThrow("draft create failed: permission denied")
    expect(insert).toHaveBeenCalledTimes(1)
  })
})


describe("saveDraft history", () => {
  it("saves the edit and editor through one atomic database call", async () => {
    const row = { id: "saved-edit" }
    const single = vi.fn().mockResolvedValue({ data: row, error: null })
    const rpc = vi.fn(() => ({ single }))
    hoisted.createAdminClient.mockReturnValue({ rpc })
    expect(await saveDraft(WORKSPACE_ID, validSpec(), "acme", "editor-id")).toEqual(row)
    expect(rpc).toHaveBeenCalledWith("save_portal_edit", expect.objectContaining({
      p_workspace_id: WORKSPACE_ID, p_slug: "acme", p_editor_id: "editor-id",
      p_spec: expect.objectContaining({ theme: expect.objectContaining({ brandName: "Acme" }) }),
    }))
  })
  it("reports snapshot failures instead of claiming the save succeeded", async () => {
    hoisted.createAdminClient.mockReturnValue({ rpc: () => ({
      single: async () => ({ data: null, error: { message: "snapshot failed" } }),
    }) })
    await expect(saveDraft(WORKSPACE_ID, validSpec(), "acme", "editor-id"))
      .rejects.toThrow("snapshot failed")
  })
})
