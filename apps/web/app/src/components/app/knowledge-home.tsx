"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowRight,
  FilePlus2,
  FileText,
  Folder,
  Loader2,
  Sparkles,
} from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { SourceLogo, sourceLabel } from "@/components/ui/source-logo"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useDocumentHome, useFolders } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { cn, formatRelativeTime } from "@/lib/utils"

function DocumentCard({
  document,
  folderName,
}: {
  document: {
    id: string
    title: string
    preview: string
    source: string
    status: string
    updated_at: string
  }
  folderName?: string
}): React.ReactElement {
  return (
    <HoverPrefetchLink
      href={`/knowledge/${document.id}`}
      className={cn(
        "group flex min-h-56 flex-col rounded-2xl border border-border/70 bg-card p-5",
        "shadow-[0_1px_2px_rgb(0_0_0/0.025)] transition-all duration-200",
        "hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg hover:shadow-foreground/5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/70">
            <SourceLogo source={document.source} size={14} />
          </span>
          <span className="truncate">{sourceLabel(document.source)}</span>
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground/75">
          {formatRelativeTime(document.updated_at)}
        </span>
      </div>

      <h3 className="mt-4 line-clamp-2 text-lg font-semibold leading-6 tracking-tight text-foreground">
        {document.title || "Untitled"}
      </h3>
      <p
        className={cn(
          "mt-2 line-clamp-4 text-sm leading-6",
          document.preview
            ? "text-muted-foreground"
            : "italic text-muted-foreground/60",
        )}
      >
        {document.preview || "This document is empty. Open it to start writing."}
      </p>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-4 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          {folderName ? (
            <Folder className="size-3.5 shrink-0" />
          ) : (
            <FileText className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{folderName || document.status}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          Open
          <ArrowRight className="size-3" />
        </span>
      </div>
    </HoverPrefetchLink>
  )
}

function HomeSkeleton(): React.ReactElement {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading recent documents">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="min-h-56 rounded-2xl border border-border/70 bg-card p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Skeleton className="size-7 rounded-lg" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-3 w-12" />
          </div>
          <Skeleton className="mt-5 h-5 w-3/4" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function KnowledgeHome(): React.ReactElement {
  const router = useRouter()
  const { data: liveData, error: liveError, isLoading, mutate } = useDocumentHome()
  const { data: liveFolderData } = useFolders()
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(false)

  // The SWR cache is seeded synchronously from localStorage (see swr-provider),
  // so cached documents/folders exist on the first client render while the
  // server rendered without them. Hold the server-shaped render (skeletons)
  // until hydration completes so the trees match.
  const hasHydrated = useHasHydrated()
  const data = hasHydrated ? liveData : undefined
  const error = hasHydrated ? liveError : undefined
  const folderData = hasHydrated ? liveFolderData : undefined

  const userFolders = useMemo(
    () => (folderData ?? []).filter((folder) => folder.kind === "user"),
    [folderData],
  )

  const folderNames = useMemo(
    () =>
      new Map(
        userFolders.map((folder) => [
          folder.id,
          folder.display_name || folder.name,
        ]),
      ),
    [userFolders],
  )

  const createDocument = async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    setCreateError(false)

    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled", content: "" }),
      })
      if (!response.ok) throw new Error(`Create failed: ${response.status}`)
      const created = (await response.json()) as { id: string }
      void mutate()
      router.push(`/knowledge/${created.id}`)
    } catch (error) {
      console.error("[Bread] Failed to create document:", error)
      setCreateError(true)
      setCreating(false)
    }
  }

  const documents = data?.documents ?? []
  const totalDocuments = data?.total ?? documents.length

  return (
    <div className="min-h-full overflow-y-auto bg-[radial-gradient(circle_at_top_left,var(--color-muted)_0,transparent_32rem)]">
      <main className="mx-auto w-full max-w-6xl px-6 pb-24 pt-12 sm:px-8 lg:px-10">
        <div>
          <header className="max-w-3xl pr-24 sm:pr-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Sparkles className="size-3.5" />
              Workspace library
            </div>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
              Read what your team knows.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
              Open a recent document to read or edit it, or browse the folders
              your team uses to keep shared knowledge organized.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button onClick={() => void createDocument()} disabled={creating}>
                {creating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FilePlus2 className="size-4" />
                )}
                New document
              </Button>
              {data ? (
                <span className="text-sm text-muted-foreground">
                  {totalDocuments} document{totalDocuments === 1 ? "" : "s"}
                  <span className="mx-2 text-border">/</span>
                  {userFolders.length} folder{userFolders.length === 1 ? "" : "s"}
                </span>
              ) : (
                <Skeleton className="h-4 w-40" />
              )}
            </div>
            {createError ? (
              <p className="mt-2 text-sm text-destructive">
                The document could not be created. Try again.
              </p>
            ) : null}
          </header>
        </div>

        <section className="mt-14" aria-labelledby="recent-documents-heading">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Continue reading
              </p>
              <h2 id="recent-documents-heading" className="mt-1 text-2xl font-semibold tracking-tight">
                Recent documents
              </h2>
            </div>
            {documents.length > 0 ? (
              <p className="hidden text-xs text-muted-foreground sm:block">
                Latest {documents.length} of {totalDocuments}
              </p>
            ) : null}
          </div>

          {error && !data ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/60 px-6 py-14 text-center">
              <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted">
                <FileText className="size-5 text-muted-foreground" />
              </span>
              <h3 className="mt-4 text-base font-semibold">
                Documents could not be loaded
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                Check your connection and try loading the library again.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => void mutate()}
              >
                Try again
              </Button>
            </div>
          ) : !hasHydrated || (isLoading && !data) ? (
            <HomeSkeleton />
          ) : documents.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {documents.map((document) => (
                <DocumentCard
                  key={document.id}
                  document={document}
                  folderName={
                    document.folder_id
                      ? folderNames.get(document.folder_id)
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-card/60 px-6 py-14 text-center">
              <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted">
                <FileText className="size-5 text-muted-foreground" />
              </span>
              <h3 className="mt-4 text-base font-semibold">No documents yet</h3>
              <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                Create your first document or import your existing docs.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
