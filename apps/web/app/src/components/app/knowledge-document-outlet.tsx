"use client"

import { useState } from "react"
import dynamic from "next/dynamic"
import { usePathname } from "next/navigation"
import { useSWRConfig } from "swr"
import DocumentLoading from "@/app/(app)/knowledge/[id]/loading"
import { LoadingBar } from "@/components/ui/loading-bar"
import { useDocument } from "@/hooks/swr"
import { knowledgeDocumentIdFromPath } from "@/lib/knowledge-route"

// Loaded on demand so the editor (the largest chunk in the app) stays out of
// the Knowledge home bundle. The document tree warms it when idle.
const DocumentEditor = dynamic(
  () =>
    import("@/components/app/document-editor").then(
      (mod) => mod.DocumentEditor,
    ),
  { loading: () => <DocumentLoading /> },
)

/**
 * Renders the open document from the URL rather than from the server-rendered
 * page, so switching documents is a client-side URL change with no server
 * round-trip (see lib/knowledge-route.ts). Every other Knowledge route renders
 * the page the server sent.
 *
 * When switching between documents, the current one stays on screen until the
 * next one's content is available, then the two swap in a single step. A
 * document that is already cached swaps immediately; one that has to be
 * fetched never leaves the reader looking at an empty page or a skeleton. A
 * thin progress bar appears only if the fetch takes longer than 200ms.
 */
export function KnowledgeDocumentOutlet({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  const targetId = knowledgeDocumentIdFromPath(usePathname())
  const [shownId, setShownId] = useState<string | null>(targetId)

  // Same revalidation rule as the editor: a just-created document exists only
  // as an optimistic cache entry until its first save, so it must not be
  // refetched (and 404) here.
  const { cache } = useSWRConfig()
  const cached = targetId
    ? (cache.get(`/api/documents/${targetId}`)?.data as
        | { __optimistic?: boolean }
        | undefined)
    : undefined
  const skipRevalidate = cached?.__optimistic === true
  const { data, error } = useDocument(targetId, {
    revalidateIfStale: !skipRevalidate,
    revalidateOnMount: !skipRevalidate,
  })
  // An error is "ready" too: the editor owns the not-found / failed states.
  const targetReady = data !== undefined || error !== undefined

  // Adjust state during render (no effect, no extra paint): leave immediately
  // when no document is open; switch as soon as the target can render; and
  // never hold when there is nothing on screen to hold.
  if (targetId !== shownId && (targetId === null || shownId === null || targetReady)) {
    setShownId(targetId)
  }

  if (!targetId) return <>{children}</>

  const displayedId = shownId ?? targetId
  const switching = displayedId !== targetId
  return (
    <>
      {switching ? (
        <LoadingBar
          label="Opening document"
          className="delayed-reveal pointer-events-none fixed inset-x-0 top-0 z-50 rounded-none bg-transparent"
          // Explicit height: the builder frame resets direct child div heights.
          style={{ height: 2 }}
        />
      ) : null}
      {/* Keyed so switching documents always unmounts the previous editor,
          which saves its pending edits on the way out. */}
      <DocumentEditor key={displayedId} documentId={displayedId} />
    </>
  )
}
