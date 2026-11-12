import { describe, expect, it } from "vitest"
import { portalContentScope, setProjectScopeRoot } from "./project-scope"
import type { PortalLayout } from "./schema"

describe("setProjectScopeRoot", () => {
  it("replaces an existing promoted root while preserving included folders", () => {
    expect(
      setProjectScopeRoot(
        [
          { id: "folder-a", promote: true },
          "folder-b",
          { id: "folder-c", promote: true },
        ],
        "folder-b",
      ),
    ).toEqual(["folder-a", { id: "folder-b", promote: true }, "folder-c"])
  })

  it("clears promotion without changing the scope", () => {
    expect(
      setProjectScopeRoot(
        [{ id: "folder-a", promote: true }, "folder-b"],
        null,
      ),
    ).toEqual(["folder-a", "folder-b"])
  })
})

function layoutWithPages(
  pages: NonNullable<PortalLayout["pages"]>,
): PortalLayout {
  return {
    schemaVersion: 1,
    theme: {
      brandName: "Acme",
      tagline: "",
      logoUrl: "",
      accentColor: "#000000",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
    },
    header: {
      id: "header",
      type: "portal-header",
      search: { enabled: true, placeholder: "Search" },
    },
    body: [],
    pages,
  }
}

describe("portalContentScope", () => {
  it("adds a page's folders to what the portal addresses", () => {
    expect(
      portalContentScope(
        ["docs-folder"],
        layoutWithPages([
          {
            id: "page-changelog",
            title: "Changelog",
            slug: "changelog",
            scope: ["changelog-folder"],
          },
        ]),
      ),
    ).toEqual(["docs-folder", "changelog-folder"])
  })

  it("keeps a whole-workspace scope unscoped", () => {
    expect(
      portalContentScope(
        null,
        layoutWithPages([
          {
            id: "page-changelog",
            title: "Changelog",
            slug: "changelog",
            scope: ["changelog-folder"],
          },
        ]),
      ),
    ).toBeNull()
  })

  it("returns the project scope untouched when no page carries one", () => {
    const scope = [{ id: "root", promote: true, rootOnly: true }, "guides"]
    expect(portalContentScope(scope, layoutWithPages([]))).toBe(scope)
    expect(portalContentScope(scope, null)).toBe(scope)
  })

  it("widens a structural entry when a page includes the folder recursively", () => {
    expect(
      portalContentScope(
        [{ id: "root", promote: true, rootOnly: true, explicitDocs: true }],
        layoutWithPages([
          {
            id: "page-releases",
            title: "Releases",
            slug: "releases",
            scope: ["root"],
          },
        ]),
      ),
    ).toEqual([{ id: "root", promote: true }])
  })

  it("dedupes doc and workspace-doc entries", () => {
    expect(
      portalContentScope(
        ["guides", { doc: "doc-1" }, { workspaceDocs: true }],
        layoutWithPages([
          {
            id: "page-a",
            title: "A",
            slug: "a",
            scope: ["guides", { doc: "doc-1" }, { doc: "doc-2" }],
          },
        ]),
      ),
    ).toEqual(["guides", { doc: "doc-1" }, { doc: "doc-2" }, { workspaceDocs: true }])
  })
})
