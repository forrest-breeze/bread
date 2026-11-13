import { beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getAuthUser: vi.fn(),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: hoisted.createAdminClient,
}))

vi.mock("@/lib/auth/get-auth-user", () => ({
  getAuthUser: hoisted.getAuthUser,
}))

import {
  expandScope,
  getPortalWorkspace,
  getPublicDocument,
  getPublicDocumentLinks,
  isScopeProvided,
  normalizeScopeKey,
  searchPublic,
  searchPublicForQuestion,
  visibleDocFilter,
} from "@/lib/public-kb"

function query(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
  }
  return builder
}

// Documents-table builder that honours both the `document_type` allowlist
// (`.in()`) AND the id-or-slug lookup (`.eq("id" | "public_slug", value)`) the
// same way PostgREST would: a row whose type is not in the allowlist, or whose
// looked-up column doesn't match, resolves to null. Proves getPublicDocument's
// document_type guard AND its UUID-or-slug resolution both work.
function documentsQuery(
  row: { id: string; public_slug?: string | null; document_type: string } & Record<
    string,
    unknown
  >,
) {
  let typeAllowed = true
  let refMatches = true
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: string) => {
      if (column === "id") refMatches = row.id === value
      if (column === "public_slug") refMatches = (row.public_slug ?? null) === value
      return builder
    }),
    in: vi.fn((column: string, values: string[]) => {
      if (column === "document_type") typeAllowed = values.includes(row.document_type)
      return builder
    }),
    maybeSingle: vi.fn(async () => ({
      data: typeAllowed && refMatches ? row : null,
      error: null,
    })),
  }
  return builder
}

// Mirrors PostgREST `ilike` for the `%term%` patterns searchPublic sends.
function ilikeMatches(value: string, pattern: string): boolean {
  const needle = pattern.replace(/^%|%$/g, "").replace(/\\(.)/g, "$1").toLowerCase()
  return value.toLowerCase().includes(needle)
}

function thenableQuery(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    in: vi.fn(() => builder),
    or: vi.fn(() => builder),
    ilike: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    then: vi.fn(
      (
        onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(onfulfilled, onrejected),
    ),
  }
  return builder
}

interface PublicDocRow {
  id: string
  public_slug?: string | null
  title: string
  source: string | null
  document_type: string
}

function publicDocsQuery(rows: PublicDocRow[]) {
  let allowedIds: string[] | null = null
  let allowedTypes: string[] | null = null
  let titlePattern: string | null = null

  const builder = {
    // Each `.select()` starts a fresh query on this shared builder.
    select: vi.fn(() => {
      allowedIds = null
      allowedTypes = null
      titlePattern = null
      return builder
    }),
    ilike: vi.fn((column: string, pattern: string) => {
      if (column === "title") titlePattern = pattern
      return builder
    }),
    limit: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    or: vi.fn(() => builder),
    in: vi.fn((column: string, values: string[]) => {
      if (column === "id") allowedIds = values
      if (column === "document_type") allowedTypes = values
      return builder
    }),
    then: vi.fn(
      (
        onfulfilled?: (value: { data: PublicDocRow[]; error: null }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => {
        const filtered = rows.filter((row) => {
          const idAllowed = !allowedIds || allowedIds.includes(row.id)
          const typeAllowed =
            !allowedTypes || allowedTypes.includes(row.document_type)
          const titleAllowed = !titlePattern || ilikeMatches(row.title, titlePattern)
          return idAllowed && typeAllowed && titleAllowed
        })
        return Promise.resolve({ data: filtered, error: null }).then(
          onfulfilled,
          onrejected,
        )
      },
    ),
  }
  return builder
}

// A documents-table builder that ALSO honours the folder `.or()` filter, so a
// scoped read (`folder_id.in.(…)`) drops docs whose folder is out of scope. Each
// row carries a `folder_id`; the `.or()` string from visibleDocFilter is parsed
// to the allowed folder-id set (and whether workspace-level docs are allowed).
interface ScopedDocRow extends PublicDocRow {
  folder_id: string | null
}

function scopedDocsQuery(rows: ScopedDocRow[]) {
  let allowedIds: string[] | null = null
  let allowedTypes: string[] | null = null
  let titlePattern: string | null = null
  let allowFolderIds: Set<string> | null = null
  let allowNullFolder = true

  const builder = {
    // Each `.select()` starts a fresh query on this shared builder.
    select: vi.fn(() => {
      allowedIds = null
      allowedTypes = null
      titlePattern = null
      return builder
    }),
    ilike: vi.fn((column: string, pattern: string) => {
      if (column === "title") titlePattern = pattern
      return builder
    }),
    limit: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    in: vi.fn((column: string, values: string[]) => {
      if (column === "id") allowedIds = values
      if (column === "document_type") allowedTypes = values
      return builder
    }),
    or: vi.fn((filter: string) => {
      // visibleDocFilter shapes: "folder_id.is.null,folder_id.in.(a,b)" (unscoped)
      // or "folder_id.in.(a,b)" (scoped — workspace-level docs excluded).
      allowNullFolder = filter.includes("folder_id.is.null")
      const match = filter.match(/folder_id\.in\.\(([^)]*)\)/)
      allowFolderIds = match
        ? new Set(match[1].split(",").filter((id) => id.length > 0))
        : new Set<string>()
      return builder
    }),
    then: vi.fn(
      (
        onfulfilled?: (value: { data: ScopedDocRow[]; error: null }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => {
        const filtered = rows.filter((row) => {
          const idAllowed = !allowedIds || allowedIds.includes(row.id)
          const typeAllowed =
            !allowedTypes || allowedTypes.includes(row.document_type)
          let folderAllowed = true
          if (allowFolderIds !== null) {
            folderAllowed =
              row.folder_id === null
                ? allowNullFolder
                : allowFolderIds.has(row.folder_id)
          }
          const titleAllowed = !titlePattern || ilikeMatches(row.title, titlePattern)
          return idAllowed && typeAllowed && titleAllowed && folderAllowed
        })
        return Promise.resolve({ data: filtered, error: null }).then(
          onfulfilled,
          onrejected,
        )
      },
    ),
  }
  return builder
}

function workspaceRow(slug: string, kbPublic: boolean) {
  return {
    id: `ws-${slug}`,
    name: "Acme",
    slug,
    icon_url: null,
    settings: { kb_public: kbPublic },
  }
}

function expectedWorkspace(slug: string, isPublic: boolean) {
  return {
    id: `ws-${slug}`,
    name: "Acme",
    slug,
    iconUrl: null,
    isPublic,
    customDomain: "",
    portalAddressScope: "workspace",
    portalAddressMode: "breezify",
    portalChromeScope: "workspace",
    header: null,
    branding: {
      name: "Acme",
      tagline: "",
      logoUrl: "",
      accentColor: "#2f5520",
    },
    websiteUrl: "",
    footer: null,
  }
}

describe("getPortalWorkspace", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
    hoisted.getAuthUser.mockReset()
  })

  it("allows published workspaces without checking auth", async () => {
    const workspaceQuery = query({
      data: workspaceRow("published-portal", true),
      error: null,
    })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn(() => workspaceQuery),
    })

    const result = await getPortalWorkspace("published-portal")

    expect(result).toEqual({
      kind: "workspace",
      workspace: expectedWorkspace("published-portal", true),
    })
    expect(hoisted.getAuthUser).not.toHaveBeenCalled()
  })

  it("requires login for private workspaces when no user is signed in", async () => {
    const workspaceQuery = query({
      data: workspaceRow("private-login", false),
      error: null,
    })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn(() => workspaceQuery),
    })
    hoisted.getAuthUser.mockResolvedValue(null)

    await expect(getPortalWorkspace("private-login")).resolves.toEqual({
      kind: "login_required",
    })
  })

  it("allows private workspaces for active members", async () => {
    const workspaceQuery = query({
      data: workspaceRow("private-member", false),
      error: null,
    })
    const membershipQuery = query({
      data: { id: "membership-1" },
      error: null,
    })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "workspace_members" ? membershipQuery : workspaceQuery,
      ),
    })
    hoisted.getAuthUser.mockResolvedValue({ id: "user-1" })

    const result = await getPortalWorkspace("private-member")

    expect(result).toEqual({
      kind: "workspace",
      workspace: expectedWorkspace("private-member", false),
    })
  })

  it("hides private workspaces from non-members", async () => {
    const workspaceQuery = query({
      data: workspaceRow("private-nonmember", false),
      error: null,
    })
    const membershipQuery = query({ data: null, error: null })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "workspace_members" ? membershipQuery : workspaceQuery,
      ),
    })
    hoisted.getAuthUser.mockResolvedValue({ id: "user-1" })

    await expect(getPortalWorkspace("private-nonmember")).resolves.toEqual({
      kind: "not_found",
    })
  })

  it("fails closed when private portal auth check times out", async () => {
    const workspaceQuery = query({
      data: workspaceRow("private-auth-timeout", false),
      error: null,
    })
    const from = vi.fn(() => workspaceQuery)
    hoisted.createAdminClient.mockReturnValue({ from })
    hoisted.getAuthUser.mockRejectedValue(
      Object.assign(new Error("Auth check failed transiently"), {
        name: "AuthCheckError",
      }),
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(getPortalWorkspace("private-auth-timeout")).resolves.toEqual({
      kind: "not_found",
    })
    expect(from).not.toHaveBeenCalledWith("workspace_members")

    warn.mockRestore()
  })
})

describe("getPublicDocument document_type allowlist", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("does not return a topic_page fetched by slug", async () => {
    const docsQuery = documentsQuery({
      id: "doc-topic-page",
      public_slug: "synthesized-topic-page",
      title: "Synthesized topic page",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "topic_page",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", "synthesized-topic-page")

    expect(result).toBeNull()
    expect(docsQuery.in).toHaveBeenCalledWith("document_type", ["source", "page"])
  })

  it("does not return an unfiled GitHub repo file", async () => {
    const docsQuery = documentsQuery({
      id: "doc-github",
      public_slug: "repo-file",
      title: "acme/repo/docs/internal.md",
      content: "body",
      source: "GitHub",
      author: "GitHub",
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    expect(await getPublicDocument("ws-1", "repo-file")).toBeNull()
  })

  it("returns a visible source document with no folder", async () => {
    const docsQuery = documentsQuery({
      id: "doc-source",
      public_slug: "a-real-source",
      title: "A real source",
      content: "body",
      source: "slack",
      author: "alice",
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", "a-real-source")

    expect(result).toEqual({
      id: "doc-source",
      slug: "a-real-source",
      // Sparse: only documents that declare a date carry one.
      published_at: null,
      title: "A real source",
      content: "body",
      source: "slack",
      author: "alice",
      cover: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
    })
  })

  it("returns a page document only when its folder is workspace-visible", async () => {
    const docsQuery = documentsQuery({
      id: "doc-page",
      public_slug: "a-page-in-a-folder",
      title: "A page in a folder",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: "folder-visible",
      deleted_at: null,
      document_type: "page",
    })
    const folderQuery = query({
      data: { visibility: "workspace" },
      error: null,
    })
    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) =>
        table === "folders" ? folderQuery : docsQuery,
      ),
    })

    const result = await getPublicDocument("ws-1", "a-page-in-a-folder")

    expect(result?.id).toBe("doc-page")
    expect(result?.folder_id).toBe("folder-visible")
  })
})

describe("getPublicDocument id-or-slug resolution", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  const UUID = "11111111-2222-3333-4444-555555555555"

  it("resolves a raw UUID via the id column (back-compat)", async () => {
    const docsQuery = documentsQuery({
      id: UUID,
      public_slug: "human-readable",
      title: "By UUID",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", UUID)

    expect(result?.id).toBe(UUID)
    // UUID-shaped input must match on `id`, never `public_slug`.
    expect(docsQuery.eq).toHaveBeenCalledWith("id", UUID)
    expect(docsQuery.eq).not.toHaveBeenCalledWith("public_slug", UUID)
    // slug surfaces the public_slug so links can stay readable.
    expect(result?.slug).toBe("human-readable")
  })

  it("resolves a non-UUID value via the public_slug column", async () => {
    const docsQuery = documentsQuery({
      id: UUID,
      public_slug: "developer-api-search",
      title: "By slug",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", "developer-api-search")

    expect(result?.id).toBe(UUID)
    expect(result?.slug).toBe("developer-api-search")
    expect(docsQuery.eq).toHaveBeenCalledWith("public_slug", "developer-api-search")
    // Scoping preserved: workspace + document_type allowlist still applied.
    expect(docsQuery.eq).toHaveBeenCalledWith("workspace_id", "ws-1")
    expect(docsQuery.in).toHaveBeenCalledWith("document_type", ["source", "page"])
  })

  it("falls back slug to id when public_slug is null", async () => {
    const docsQuery = documentsQuery({
      id: UUID,
      public_slug: null,
      title: "No slug",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", UUID)

    expect(result?.slug).toBe(UUID)
  })

  it("404s (null) when a slug does not match", async () => {
    const docsQuery = documentsQuery({
      id: UUID,
      public_slug: "real-slug",
      title: "Real",
      content: "body",
      source: null,
      author: null,
      updated_at: "2026-06-19T00:00:00Z",
      folder_id: null,
      deleted_at: null,
      document_type: "source",
    })
    hoisted.createAdminClient.mockReturnValue({ from: vi.fn(() => docsQuery) })

    const result = await getPublicDocument("ws-1", "wrong-slug")

    expect(result).toBeNull()
  })
})

describe("public document producer document_type allowlist", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("drops topic_page rows from public document links", async () => {
    const outboundQuery = thenableQuery({
      data: [
        { target_document_id: "doc-topic-page", strength: "related" },
        { target_document_id: "doc-source", strength: "related" },
      ],
      error: null,
    })
    const inboundQuery = thenableQuery({ data: [], error: null })
    const foldersQuery = thenableQuery({ data: [], error: null })
    const docsQuery = publicDocsQuery([
      {
        id: "doc-topic-page",
        public_slug: null,
        title: "Synthesized topic page",
        source: null,
        document_type: "topic_page",
      },
      {
        id: "doc-source",
        public_slug: "visible-source",
        title: "Visible source",
        source: "slack",
        document_type: "source",
      },
    ])
    const linkQueries = [outboundQuery, inboundQuery]

    hoisted.createAdminClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "document_links") return linkQueries.shift() ?? inboundQuery
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const links = await getPublicDocumentLinks("ws-1", "doc-current")

    expect(docsQuery.in).toHaveBeenCalledWith("document_type", ["source", "page"])
    expect(links.outbound).toEqual([
      {
        id: "doc-source",
        slug: "visible-source",
        title: "Visible source",
        source: "slack",
        document_type: "source",
        strength: "related",
      },
    ])
  })

  it("drops topic_page rows from public search hits", async () => {
    const foldersQuery = thenableQuery({ data: [], error: null })
    const docsQuery = publicDocsQuery([
      {
        id: "doc-topic-page",
        public_slug: null,
        title: "Synthesized topic page",
        source: null,
        document_type: "topic_page",
      },
      {
        id: "doc-source",
        public_slug: "visible-source",
        title: "Visible source",
        source: "slack",
        document_type: "source",
      },
    ])

    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({
        data: [
          {
            document_id: "doc-topic-page",
            title: "Synthesized topic page",
            line_text: "topic page snippet",
          },
          {
            document_id: "doc-source",
            title: "Visible source",
            line_text: "source snippet",
          },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "snippet")

    expect(docsQuery.in).toHaveBeenCalledWith("document_type", ["source", "page"])
    expect(hits).toEqual([
      {
        id: "doc-source",
        slug: "visible-source",
        title: "Visible source",
        source: "slack",
        snippet: "source snippet",
      },
    ])
  })

  it("returns readable plain-text snippets for Markdown search matches", async () => {
    const foldersQuery = thenableQuery({ data: [], error: null })
    const docsQuery = publicDocsQuery([
      {
        id: "doc-heading",
        public_slug: "connecting-integrations",
        title: "Connecting Integrations in Breezify",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-section",
        public_slug: "getting-started",
        title: "Getting Started with Breezify",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-markdown",
        public_slug: "security",
        title: "Security and Data Handling in Breezify",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-list",
        public_slug: "what-is-breezify",
        title: "What is Breezify?",
        source: null,
        document_type: "source",
      },
    ])

    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({
        data: [
          {
            document_id: "doc-heading",
            title: "Connecting Integrations in Breezify",
            line_text: "# Connecting Integrations in Breezify",
          },
          {
            document_id: "doc-section",
            title: "Getting Started with Breezify",
            line_text: "## 2. Connect an Integration",
          },
          {
            document_id: "doc-markdown",
            title: "Security and Data Handling in Breezify",
            line_text:
              "When you connect Slack, tokens are **encrypted at rest** and `breezify-mcp` works.",
          },
          {
            document_id: "doc-list",
            title: "What is Breezify?",
            line_text:
              "- **Slack** — connect via OAuth; `@breezify` captures a conversation into the KB.",
          },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "connect")

    expect(hits.map((hit) => hit.snippet)).toEqual([
      "",
      "2. Connect an Integration",
      "When you connect Slack, tokens are encrypted at rest and breezify-mcp works.",
      "Slack — connect via OAuth; @breezify captures a conversation into the KB.",
    ])
  })

  it("ranks title matches ahead of earlier body-only matches", async () => {
    const foldersQuery = thenableQuery({ data: [], error: null })
    const docsQuery = publicDocsQuery([
      {
        id: "doc-body",
        public_slug: "connecting-integrations",
        title: "Connecting Integrations in Breezify",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-billing",
        public_slug: "account-billing",
        title: "Account and Billing",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-title",
        public_slug: "workspaces-roles-permissions",
        title: "Workspaces, Roles, and Permissions",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-snippet",
        public_slug: "security",
        title: "Security and Data Handling in Breezify",
        source: null,
        document_type: "source",
      },
    ])

    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({
        data: [
          {
            document_id: "doc-body",
            title: "Connecting Integrations in Breezify",
            line_text:
              "Every integration embeds everything for semantic and workspace search.",
          },
          {
            document_id: "doc-billing",
            title: "Account and Billing",
            line_text: "Sign in as a workspace owner or admin.",
          },
          {
            document_id: "doc-snippet",
            title: "Security and Data Handling in Breezify",
            line_text: "Workspace isolation and row-level security",
          },
          {
            document_id: "doc-title",
            title: "Workspaces, Roles, and Permissions",
            line_text:
              "Breezify organizes your team's operational knowledge into workspaces.",
          },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "workspace")

    expect(hits.map((hit) => hit.id)).toEqual([
      "doc-title",
      "doc-snippet",
      "doc-body",
      "doc-billing",
    ])
  })
})

describe("searchPublic title matching", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  it("finds a doc by title even when its body never contains the query", async () => {
    const docsQuery = publicDocsQuery([
      {
        id: "doc-quickstart",
        public_slug: "quickstart",
        title: "Quickstart",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-other",
        public_slug: "other",
        title: "Other",
        source: null,
        document_type: "source",
      },
      {
        id: "doc-hidden",
        public_slug: "hidden-quickstart",
        title: "Quickstart (internal)",
        source: null,
        document_type: "topic_page",
      },
    ])
    hoisted.createAdminClient.mockReturnValue({
      // Body grep finds nothing.
      rpc: vi.fn(async () => ({ data: [], error: null })),
      from: vi.fn((table: string) => {
        if (table === "folders") return thenableQuery({ data: [], error: null })
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })

    const hits = await searchPublic("ws-1", "quickstart")

    expect(hits).toEqual([
      {
        id: "doc-quickstart",
        slug: "quickstart",
        title: "Quickstart",
        source: null,
        snippet: "",
      },
    ])
  })
})

describe("searchPublic fuzzy title matching", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  function adminWithTitles(titles: string[]) {
    const docsQuery = publicDocsQuery(
      titles.map((title, i) => ({
        id: `doc-${i}`,
        public_slug: `doc-${i}`,
        title,
        source: null,
        document_type: "page",
      })),
    )
    hoisted.createAdminClient.mockReturnValue({
      rpc: vi.fn(async () => ({ data: [], error: null })),
      from: vi.fn((table: string) => {
        if (table === "folders") return thenableQuery({ data: [], error: null })
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
    })
  }

  const TITLES = ["Quick Start", "QuickStart", "Payout page status update", "List statements"]

  it.each(["quit start", "quick start", "quickstart", "quikstart", "quick"])(
    "%s finds both Quick Start spellings",
    async (q) => {
      adminWithTitles(TITLES)
      const hits = await searchPublic("ws-1", q)
      expect(hits.map((h) => h.title).sort()).toEqual(["Quick Start", "QuickStart"])
    },
  )

  it("does not let a typo budget pull in unrelated words", async () => {
    adminWithTitles(TITLES)
    const hits = await searchPublic("ws-1", "start")
    expect(hits.map((h) => h.title)).not.toContain("Payout page status update")
    expect(hits.map((h) => h.title)).not.toContain("List statements")
  })
})

// ---------------------------------------------------------------------------
// Project scope correctness
// ---------------------------------------------------------------------------

describe("scope helpers", () => {
  const A = "11111111-1111-1111-1111-111111111111"
  const B = "22222222-2222-2222-2222-222222222222"

  it("treats only null/undefined as unscoped; [] is an empty fail-closed scope", () => {
    expect(isScopeProvided(null)).toBe(false)
    expect(isScopeProvided(undefined)).toBe(false)
    expect(isScopeProvided([])).toBe(true)
    expect(isScopeProvided([A])).toBe(true)
    // A provided-but-typoed scope is STILL provided (must fail closed, not widen).
    expect(isScopeProvided(["not-a-uuid"])).toBe(true)
  })

  it("keys no-scope to '', valid scope to sorted ids, all-invalid scope to a distinct sentinel", () => {
    expect(normalizeScopeKey(null)).toBe("")
    expect(normalizeScopeKey([])).not.toBe("")
    expect(normalizeScopeKey([B, A])).toBe(`${A},${B}`)
    // A provided scope of only invalid ids must NOT collapse to the '' (whole
    // workspace) key — otherwise it would share an entry and widen.
    expect(normalizeScopeKey(["typo", "also-bad"])).not.toBe("")
    expect(normalizeScopeKey(["typo"])).toBe(normalizeScopeKey(["other-typo"]))
  })

  it("expands scope roots to descendants and drops topics", () => {
    const rows = [
      { id: A, kind: "user", parent_folder_id: null },
      { id: "child", kind: "user", parent_folder_id: A },
      { id: "topic", kind: "topic", parent_folder_id: A },
      { id: B, kind: "user", parent_folder_id: null },
    ]
    const allowed = expandScope(rows, [A])
    expect(allowed.has(A)).toBe(true)
    expect(allowed.has("child")).toBe(true)
    expect(allowed.has("topic")).toBe(false)
    expect(allowed.has(B)).toBe(false)
  })

  it("scoped visibleDocFilter matches nothing for an empty folder set (fail closed)", () => {
    // A provided-but-invalid scope yields an empty folder set; the scoped filter
    // must resolve to a never-matching clause, NOT the unscoped null-folder one.
    const filter = visibleDocFilter([], true)
    expect(filter).not.toContain("folder_id.is.null")
    expect(filter).toContain("folder_id.in.(00000000-0000-0000-0000-000000000000)")
  })
})

describe("searchPublic scope", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  const IN_SCOPE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  const OUT_OF_SCOPE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

  function adminForScopedSearch() {
    const foldersQuery = thenableQuery({
      data: [
        { id: IN_SCOPE, kind: "user", parent_folder_id: null },
        { id: OUT_OF_SCOPE, kind: "user", parent_folder_id: null },
      ],
      error: null,
    })
    const docsQuery = scopedDocsQuery([
      {
        id: "doc-in",
        public_slug: "in-scope-doc",
        title: "In scope",
        source: "slack",
        document_type: "source",
        folder_id: IN_SCOPE,
      },
      {
        id: "doc-out",
        public_slug: "out-of-scope-doc",
        title: "Out of scope",
        source: "slack",
        document_type: "source",
        folder_id: OUT_OF_SCOPE,
      },
    ])
    return {
      rpc: vi.fn(async () => ({
        data: [
          { document_id: "doc-in", title: "In scope", line_text: "match in" },
          { document_id: "doc-out", title: "Out of scope", line_text: "match out" },
        ],
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return foldersQuery
        if (table === "documents") return docsQuery
        throw new Error(`Unexpected table ${table}`)
      }),
      docsQuery,
    }
  }

  it("excludes out-of-scope docs from a scoped search", async () => {
    const admin = adminForScopedSearch()
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublic("ws-1", "match", 25, [IN_SCOPE])

    expect(hits.map((h) => h.id)).toEqual(["doc-in"])
    // Scoped filter excludes workspace-level docs entirely.
    expect(admin.docsQuery.or).toHaveBeenCalledWith(
      `folder_id.in.(${IN_SCOPE})`,
    )
  })

  it("a provided-but-invalid scope returns no hits (fails closed, not whole-workspace)", async () => {
    const admin = adminForScopedSearch()
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublic("ws-1", "match", 25, ["not-a-uuid"])

    expect(hits).toEqual([])
    // The scoped filter must be the never-matching sentinel, never the unscoped
    // null-folder clause that would surface every workspace doc.
    expect(admin.docsQuery.or).toHaveBeenCalledWith(
      "folder_id.in.(00000000-0000-0000-0000-000000000000)",
    )
  })

  it("an unscoped search still surfaces docs across the workspace", async () => {
    const admin = adminForScopedSearch()
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublic("ws-1", "match", 25)

    expect(hits.map((h) => h.id).sort()).toEqual(["doc-in", "doc-out"])
  })
})

describe("searchPublicForQuestion", () => {
  beforeEach(() => {
    hoisted.createAdminClient.mockReset()
  })

  const DOC_A = {
    id: "doc-a",
    public_slug: "alpha",
    title: "Alpha",
    source: "slack",
    document_type: "source",
    folder_id: null,
  }
  const DOC_B = {
    id: "doc-b",
    public_slug: "beta",
    title: "Beta",
    source: "slack",
    document_type: "source",
    folder_id: null,
  }

  // grep responds per literal pattern: the whole-sentence pattern matches
  // nothing; individual keywords match docs. Builders are minted per call so
  // parallel keyword searches don't share filter state.
  function adminForQuestion(byPattern: Record<string, Array<typeof DOC_A>>) {
    return {
      rpc: vi.fn(async (_fn: string, args: { p_pattern: string }) => ({
        data: (byPattern[args.p_pattern] ?? []).map((doc) => ({
          document_id: doc.id,
          title: doc.title,
          line_text: `${doc.title} mentions things`,
        })),
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "folders") return thenableQuery({ data: [], error: null })
        if (table === "documents") return scopedDocsQuery([DOC_A, DOC_B])
        throw new Error(`Unexpected table ${table}`)
      }),
    }
  }

  it("falls back to keyword retrieval and ranks docs hit by more keywords first", async () => {
    const admin = adminForQuestion({ breezify: [DOC_A, DOC_B], portal: [DOC_B] })
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublicForQuestion(
      "ws-1",
      "explain what does the breezify portal do",
      8,
    )

    // Direct phrase first, then one grep per keyword (stopwords dropped).
    const patterns = admin.rpc.mock.calls.map(
      (call) => (call[1] as { p_pattern: string }).p_pattern,
    )
    expect(patterns).toEqual(["explain what does the breezify portal do", "breezify", "portal"])
    // doc-b matched both keywords, doc-a only one.
    expect(hits.map((h) => h.id)).toEqual(["doc-b", "doc-a"])
  })

  it("short-circuits on a direct phrase hit without keyword fan-out", async () => {
    const admin = adminForQuestion({ breezify: [DOC_A] })
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublicForQuestion("ws-1", "breezify", 8)

    expect(hits.map((h) => h.id)).toEqual(["doc-a"])
    expect(admin.rpc).toHaveBeenCalledTimes(1)
  })

  it("returns nothing for a stopword-only question", async () => {
    const admin = adminForQuestion({})
    hoisted.createAdminClient.mockReturnValue(admin)

    const hits = await searchPublicForQuestion("ws-1", "what does it do", 8)

    expect(hits).toEqual([])
    // Only the direct-phrase attempt — no keywords survive the stopword filter.
    expect(admin.rpc).toHaveBeenCalledTimes(1)
  })
})
