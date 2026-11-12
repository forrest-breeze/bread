// Shared by the server icon resolver (dsl/icon.tsx) and the client one
// (components/icons/dynamic-lucide-icon.tsx) so both normalize names the
// same way.

/** "FileText" / "file_text" / "File Text" → "file-text" (lucide module key). */
export function toLucideKey(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "")
}

/** Folder headers omit the generic default mark and its reserved space. */
export function hasCustomFolderIcon(name?: string | null): boolean {
  const key = name ? toLucideKey(name) : ""
  return Boolean(key && key !== "folder" && key !== "default")
}
