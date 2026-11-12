import type { PortalScopeEntry } from "@/lib/public-kb"
import type { PortalLayout } from "@/lib/portal/schema"

/**
 * Replace the single promoted root for a normalized project scope without
 * changing which content is included. Passing null clears promotion. Folder
 * entries keep their structural flags (rootOnly / explicitDocs); doc and
 * workspaceDocs entries pass through untouched.
 */
export function setProjectScopeRoot(
  scope: PortalScopeEntry[],
  rootFolderId: string | null,
): PortalScopeEntry[] {
  return scope.map((entry) => {
    if (typeof entry === "object" && !("id" in entry)) return entry
    const id = typeof entry === "string" ? entry : entry.id
    const rootOnly = typeof entry === "object" && entry.rootOnly === true
    const explicitDocs = typeof entry === "object" && entry.explicitDocs === true
    const promote = id === rootFolderId
    if (!promote && !rootOnly && !explicitDocs) return id
    return {
      id,
      ...(promote ? { promote: true } : {}),
      ...(rootOnly ? { rootOnly: true } : {}),
      ...(explicitDocs ? { explicitDocs: true } : {}),
    }
  })
}

/**
 * The scope of everything a portal ADDRESSES: the project scope widened by
 * every page's own scope.
 *
 * A page's `scope` is authoritative for what that page renders — a landing
 * or reference page includes its folders whether or not the project's home
 * scope does. But the documents a page lists link into the project's own
 * `/doc/<slug>` and `/folder/<id>` routes, and portal search should find them,
 * so those surfaces gate on this union instead of the narrower home scope.
 * Layout builders keep using the project scope, so adding a page never changes
 * what the home renders.
 *
 * A null project scope already means "the whole workspace" and stays null.
 * Where the same folder appears in both scopes the WIDER form wins: a
 * recursive entry beats a structural (rootOnly / explicitDocs) one, and a
 * promoted root stays promoted.
 */
export function portalContentScope(
  scope: PortalScopeEntry[] | null,
  layout: PortalLayout | null,
): PortalScopeEntry[] | null {
  if (!scope) return null
  const pageScopes = (layout?.pages ?? []).flatMap((page) => page.scope ?? [])
  if (pageScopes.length === 0) return scope

  const folders = new Map<
    string,
    { promote: boolean; rootOnly: boolean; explicitDocs: boolean }
  >()
  const docs = new Set<string>()
  let workspaceDocs = false
  const merged: PortalScopeEntry[] = []

  for (const entry of [...scope, ...pageScopes]) {
    if (typeof entry === "object" && "doc" in entry) {
      docs.add(entry.doc)
      continue
    }
    if (typeof entry === "object" && "workspaceDocs" in entry) {
      workspaceDocs = true
      continue
    }
    const id = typeof entry === "string" ? entry : entry.id
    const rootOnly = typeof entry === "object" && entry.rootOnly === true
    const explicitDocs = typeof entry === "object" && entry.explicitDocs === true
    const promote = typeof entry === "object" && entry.promote === true
    const seen = folders.get(id)
    if (!seen) {
      folders.set(id, { promote, rootOnly, explicitDocs })
      continue
    }
    folders.set(id, {
      promote: seen.promote || promote,
      // Any recursive occurrence widens the entry for good.
      rootOnly: seen.rootOnly && rootOnly,
      explicitDocs: seen.explicitDocs && explicitDocs,
    })
  }

  for (const [id, flags] of folders) {
    merged.push(
      flags.promote || flags.rootOnly
        ? {
            id,
            ...(flags.promote ? { promote: true } : {}),
            ...(flags.rootOnly ? { rootOnly: true } : {}),
            ...(flags.explicitDocs ? { explicitDocs: true } : {}),
          }
        : id,
    )
  }
  for (const doc of docs) merged.push({ doc })
  if (workspaceDocs) merged.push({ workspaceDocs: true })
  return merged
}
