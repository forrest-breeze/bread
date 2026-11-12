/**
 * Repository ingestion produces searchable source material, not automatically
 * curated knowledge pages. Keep unfiled GitHub captures out of the human
 * Documents tree; moving one into a real folder explicitly promotes it.
 */
export function isNavigableDocument(document: {
  source: string | null
  folder_id: string | null
}): boolean {
  return (
    document.folder_id !== null ||
    document.source?.toLowerCase() !== "github"
  )
}

