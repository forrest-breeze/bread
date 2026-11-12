// ---------------------------------------------------------------------------
// In-memory navigation state for the public portal's sidebar.
//
// The sidebar is rendered by each document page, not by the portal layout, so
// it is rebuilt on every client navigation. Without somewhere to keep its
// state, each click would forget which folders the reader had open and jump
// the rail back to the top. This module holds that state for the life of the
// tab: it survives client navigations and is empty again after a full reload,
// which matches what the server renders (so hydration is unaffected).
//
// Browser only. Nothing here is ever written during a server render, where
// module state would be shared between requests.
// ---------------------------------------------------------------------------

/** Folder id → open/closed, as last left by the reader or by navigation. */
const openGroups = new Map<string, boolean>()

let navigationRailScrollTop: number | null = null

const isBrowser = typeof window !== "undefined"

export function rememberedOpenGroups(): ReadonlyMap<string, boolean> {
  return openGroups
}

export function rememberOpenGroups(state: ReadonlyMap<string, boolean>): void {
  if (!isBrowser) return
  for (const [id, open] of state) openGroups.set(id, open)
}

export function rememberedRailScrollTop(): number | null {
  return navigationRailScrollTop
}

export function rememberRailScrollTop(scrollTop: number): void {
  if (!isBrowser) return
  navigationRailScrollTop = scrollTop
}

/** Test helper: forget everything. */
export function resetPortalNavMemory(): void {
  openGroups.clear()
  navigationRailScrollTop = null
}
