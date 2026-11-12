"use client"

import useSWR, { useSWRConfig } from "swr"
import { AlertCircle, FileText, Loader2, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useState } from "react"

interface TrashedDocument {
  id: string
  title: string
  source: string | null
  author: string | null
  folder_id: string | null
  deleted_at: string
  updated_at: string
}

interface TrashResponse {
  documents: TrashedDocument[]
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  return res.json() as Promise<T>
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export default function TrashPage(): React.ReactElement {
  const { mutate: globalMutate } = useSWRConfig()
  const { data, isLoading, mutate } = useSWR<TrashResponse>(
    "/api/documents/trash",
    fetcher,
  )
  const documents = data?.documents ?? []
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<TrashedDocument | null>(
    null,
  )
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function restoreDocument(doc: TrashedDocument): Promise<void> {
    setBusyId(doc.id)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch(`/api/documents/${doc.id}/restore`, {
        method: "POST",
      })
      if (!res.ok) throw new Error("Restore failed")
      await mutate(
        (current) => ({
          documents:
            current?.documents.filter((item) => item.id !== doc.id) ?? [],
        }),
        { revalidate: false },
      )
      void globalMutate("/api/documents")
      void globalMutate(`/api/documents/${doc.id}`)
      setMessage(`Restored "${doc.title}".`)
    } catch {
      setError("Failed to restore note.")
    } finally {
      setBusyId(null)
    }
  }

  async function permanentlyDeleteDocument(doc: TrashedDocument): Promise<void> {
    setBusyId(doc.id)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch(`/api/documents/${doc.id}?permanent=true`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error("Permanent delete failed")
      await mutate(
        (current) => ({
          documents:
            current?.documents.filter((item) => item.id !== doc.id) ?? [],
        }),
        { revalidate: false },
      )
      void globalMutate(`/api/documents/${doc.id}`, undefined, {
        revalidate: false,
      })
      setMessage(`Permanently deleted "${doc.title}".`)
    } catch {
      setError("Failed to permanently delete note.")
    } finally {
      setBusyId(null)
      setConfirmDelete(null)
    }
  }

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold">Trash</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Notes moved to trash stay here until restored or permanently deleted.
        </p>
      </div>

      {(message || error) && (
        <div
          role="status"
          className={
            error
              ? "flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              : "flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
          }
        >
          <AlertCircle className="size-4 shrink-0" />
          <span>{error ?? message}</span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Deleted notes</CardTitle>
          <CardDescription>
            Restore notes back to the knowledge base or remove them forever.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && !data ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/5" />
                  </div>
                  <Skeleton className="h-7 w-24" />
                </div>
              ))}
            </div>
          ) : documents.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
              <Trash2 className="size-8 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium">Trash is empty</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Deleted notes will appear here.
              </p>
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {documents.map((doc) => {
                const busy = busyId === doc.id
                return (
                  <div
                    key={doc.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <FileText className="size-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <a
                          href={`/knowledge/${doc.id}`}
                          className="block truncate text-sm font-medium hover:underline"
                        >
                          {doc.title || "Untitled"}
                        </a>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Moved to trash {formatDate(doc.deleted_at)}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void restoreDocument(doc)}
                        disabled={busy}
                      >
                        {busy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setConfirmDelete(doc)}
                        disabled={busy}
                      >
                        <Trash2 className="size-3.5" />
                        Delete forever
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete note?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes "{confirmDelete?.title ?? "Untitled"}".
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmDelete) void permanentlyDeleteDocument(confirmDelete)
              }}
            >
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
