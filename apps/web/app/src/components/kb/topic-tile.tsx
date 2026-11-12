"use client"

import { useState } from "react"
import {
  GitMerge,
  GripVertical,
  Hash,
  MoreHorizontal,
  Trash2,
} from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MergeTopicDialog,
  DeleteTopicDialog,
} from "@/components/app/topic-actions"
import { useWorkspace } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { formatKbEditedLabel } from "@/components/kb/kb-date"
import {
  TOPIC_DRAG_TYPE,
  type TopicDropEdge,
  type TopicDropTarget,
} from "@/components/kb/topic-drag"
import type { WorkspaceRole } from "@bread/core"
import { cn } from "@/lib/utils"

interface TopicTileProps {
  id: string
  displayName: string
  documentCount: number
  updatedAt?: string | null
  draggableTopic?: boolean
  dragged?: boolean
  dropTarget?: boolean
  onDragStart?: (id: string) => void
  onDragEnd?: () => void
  onDragOverTopic?: (target: TopicDropTarget) => void
  onDropTopic?: (sourceId: string, targetId: string, edge: TopicDropEdge) => void
  onDeleted?: () => void
}

/**
 * A topic tile for the knowledge base portal editor. Renders the same card as
 * a plain link, but for workspace admins it adds inline curation: a hover-/
 * focus-revealed ⋯ button and a right-click context menu, both opening rename,
 * merge, and delete actions. Topic curation is admin-gated server-side, so
 * non-admins see a plain navigational tile with no controls.
 */
export function TopicTile({
  id,
  displayName,
  documentCount,
  updatedAt,
  draggableTopic = false,
  dragged = false,
  dropTarget = false,
  onDragStart,
  onDragEnd,
  onDragOverTopic,
  onDropTopic,
  onDeleted,
}: TopicTileProps): React.ReactElement {
  const { data: workspace } = useWorkspace()
  const hasHydrated = useHasHydrated()
  const renderWorkspace = hasHydrated ? workspace : undefined
  const role = (renderWorkspace?.user_role as WorkspaceRole | undefined) ?? "viewer"
  const isAdmin = role === "owner" || role === "admin"
  const canDrag = isAdmin && draggableTopic
  const editedLabel = formatKbEditedLabel(updatedAt)

  const [menuOpen, setMenuOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const isTopicDrag = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(TOPIC_DRAG_TYPE)
  const getDropEdge = (event: React.DragEvent): TopicDropEdge => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX > rect.left + rect.width / 2 ||
      event.clientY > rect.top + rect.height / 2
      ? "after"
      : "before"
  }

  return (
    <div
      draggable={canDrag}
      className={cn(
        "group relative",
        canDrag && "cursor-grab active:cursor-grabbing",
        dragged && "opacity-50",
      )}
      onContextMenu={
        isAdmin
          ? (e) => {
              e.preventDefault()
              setMenuOpen(true)
            }
          : undefined
      }
      onDragStart={
        canDrag
          ? (event) => {
              event.dataTransfer.setData(TOPIC_DRAG_TYPE, id)
              event.dataTransfer.effectAllowed = "move"
              onDragStart?.(id)
            }
          : undefined
      }
      onDragEnd={canDrag ? onDragEnd : undefined}
      onDragOver={
        canDrag
          ? (event) => {
              if (!isTopicDrag(event)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              onDragOverTopic?.({ id, edge: getDropEdge(event) })
            }
          : undefined
      }
      onDrop={
        canDrag
          ? (event) => {
              if (!isTopicDrag(event)) return
              event.preventDefault()
              const sourceId = event.dataTransfer.getData(TOPIC_DRAG_TYPE)
              onDropTopic?.(sourceId, id, getDropEdge(event))
            }
          : undefined
      }
    >
      <HoverPrefetchLink
        href={`/kb/folder/${id}`}
        className={cn(
          "flex min-h-[104px] flex-col gap-1.5 rounded-lg border border-border/80 bg-card p-4 shadow-sm transition-all hover:border-primary/40 hover:shadow-md",
          canDrag && "cursor-grab active:cursor-grabbing",
          dropTarget && "border-primary/60 bg-primary/5",
        )}
      >
        <div className="flex items-center gap-2 text-muted-foreground group-hover:text-foreground">
          {canDrag && (
            <GripVertical
              className="size-3.5 shrink-0 text-muted-foreground/60"
              aria-hidden="true"
            />
          )}
          <Hash className="size-4 shrink-0" />
          <span className="truncate pr-6 text-sm font-medium text-foreground">
            {displayName}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {documentCount} document{documentCount === 1 ? "" : "s"}
        </span>
        {editedLabel && (
          <span className="text-[11px] text-muted-foreground/70">
            {editedLabel}
          </span>
        )}
      </HoverPrefetchLink>

      {isAdmin && (
        <>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Actions for ${displayName}`}
                  className={cn(
                    "absolute right-2 top-2 size-7 text-muted-foreground opacity-0 transition-opacity",
                    "focus-visible:opacity-100 group-hover:opacity-100",
                    menuOpen && "opacity-100",
                  )}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
                <GitMerge className="mr-2 size-3.5" />
                Merge into…
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-2 size-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <MergeTopicDialog
            open={mergeOpen}
            onOpenChange={setMergeOpen}
            folderId={id}
            displayName={displayName}
            basePath="/kb"
          />
          <DeleteTopicDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            folderId={id}
            displayName={displayName}
            documentCount={documentCount}
            onDeleted={onDeleted}
          />
        </>
      )}
    </div>
  )
}
