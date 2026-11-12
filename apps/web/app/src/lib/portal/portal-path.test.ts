import { describe, expect, it } from "vitest"
import { parsePortalPath, PORTAL_RESERVED_PROJECT_SLUGS } from "./portal-path"

describe("parsePortalPath", () => {
  it("reserves every structural path segment from project slugs", () => {
    expect(Array.from(PORTAL_RESERVED_PROJECT_SLUGS).sort()).toEqual([
      "doc",
      "folder",
      "page",
    ])
  })

  it("parses default-project document refs with nested public slugs", () => {
    expect(parsePortalPath(["acme", "doc", "guides", "setup", "install"])).toEqual({
      workspaceSlug: "acme",
      projectSlug: null,
      view: "doc",
      refId: "guides/setup/install",
      pageDocRef: null,
    })
  })

  it("parses named-project document refs with nested public slugs", () => {
    expect(
      parsePortalPath(["acme", "docs", "doc", "guides", "setup", "install"]),
    ).toEqual({
      workspaceSlug: "acme",
      projectSlug: "docs",
      view: "doc",
      refId: "guides/setup/install",
      pageDocRef: null,
    })
  })

  it("rejects folder pages for default and named projects", () => {
    expect(parsePortalPath(["acme", "folder", "folder-id"])).toBeNull()
    expect(parsePortalPath(["acme", "docs", "folder", "folder-id"])).toBeNull()
    expect(parsePortalPath(["acme", "folder"])).toBeNull()
  })

  it("allows a document named folder", () => {
    expect(parsePortalPath(["acme", "doc", "folder"])?.refId).toBe("folder")
    expect(parsePortalPath(["acme", "doc", "folder", "intro"])?.refId).toBe("folder/intro")
  })

  it("parses project-local pages for default and named projects", () => {
    expect(parsePortalPath(["acme", "page", "api-reference"])).toEqual({
      workspaceSlug: "acme",
      projectSlug: null,
      view: "page",
      refId: "api-reference",
      pageDocRef: null,
    })
    expect(
      parsePortalPath(["acme", "developers", "page", "changelog"]),
    ).toEqual({
      workspaceSlug: "acme",
      projectSlug: "developers",
      view: "page",
      refId: "changelog",
      pageDocRef: null,
    })
  })

  it("parses one document addressed within a page", () => {
    expect(
      parsePortalPath(["acme", "page", "api-reference", "list-documents"]),
    ).toEqual({
      workspaceSlug: "acme",
      projectSlug: null,
      view: "page",
      refId: "api-reference",
      pageDocRef: "list-documents",
    })
    expect(
      parsePortalPath([
        "acme",
        "developers",
        "page",
        "api-reference",
        "documents",
        "list",
      ]),
    ).toEqual({
      workspaceSlug: "acme",
      projectSlug: "developers",
      view: "page",
      refId: "api-reference",
      pageDocRef: "documents/list",
    })
  })
})
