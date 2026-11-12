// Public document and collection routes. Folder URLs are no longer pages.

export const PORTAL_RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set([
  "doc",
  "folder",
  "page",
])

export type PortalView = "home" | "doc" | "page"

export interface ParsedPortalPath {
  workspaceSlug: string
  /** null = the workspace's default project (served at root). */
  projectSlug: string | null
  view: PortalView
  /** Document/folder ref for "doc"/"folder" views, page slug for "page"; null for "home". */
  refId: string | null
  /**
   * Document selected inside a "page" view — how an API reference addresses one
   * endpoint. null on every other view, and on a page's own root.
   */
  pageDocRef: string | null
}

export function parsePortalPath(path: string[]): ParsedPortalPath | null {
  const segs = path.filter((s) => s.length > 0)
  const [a, b, c, d] = segs
  if (!a || b === "folder" || (c === "folder" && b !== "doc" && b !== "page")) return null

  // [ws]
  if (segs.length === 1) {
    return {
      workspaceSlug: a,
      projectSlug: null,
      view: "home",
      refId: null,
      pageDocRef: null,
    }
  }
  // [ws, "doc", ...ref] — default project document
  if (b === "doc" && segs.length >= 3) {
    return {
      workspaceSlug: a,
      projectSlug: null,
      view: "doc",
      refId: segs.slice(2).join("/"),
      pageDocRef: null,
    }
  }
  // [ws, "page", slug, ...ref?] — default project page, optionally one of its docs
  if (b === "page" && segs.length >= 3) {
    return {
      workspaceSlug: a,
      projectSlug: null,
      view: "page",
      refId: c ?? null,
      pageDocRef: segs.length > 3 ? segs.slice(3).join("/") : null,
    }
  }
  // [ws, project] — named project home
  if (segs.length === 2) {
    return {
      workspaceSlug: a,
      projectSlug: b,
      view: "home",
      refId: null,
      pageDocRef: null,
    }
  }
  // [ws, project, "doc", ...ref] — named project document
  if (c === "doc" && segs.length >= 4) {
    return {
      workspaceSlug: a,
      projectSlug: b,
      view: "doc",
      refId: segs.slice(3).join("/"),
      pageDocRef: null,
    }
  }
  // [ws, project, "page", slug, ...ref?] — named project page, optionally one doc
  if (c === "page" && segs.length >= 4) {
    return {
      workspaceSlug: a,
      projectSlug: b,
      view: "page",
      refId: d ?? null,
      pageDocRef: segs.length > 4 ? segs.slice(4).join("/") : null,
    }
  }
  return null
}
