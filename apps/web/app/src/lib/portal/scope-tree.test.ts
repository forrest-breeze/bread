import { describe, expect, it } from "vitest"
import {
  createScopeTreeView,
  docChecked,
  folderCheckState,
  scopeKey,
  scopeForRoot,
  toggleDoc,
  toggleFolder,
  toggleWorkspaceDocs,
  type ScopeTreeContext,
} from "@/lib/portal/scope-tree"
import type { PortalScopeEntry } from "@/lib/public-kb"

// Fixture tree:
//   A        (top-level)   docs: dA
//   ├─ A1                  docs: d1a, d1b
//   └─ A2                  docs: —
//   B        (top-level)   docs: dB
//   (loose)                docs: dL
const FOLDERS = [
  { id: "A", parent_folder_id: null },
  { id: "A1", parent_folder_id: "A" },
  { id: "A2", parent_folder_id: "A" },
  { id: "B", parent_folder_id: null },
]
const DOCS = [
  { id: "dA", folder_id: "A" },
  { id: "d1a", folder_id: "A1" },
  { id: "d1b", folder_id: "A1" },
  { id: "dB", folder_id: "B" },
  { id: "dL", folder_id: null },
]

const workspaceCtx: ScopeTreeContext = { folders: FOLDERS, docs: DOCS, rootId: null }
const rootACtx: ScopeTreeContext = { folders: FOLDERS, docs: DOCS, rootId: "A" }

const ROOT_A: PortalScopeEntry = { id: "A", promote: true, rootOnly: true }

describe("scopeKey", () => {
  it("distinguishes an explicit-doc structural folder from an implicit one", () => {
    expect(scopeKey([{ id: "A", rootOnly: true, explicitDocs: true }])).not.toBe(
      scopeKey([{ id: "A", rootOnly: true }]),
    )
  })

  it("distinguishes an empty scope from the unscoped workspace", () => {
    expect(scopeKey([])).not.toBe(scopeKey(null))
  })
})

describe("scopeForRoot", () => {
  it("workspace root means no scope at all", () => {
    expect(scopeForRoot({ folders: FOLDERS }, null)).toBeNull()
  })

  it("a folder root defaults to the structural root plus all children", () => {
    expect(scopeForRoot({ folders: FOLDERS }, "A")).toEqual([ROOT_A, "A1", "A2"])
  })
})

describe("workspace root (scope = null)", () => {
  it("renders everything checked", () => {
    const view = createScopeTreeView(null, workspaceCtx)
    expect(view.folderState("A")).toBe("full")
    expect(view.folderState("A1")).toBe("full")
    expect(view.docChecked("dL")).toBe(true)
    expect(view.workspaceDocsState()).toBe("full")
  })

  it("unchecking one top-level folder materializes the rest", () => {
    const next = toggleFolder(null, workspaceCtx, "B")
    expect(next).toEqual(["A", { workspaceDocs: true }])
    expect(folderCheckState(next, workspaceCtx, "B")).toBe("none")
    expect(folderCheckState(next, workspaceCtx, "A")).toBe("full")
    expect(docChecked(next, workspaceCtx, "dL")).toBe(true)
    expect(docChecked(next, workspaceCtx, "dB")).toBe(false)
  })

  it("re-checking the folder collapses back to entire workspace", () => {
    const without = toggleFolder(null, workspaceCtx, "B")
    expect(toggleFolder(without, workspaceCtx, "B")).toBeNull()
  })

  it("unchecking the loose-docs group drops the workspaceDocs sentinel", () => {
    const withoutB = toggleFolder(null, workspaceCtx, "B")
    const next = toggleWorkspaceDocs(withoutB, workspaceCtx)
    expect(next).toEqual(["A"])
    expect(docChecked(next, workspaceCtx, "dL")).toBe(false)
  })

  it("unchecking a single loose doc materializes the remaining ones", () => {
    const next = toggleDoc(null, workspaceCtx, "dL")
    // Only one loose doc exists, so the group empties entirely.
    expect(docChecked(next, workspaceCtx, "dL")).toBe(false)
    expect(folderCheckState(next, workspaceCtx, "A")).toBe("full")
    expect(folderCheckState(next, workspaceCtx, "B")).toBe("full")
  })
})

describe("doc-level toggles inside a fully included tree", () => {
  it("unchecking a nested doc demotes only the covering chain", () => {
    const next = toggleDoc(null, workspaceCtx, "d1a")
    // Everything except d1a stays included.
    expect(docChecked(next, workspaceCtx, "d1a")).toBe(false)
    expect(docChecked(next, workspaceCtx, "d1b")).toBe(true)
    expect(docChecked(next, workspaceCtx, "dA")).toBe(true)
    expect(docChecked(next, workspaceCtx, "dB")).toBe(true)
    expect(folderCheckState(next, workspaceCtx, "A")).toBe("partial")
    expect(folderCheckState(next, workspaceCtx, "A1")).toBe("partial")
    expect(folderCheckState(next, workspaceCtx, "A2")).toBe("full")
    expect(folderCheckState(next, workspaceCtx, "B")).toBe("full")
    // A1 carries its remaining doc explicitly; A stays implicit-docs structural.
    expect(next).toContainEqual({ id: "A1", rootOnly: true, explicitDocs: true })
    expect(next).toContainEqual({ id: "A", rootOnly: true })
    expect(next).toContainEqual({ doc: "d1b" })
  })

  it("re-checking the doc normalizes all the way back to entire workspace", () => {
    const without = toggleDoc(null, workspaceCtx, "d1a")
    expect(toggleDoc(without, workspaceCtx, "d1a")).toBeNull()
  })
})

describe("folder root", () => {
  const defaultScope = scopeForRoot({ folders: FOLDERS }, "A")

  it("unchecking a child keeps the structural root and the sibling", () => {
    const next = toggleFolder(defaultScope, rootACtx, "A1")
    expect(next).toEqual([ROOT_A, "A2"])
    expect(folderCheckState(next, rootACtx, "A1")).toBe("none")
  })

  it("checking a single doc inside an unchecked child makes it structural with picked docs", () => {
    const withoutA1 = toggleFolder(defaultScope, rootACtx, "A1")
    const next = toggleDoc(withoutA1, rootACtx, "d1a")
    expect(docChecked(next, rootACtx, "d1a")).toBe(true)
    expect(docChecked(next, rootACtx, "d1b")).toBe(false)
    expect(folderCheckState(next, rootACtx, "A1")).toBe("partial")
    expect(next).toContainEqual({ id: "A1", rootOnly: true, explicitDocs: true })
    expect(next).toContainEqual({ doc: "d1a" })
  })

  it("the root's own docs are implicit until one is unchecked", () => {
    expect(docChecked(defaultScope, rootACtx, "dA")).toBe(true)
    const next = toggleDoc(defaultScope, rootACtx, "dA")
    expect(docChecked(next, rootACtx, "dA")).toBe(false)
    expect(next).toContainEqual({
      id: "A",
      promote: true,
      rootOnly: true,
      explicitDocs: true,
    })
    // Re-checking every root doc drops explicitDocs again.
    const restored = toggleDoc(next, rootACtx, "dA")
    expect(restored).toContainEqual(ROOT_A)
    expect(restored).not.toContainEqual(expect.objectContaining({ explicitDocs: true }))
  })

  it("a legacy recursive root entry is edited as if all children were checked", () => {
    const legacy: PortalScopeEntry[] = ["A"]
    expect(folderCheckState(legacy, rootACtx, "A1")).toBe("full")
    const next = toggleFolder(legacy, rootACtx, "A2")
    expect(next).toEqual([ROOT_A, "A1"])
  })
})

describe("unknown entries are preserved", () => {
  it("keeps a picked doc that is not in the loaded doc list", () => {
    const scope: PortalScopeEntry[] = [ROOT_A, "A1", { doc: "ghost-doc" }]
    const next = toggleFolder(scope, rootACtx, "A2")
    expect(next).toContainEqual({ doc: "ghost-doc" })
  })
})
