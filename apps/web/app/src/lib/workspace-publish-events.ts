/**
 * Lets a workspace-level publish action wait for the document editor that is
 * currently mounted in the main pane. Event listeners must register their
 * save promise synchronously, mirroring the Service Worker `waitUntil` shape.
 */
export const PREPARE_WORKSPACE_PUBLISH_EVENT =
  "bread:prepare-workspace-publish"

export const WORKSPACE_DOCUMENT_SAVED_EVENT =
  "bread:workspace-document-saved"

export interface WorkspaceDocumentSavedEventDetail {
  documentId: string
  savedAt: string
  revision: number
}

let workspaceDocumentSaveRevision = 0
let latestWorkspaceDocumentSave: { documentId: string; recordedAt: number } | null =
  null

/**
 * Records a persisted workspace edit. GitHub comparison surfaces use the
 * revision to invalidate both their lightweight status and cached full diff.
 */
export function notifyWorkspaceDocumentSaved(
  detail: Omit<WorkspaceDocumentSavedEventDetail, "revision">,
): void {
  if (typeof window === "undefined") return

  workspaceDocumentSaveRevision += 1
  latestWorkspaceDocumentSave = {
    documentId: detail.documentId,
    recordedAt: Date.now(),
  }
  window.dispatchEvent(
    new CustomEvent<WorkspaceDocumentSavedEventDetail>(
      WORKSPACE_DOCUMENT_SAVED_EVENT,
      {
        detail: { ...detail, revision: workspaceDocumentSaveRevision },
      },
    ),
  )
}

/** Avoid duplicating a local editor refresh when its realtime echo arrives. */
export function wasWorkspaceDocumentSavedRecently(
  documentId: string,
  maxAgeMs = 5_000,
): boolean {
  return Boolean(
    latestWorkspaceDocumentSave?.documentId === documentId &&
      Date.now() - latestWorkspaceDocumentSave.recordedAt <= maxAgeMs,
  )
}

export function getWorkspaceDocumentSaveRevision(): number {
  return workspaceDocumentSaveRevision
}

export function subscribeToWorkspaceDocumentSaves(
  listener: (detail: WorkspaceDocumentSavedEventDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {}

  const handleSaved = (event: Event): void => {
    const detail = (
      event as CustomEvent<WorkspaceDocumentSavedEventDetail>
    ).detail
    if (detail) listener(detail)
  }
  window.addEventListener(WORKSPACE_DOCUMENT_SAVED_EVENT, handleSaved)
  return () =>
    window.removeEventListener(WORKSPACE_DOCUMENT_SAVED_EVENT, handleSaved)
}

export interface PrepareWorkspacePublishEventDetail {
  waitUntil(save: Promise<boolean>): void
}

export async function saveActiveDocumentBeforeWorkspacePublish(): Promise<void> {
  if (typeof window === "undefined") return

  const saves: Promise<boolean>[] = []
  const event = new CustomEvent<PrepareWorkspacePublishEventDetail>(
    PREPARE_WORKSPACE_PUBLISH_EVENT,
    {
      detail: {
        waitUntil(save) {
          saves.push(Promise.resolve(save))
        },
      },
    },
  )

  window.dispatchEvent(event)
  const results = await Promise.all(saves)
  if (results.some((saved) => !saved)) {
    throw new Error(
      "Save the active document successfully before publishing workspace changes.",
    )
  }
}
