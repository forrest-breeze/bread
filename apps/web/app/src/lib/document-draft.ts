/**
 * Local crash-recovery drafts for the document editor.
 *
 * Auto-save no longer touches the server — it writes the in-progress document
 * to localStorage so that a crash, accidental tab close, or navigation away
 * never loses work. The server is updated only when the user explicitly saves.
 * On reopening a document, a newer local draft is offered for restoration.
 */

const DRAFT_PREFIX = "breezify:doc-draft:"

export interface DocumentDraft {
  title: string
  content: string
  /** ISO timestamp of when this draft was last written. */
  savedAt: string
}

function draftKey(documentId: string): string {
  return `${DRAFT_PREFIX}${documentId}`
}

/** Reads the locally-stored draft for a document, or null if none/corrupt. */
export function readDraft(documentId: string): DocumentDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(documentId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DocumentDraft>
    if (
      typeof parsed.title !== "string" ||
      typeof parsed.content !== "string" ||
      typeof parsed.savedAt !== "string"
    ) {
      return null
    }
    return { title: parsed.title, content: parsed.content, savedAt: parsed.savedAt }
  } catch {
    return null
  }
}

/** Persists a draft to localStorage. Safe to call synchronously on unload. */
export function writeDraft(documentId: string, draft: DocumentDraft): void {
  try {
    localStorage.setItem(draftKey(documentId), JSON.stringify(draft))
  } catch {
    // Quota exceeded or storage unavailable — crash recovery is best-effort.
  }
}

/** Removes a document's draft (e.g. after a successful server save). */
export function clearDraft(documentId: string): void {
  try {
    localStorage.removeItem(draftKey(documentId))
  } catch {
    // ignore
  }
}

/**
 * Removes every locally-stored document draft. Drafts are keyed only by
 * document id, so on logout / user switch they must be wiped — otherwise a
 * different user on the same browser could see the previous user's
 * uncommitted edits. Called from the client-state purge in swr-provider.
 */
export function clearAllDrafts(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(DRAFT_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => localStorage.removeItem(key))
  } catch {
    // storage unavailable
  }
}
