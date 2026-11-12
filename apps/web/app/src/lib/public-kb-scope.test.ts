import { describe, expect, it } from "vitest"
import {
  docScopeFilter,
  docScopePermits,
  expandScope,
  normalizeScopeKey,
  scopeEntryId,
  scopePromotedIds,
  shapePublicTaxonomy,
  visibleDocFilter,
  type PublicDocScope,
  type PublicFolderSummary,
  type ScopeFolderRow,
} from "@/lib/public-kb"

// Well-formed UUIDs for scope keys (normalizeScopeKey drops non-UUIDs).
const HELP = "a992906c-d30d-498b-8c3a-1fd22e0bd397"
const OTHER = "b992906c-d30d-498b-8c3a-1fd22e0bd398"
const DOC = "c992906c-d30d-498b-8c3a-1fd22e0bd399"

describe("normalizeScopeKey", () => {
  it("uses the unscoped key only for absent/null scope and fails closed for []", () => {
    expect(normalizeScopeKey(undefined)).toBe("")
    expect(normalizeScopeKey(null)).toBe("")
    expect(normalizeScopeKey([])).not.toBe("")
  })

  it("dedupes, sorts, and drops non-UUID ids so two projects key distinctly", () => {
    expect(normalizeScopeKey([OTHER, HELP, HELP])).toBe([HELP, OTHER].sort().join(","))
    expect(normalizeScopeKey(["not-a-uuid", HELP])).toBe(HELP)
  })

  it("treats promoted entries as their folder id — promotion never widens or splits the doc cache key", () => {
    expect(normalizeScopeKey([{ id: HELP, promote: true }, OTHER])).toBe(
      normalizeScopeKey([HELP, OTHER]),
    )
  })

  it("keys a structural root separately from a recursively included folder", () => {
    expect(normalizeScopeKey([{ id: HELP, promote: true, rootOnly: true }])).not.toBe(
      normalizeScopeKey([HELP]),
    )
  })

  it("keys explicitDocs separately from a plain structural root", () => {
    expect(
      normalizeScopeKey([{ id: HELP, rootOnly: true, explicitDocs: true }]),
    ).not.toBe(normalizeScopeKey([{ id: HELP, rootOnly: true }]))
  })

  it("keys doc and workspaceDocs entries so two doc-scoped projects never collide", () => {
    expect(normalizeScopeKey([{ doc: DOC }])).toBe(`doc:${DOC}`)
    expect(normalizeScopeKey([{ workspaceDocs: true }])).toBe("workspace-docs")
    expect(normalizeScopeKey([{ doc: DOC }])).not.toBe(normalizeScopeKey([DOC]))
    // A doc entry with an invalid UUID fails closed, never widening to unscoped.
    expect(normalizeScopeKey([{ doc: "not-a-uuid" }])).toBe("invalid")
  })
})

describe("scope entries", () => {
  it("scopeEntryId reads both folder shapes and blanks non-folder entries", () => {
    expect(scopeEntryId(HELP)).toBe(HELP)
    expect(scopeEntryId({ id: HELP, promote: true })).toBe(HELP)
    expect(scopeEntryId({ doc: DOC })).toBe("")
    expect(scopeEntryId({ workspaceDocs: true })).toBe("")
  })

  it("scopePromotedIds returns only explicitly promoted, UUID-valid ids", () => {
    expect(
      scopePromotedIds([
        HELP,
        { id: OTHER, promote: true },
        { id: "not-a-uuid", promote: true },
        { id: HELP },
      ]),
    ).toEqual([OTHER])
    expect(scopePromotedIds(null)).toEqual([])
    expect(scopePromotedIds(undefined)).toEqual([])
  })
})

describe("expandScope", () => {
  const rows: ScopeFolderRow[] = [
    { id: HELP, kind: "user", parent_folder_id: null },
    { id: "child-1", kind: "user", parent_folder_id: HELP },
    { id: "grandchild-1", kind: "user", parent_folder_id: "child-1" },
    { id: "sibling", kind: "user", parent_folder_id: null },
    { id: "topic-1", kind: "topic", parent_folder_id: HELP },
  ]

  it("expands a scope root to itself + all descendants, excluding siblings", () => {
    const allowed = expandScope(rows, [HELP])
    expect(allowed.has(HELP)).toBe(true)
    expect(allowed.has("child-1")).toBe(true)
    expect(allowed.has("grandchild-1")).toBe(true)
    expect(allowed.has("sibling")).toBe(false)
  })

  it("never includes topic folders", () => {
    const allowed = expandScope(rows, [HELP])
    expect(allowed.has("topic-1")).toBe(false)
  })

  it("ignores scope roots that are not public-visible folders", () => {
    const allowed = expandScope(rows, [OTHER])
    expect(allowed.size).toBe(0)
  })

  it("includes a structural root without implicitly including its descendants", () => {
    const allowed = expandScope(rows, [], [HELP])
    expect(allowed.has(HELP)).toBe(true)
    expect(allowed.has("child-1")).toBe(false)
    expect(allowed.has("grandchild-1")).toBe(false)
  })

  it("combines a structural root with selected recursive child trees", () => {
    const allowed = expandScope(rows, ["child-1"], [HELP])
    expect(Array.from(allowed).sort()).toEqual([HELP, "child-1", "grandchild-1"].sort())
  })
})

describe("shapePublicTaxonomy promotion", () => {
  const folder = (
    id: string,
    display_name: string,
    parent: string | null = null,
  ): PublicFolderSummary => ({
    id,
    display_name,
    kind: "user",
    parent_folder_id: parent,
    document_count: 1,
    sort_order: null,
    updated_at: "2026-07-07T00:00:00Z",
  })

  const rows = [
    folder("guides", "Guides"),
    folder("guides-intro", "Intro", "guides"),
    folder("guides-advanced", "Advanced", "guides"),
    folder("changelog", "Changelog"),
  ]
  const allowed = new Set(rows.map((r) => r.id))

  it("an explicitly promoted root surfaces its children as top-level sections", () => {
    const taxonomy = shapePublicTaxonomy(rows, allowed, ["guides"])
    const names = taxonomy.rootFolders.map((f) => f.display_name)
    expect(names).toEqual(["Advanced", "Changelog", "Intro"])
    expect(taxonomy.promotedRootIds).toEqual(["guides"])
  })

  it("without promotion the folder itself is the section (name is not a wrapper)", () => {
    const taxonomy = shapePublicTaxonomy(rows, allowed, [])
    const names = taxonomy.rootFolders.map((f) => f.display_name)
    expect(names).toEqual(["Changelog", "Guides"])
  })

  it("the legacy wrapper-name heuristic still promotes without an explicit entry", () => {
    const wrapperRows = [
      folder("docs", "Docs"),
      folder("docs-api", "API", "docs"),
      folder("other", "Other"),
    ]
    const taxonomy = shapePublicTaxonomy(wrapperRows, null, [])
    const names = taxonomy.rootFolders.map((f) => f.display_name)
    expect(names).toEqual(["API", "Other"])
  })
})

describe("visibleDocFilter", () => {
  it("unscoped: includes workspace-level docs plus docs in visible folders", () => {
    expect(visibleDocFilter([HELP, "child-1"])).toBe(
      `folder_id.is.null,folder_id.in.(${HELP},child-1)`,
    )
    expect(visibleDocFilter([])).toBe("folder_id.is.null")
  })

  it("scoped: only docs in the scoped folders, never workspace-level docs", () => {
    expect(visibleDocFilter([HELP, "child-1"], true)).toBe(
      `folder_id.in.(${HELP},child-1)`,
    )
  })

  it("scoped with an empty set matches nothing", () => {
    expect(visibleDocFilter([], true)).toBe(
      "folder_id.in.(00000000-0000-0000-0000-000000000000)",
    )
  })
})

describe("docScopeFilter / docScopePermits", () => {
  const ds = (overrides: Partial<PublicDocScope>): PublicDocScope => ({
    scoped: true,
    folderIds: new Set(),
    docFolderIds: new Set(),
    docIds: new Set(),
    includeWorkspaceDocs: false,
    ...overrides,
  })

  it("builds an or-filter from folder set, picked docs, and workspace docs", () => {
    expect(
      docScopeFilter(
        ds({
          docFolderIds: new Set([HELP]),
          docIds: new Set([DOC]),
          includeWorkspaceDocs: true,
        }),
      ),
    ).toBe(`folder_id.is.null,folder_id.in.(${HELP}),id.in.(${DOC})`)
  })

  it("fails closed to a match-nothing filter when the scope resolves to nothing", () => {
    expect(docScopeFilter(ds({}))).toBe(
      "folder_id.in.(00000000-0000-0000-0000-000000000000)",
    )
  })

  it("serves a folder's docs only when the folder is a doc folder", () => {
    const scope = ds({ folderIds: new Set([HELP]), docFolderIds: new Set([HELP]) })
    expect(docScopePermits(scope, { id: DOC, folder_id: HELP })).toBe(true)
    expect(docScopePermits(scope, { id: DOC, folder_id: OTHER })).toBe(false)
  })

  it("serves a picked doc only while its folder stays visible (explicitDocs folder)", () => {
    // HELP is visible but NOT a doc folder — its docs arrive via picks only.
    const scope = ds({ folderIds: new Set([HELP]), docIds: new Set([DOC]) })
    expect(docScopePermits(scope, { id: DOC, folder_id: HELP })).toBe(true)
    expect(docScopePermits(scope, { id: OTHER, folder_id: HELP })).toBe(false)
    // Folder no longer visible → the lingering pick is not served.
    const hidden = ds({ docIds: new Set([DOC]) })
    expect(docScopePermits(hidden, { id: DOC, folder_id: HELP })).toBe(false)
  })

  it("gates workspace-level docs on the workspaceDocs flag or an explicit pick", () => {
    expect(
      docScopePermits(ds({ includeWorkspaceDocs: true }), { id: DOC, folder_id: null }),
    ).toBe(true)
    expect(docScopePermits(ds({}), { id: DOC, folder_id: null })).toBe(false)
    expect(
      docScopePermits(ds({ docIds: new Set([DOC]) }), { id: DOC, folder_id: null }),
    ).toBe(true)
  })
})
