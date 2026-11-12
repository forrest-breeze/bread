// ---------------------------------------------------------------------------
// Client-side document switching for Knowledge.
//
// /knowledge/<id> is a thin shell: the server contributes nothing but
// `<DocumentEditor documentId>`, and the document itself comes from the SWR
// cache. Routing each document click through the server therefore buys nothing
// and costs a round-trip behind a loading skeleton, every time, even for a
// document opened a moment ago.
//
// Instead the Knowledge layout renders the editor from the URL (see
// KnowledgeDocumentOutlet) and document clicks update the URL with
// history.pushState. Next.js syncs pushState into usePathname, so the layout
// re-renders with the new id immediately and no request is made. Deep links,
// reloads and back/forward keep working because the URL is still the real
// route.
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The open document's id for a `/knowledge/<uuid>` path, else null. */
export function knowledgeDocumentIdFromPath(
  pathname: string | null | undefined,
): string | null {
  if (!pathname?.startsWith("/knowledge/")) return null
  const rest = pathname.slice("/knowledge/".length)
  if (rest.includes("/")) return null
  let id: string
  try {
    id = decodeURIComponent(rest)
  } catch {
    return null
  }
  return UUID_RE.test(id) ? id : null
}

export function knowledgeDocumentPath(id: string): string {
  return `/knowledge/${encodeURIComponent(id)}`
}

/**
 * Whether a document can be opened without a server navigation: the Knowledge
 * layout (which renders the editor from the URL) must already be mounted.
 */
export function canOpenKnowledgeDocumentInPlace(
  pathname: string | null | undefined,
  id: string,
): boolean {
  if (typeof window === "undefined") return false
  if (!UUID_RE.test(id)) return false
  return pathname === "/knowledge" || Boolean(pathname?.startsWith("/knowledge/"))
}

/**
 * Switch the open document in place. Callers check canOpen… first. `query`
 * (e.g. "?page=reference") is carried onto the URL unchanged.
 */
export function openKnowledgeDocumentInPlace(id: string, query = ""): void {
  const path = knowledgeDocumentPath(id)
  if (
    window.location.pathname === path &&
    window.location.search === query
  ) {
    return
  }
  window.history.pushState(null, "", `${path}${query}`)
}
