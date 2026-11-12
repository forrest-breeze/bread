"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useSWRConfig } from "swr"
import { MoreHorizontal, Pencil, GitMerge, Trash2, Loader2 } from "lucide-react"
import { useFolders, useWorkspace } from "@/hooks/swr"
import type { WorkspaceRole } from "@bread/core"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface TopicActionsProps {
  folderId: string
  displayName: string
  /** Source count, used for the delete confirmation copy. */
  documentCount?: number
  /**
   * Route prefix the dialogs navigate under after a merge/delete — `/knowledge`
   * for the legacy app view, `/kb` for the knowledge portal. Defaults to
   * `/knowledge` to preserve existing behavior.
   */
  basePath?: string
  /** Called after a successful rename so the parent can revalidate its view. */
  onRenamed?: () => void
}

/**
 * Admin-only rename + merge + delete controls for a topic folder, rendered in
 * the topic page header. Topic taxonomy is admin-managed: a rename whose
 * normalized name collides with another topic folds into it (server-side), an
 * explicit merge folds this topic into a chosen target, and a delete unfiles
 * its sources and removes the topic. All go through the same `/api/folders`
 * endpoints the sweep uses.
 */
export function TopicActions({
  folderId,
  displayName,
  documentCount,
  basePath = "/knowledge",
  onRenamed,
}: TopicActionsProps): React.ReactElement | null {
  const { data: workspace } = useWorkspace()
  const [renameOpen, setRenameOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const role = (workspace?.user_role as WorkspaceRole | undefined) ?? "viewer"
  const isAdmin = role === "owner" || role === "admin"

  // Topic curation is admin-gated server-side; hide the affordance for everyone
  // else rather than show controls that always 403.
  if (!isAdmin) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label="Topic actions"
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil className="mr-2 size-3.5" />
            Rename topic
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
            <GitMerge className="mr-2 size-3.5" />
            Merge into…
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 className="mr-2 size-3.5" />
            Delete topic
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameTopicDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        folderId={folderId}
        currentName={displayName}
        basePath={basePath}
        onRenamed={onRenamed}
      />
      <MergeTopicDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        folderId={folderId}
        displayName={displayName}
        basePath={basePath}
      />
      <DeleteTopicDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        folderId={folderId}
        displayName={displayName}
        documentCount={documentCount}
        // Deleting the topic you're viewing removes this page — send the user
        // back to the knowledge base root.
        redirectTo={basePath}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

interface RenameTopicDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderId: string
  currentName: string
  basePath?: string
  onRenamed?: () => void
}

export function RenameTopicDialog({
  open,
  onOpenChange,
  folderId,
  currentName,
  basePath = "/knowledge",
  onRenamed,
}: RenameTopicDialogProps): React.ReactElement {
  const router = useRouter()
  const { mutate: globalMutate } = useSWRConfig()
  const [name, setName] = useState(currentName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the field whenever the dialog re-opens for a (possibly different) topic.
  const resetKey = `${folderId}:${open}`
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey)
    setName(currentName)
    setError(null)
  }

  const trimmed = name.trim()
  const unchanged = trimmed === currentName.trim()

  const handleSave = async (): Promise<void> => {
    if (!trimmed || unchanged) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      })
      const data = (await res.json().catch(() => null)) as
        | { merged?: boolean; target_id?: string; error?: string }
        | null
      if (!res.ok) {
        setError(data?.error ?? "Couldn't rename this topic.")
        return
      }
      onOpenChange(false)
      void globalMutate("/api/folders")
      // A rename that collided with an existing topic is a merge — the server
      // folds this folder away, so navigate to the surviving target.
      if (data?.merged && data.target_id) {
        router.push(`${basePath}/folder/${data.target_id}`)
      } else {
        onRenamed?.()
      }
    } catch {
      setError("Couldn't rename this topic.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename topic</DialogTitle>
          <DialogDescription>
            Renaming to an existing topic&apos;s name merges this topic into it.
            The old name is kept as an alias so future ingestion routes here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="topic-name">Topic name</Label>
          <Input
            id="topic-name"
            value={name}
            autoFocus
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSave()
            }}
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !trimmed || unchanged}
          >
            {saving && <Loader2 className="mr-2 size-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

interface MergeTopicDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderId: string
  displayName: string
  basePath?: string
}

export function MergeTopicDialog({
  open,
  onOpenChange,
  folderId,
  displayName,
  basePath = "/knowledge",
}: MergeTopicDialogProps): React.ReactElement {
  const router = useRouter()
  const { mutate: globalMutate } = useSWRConfig()
  const { data: folders, isLoading } = useFolders()
  const [targetId, setTargetId] = useState<string>("")
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the selection each time the dialog opens.
  const resetKey = `${folderId}:${open}`
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey)
    setTargetId("")
    setError(null)
  }

  const targets = useMemo(
    () =>
      (folders ?? [])
        .filter((f) => f.kind === "topic" && f.id !== folderId)
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [folders, folderId],
  )

  const handleMerge = async (): Promise<void> => {
    if (!targetId) return
    setMerging(true)
    setError(null)
    try {
      const res = await fetch("/api/folders/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_ids: [folderId], target_id: targetId }),
      })
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setError(data?.error ?? "Couldn't merge this topic.")
        return
      }
      onOpenChange(false)
      void globalMutate("/api/folders")
      router.push(`${basePath}/folder/${targetId}`)
    } catch {
      setError("Couldn't merge this topic.")
    } finally {
      setMerging(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge topic</DialogTitle>
          <DialogDescription>
            Fold <span className="font-medium">{displayName}</span> into another
            topic. Its sources move to the target, the target&apos;s page
            regenerates, and this topic is removed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="merge-target">Merge into</Label>
          <Select
            value={targetId}
            onValueChange={(value) => setTargetId(value as string)}
          >
            <SelectTrigger id="merge-target">
              <SelectValue
                placeholder={
                  isLoading
                    ? "Loading topics…"
                    : targets.length === 0
                      ? "No other topics"
                      : "Select a topic"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {targets.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleMerge()}
            disabled={merging || !targetId}
          >
            {merging && <Loader2 className="mr-2 size-3.5 animate-spin" />}
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

interface DeleteTopicDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderId: string
  displayName: string
  /** Source count, used to explain what happens to the topic's documents. */
  documentCount?: number
  /**
   * If set, navigate here after a successful delete (e.g. when the deleted
   * topic was the page being viewed). Omit to stay in place and let SWR
   * revalidation drop the topic from the list.
   */
  redirectTo?: string
  onDeleted?: () => void
}

export function DeleteTopicDialog({
  open,
  onOpenChange,
  folderId,
  displayName,
  documentCount,
  redirectTo,
  onDeleted,
}: DeleteTopicDialogProps): React.ReactElement {
  const router = useRouter()
  const { mutate: globalMutate } = useSWRConfig()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Clear any prior error each time the dialog re-opens.
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) setError(null)
  }

  const count = documentCount ?? 0

  const handleDelete = async (): Promise<void> => {
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/folders/${folderId}`, { method: "DELETE" })
      const data = (await res.json().catch(() => null)) as
        | { error?: string }
        | null
      if (!res.ok) {
        setError(data?.error ?? "Couldn't delete this topic.")
        return
      }
      onOpenChange(false)
      void globalMutate("/api/folders")
      router.refresh()
      if (redirectTo) {
        router.push(redirectTo)
      } else {
        onDeleted?.()
      }
    } catch {
      setError("Couldn't delete this topic.")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete topic</AlertDialogTitle>
          <AlertDialogDescription>
            Remove <span className="font-medium">{displayName}</span>?{" "}
            {count > 0
              ? `Its ${count} source${count === 1 ? "" : "s"} stay in your knowledge base — they're just unfiled from this topic.`
              : "This topic has no sources."}{" "}
            This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={() => void handleDelete()}
          >
            {deleting && <Loader2 className="mr-2 size-3.5 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
