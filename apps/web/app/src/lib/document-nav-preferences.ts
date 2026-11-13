export type DocumentNavSortMode = "custom" | "alphabetical" | "created" | "recent"

export const DOCUMENT_NAV_SORT_OPTIONS: ReadonlyArray<{
  value: DocumentNavSortMode
  label: string
  description: string
}> = [
  { value: "custom", label: "Custom", description: "Drag to reorder" },
  { value: "alphabetical", label: "Alphabetical", description: "A-Z" },
  { value: "created", label: "Date created", description: "Newest first" },
  { value: "recent", label: "Last updated", description: "Newest first" },
]

export const DEFAULT_DOCUMENT_NAV_SORT_MODE: DocumentNavSortMode = "alphabetical"

/**
 * The portal builder defaults to the published portal's explicit drag order,
 * and keeps its own preference — the knowledge sidebar and the builder are
 * deliberately not synced.
 */
export const DEFAULT_BUILDER_DOCUMENT_SORT_MODE: DocumentNavSortMode = "custom"

const STORAGE_KEY = "breezify-doc-nav-sort-mode"
const BUILDER_STORAGE_KEY = "breezify-kb-builder-doc-sort-mode"

function isDocumentNavSortMode(value: string | null): value is DocumentNavSortMode {
  return DOCUMENT_NAV_SORT_OPTIONS.some((option) => option.value === value)
}

function readStoredSortMode(
  key: string,
  fallback: DocumentNavSortMode,
): DocumentNavSortMode {
  if (typeof window === "undefined") return fallback

  const stored = window.localStorage.getItem(key)
  return isDocumentNavSortMode(stored) ? stored : fallback
}

export function getStoredDocumentNavSortMode(): DocumentNavSortMode {
  return readStoredSortMode(STORAGE_KEY, DEFAULT_DOCUMENT_NAV_SORT_MODE)
}

export function setStoredDocumentNavSortMode(mode: DocumentNavSortMode): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, mode)
}

export function getStoredBuilderDocumentSortMode(): DocumentNavSortMode {
  return readStoredSortMode(BUILDER_STORAGE_KEY, DEFAULT_BUILDER_DOCUMENT_SORT_MODE)
}

export function setStoredBuilderDocumentSortMode(mode: DocumentNavSortMode): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(BUILDER_STORAGE_KEY, mode)
}

const OPEN_FOLDERS_STORAGE_KEY = "breezify-doc-nav-open-folders"

export function getStoredOpenFolderIds(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(OPEN_FOLDERS_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === "string"))
      : new Set()
  } catch {
    return new Set()
  }
}

export function setStoredOpenFolderIds(ids: Set<string>): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(OPEN_FOLDERS_STORAGE_KEY, JSON.stringify([...ids]))
}

/**
 * Clears the persisted open-folder set. Folder ids reveal another user's
 * workspace structure, so this is wiped on logout / user switch alongside the
 * SWR cache. Called from the client-state purge in swr-provider.
 */
export function clearStoredOpenFolderIds(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(OPEN_FOLDERS_STORAGE_KEY)
  } catch {
    // ignore
  }
}
