"use client"

import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import {
  ChevronRight,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"

interface HeadingRef {
  level: 1 | 2 | 3
  text: string
  nodeId: string | null
}

export interface OutlinePage {
  name: string
  nodeId: string | null
  html: string
}

interface DocumentOutlineProps {
  pages: OutlinePage[]
  activePage: number
  onActivatePage: (index: number, scrollNodeId?: string | null) => void
  onAddPage?: () => void
  onRenamePage?: (index: number, newName: string) => void
  onDeletePage?: (index: number) => void
  onReorderPages?: (from: number, to: number) => void
}

function parseHeadings(html: string): HeadingRef[] {
  if (!html) return []
  const container = document.createElement("div")
  container.innerHTML = html
  const nodes = container.querySelectorAll("h1, h2, h3")
  const headings: HeadingRef[] = []
  nodes.forEach((node) => {
    const text = (node.textContent ?? "").trim()
    if (text.length === 0) return
    const level = Number.parseInt(node.tagName[1], 10) as 1 | 2 | 3
    headings.push({
      level,
      text,
      nodeId: node.getAttribute("data-node-id"),
    })
  })
  return headings
}

interface PageLabelProps {
  pageNumber: number
  name: string
  isActive: boolean
  isEditing: boolean
  editValue: string
  onChangeEdit: (value: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onActivate: () => void
  onOpenMenu?: (x: number, y: number) => void
  hasMenu: boolean
}

function PageLabel({
  pageNumber,
  name,
  isActive,
  isEditing,
  editValue,
  onChangeEdit,
  onCommitEdit,
  onCancelEdit,
  onActivate,
  onOpenMenu,
  hasMenu,
}: PageLabelProps): React.ReactElement {
  const displayName = name || `Page ${pageNumber}`

  if (isEditing) {
    return (
      <div className="flex flex-1 items-center gap-1.5 rounded px-1.5 py-1">
        <FileText className="size-3 shrink-0 text-muted-foreground/60" />
        <input
          autoFocus
          value={editValue}
          onChange={(e) => onChangeEdit(e.target.value)}
          onBlur={onCommitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              onCommitEdit()
            }
            if (e.key === "Escape") {
              e.preventDefault()
              onCancelEdit()
            }
          }}
          className="h-5 w-full min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs font-medium text-foreground outline-none focus:border-ring"
          placeholder={`Page ${pageNumber}`}
        />
      </div>
    )
  }

  return (
    <div
      className="flex flex-1 items-center"
      onContextMenu={
        hasMenu && onOpenMenu
          ? (e) => {
              e.preventDefault()
              e.stopPropagation()
              onOpenMenu(e.clientX, e.clientY)
            }
          : undefined
      }
    >
      <button
        type="button"
        onClick={onActivate}
        className={cn(
          "flex flex-1 items-center gap-1.5 truncate px-1.5 py-1 text-left text-xs font-medium transition-colors",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
        title={displayName}
      >
        <FileText className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="truncate">{displayName}</span>
      </button>
      {hasMenu && onOpenMenu && (
        <AppTooltip label="Page actions">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
              onOpenMenu(rect.right, rect.bottom)
            }}
            className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-colors hover:bg-foreground/10 hover:text-foreground group-hover/row:opacity-100"
            aria-label="Page actions"
          >
            <MoreHorizontal className="size-3" />
          </button>
        </AppTooltip>
      )}
    </div>
  )
}

interface PageContextMenuState {
  index: number
  x: number
  y: number
}

interface DropTarget {
  index: number
  position: "above" | "below"
}

export function DocumentOutline({
  pages,
  activePage,
  onActivatePage,
  onAddPage,
  onRenamePage,
  onDeletePage,
  onReorderPages,
}: DocumentOutlineProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [editingPage, setEditingPage] = useState<number | null>(null)
  const [editValue, setEditValue] = useState("")
  const [contextMenu, setContextMenu] = useState<PageContextMenuState | null>(
    null,
  )
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setContextMenu(null)
    }
    window.addEventListener("click", close)
    window.addEventListener("scroll", close, true)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("click", close)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("keydown", onKey)
    }
  }, [contextMenu])

  const pageHeadings = useMemo(
    () => pages.map((page) => parseHeadings(page.html)),
    [pages],
  )

  const toggleCollapse = (pageIndex: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(pageIndex)) next.delete(pageIndex)
      else next.add(pageIndex)
      return next
    })
  }

  const startEdit = (index: number, name: string): void => {
    setEditingPage(index)
    setEditValue(name)
  }

  const commitEdit = (index: number): void => {
    if (onRenamePage) onRenamePage(index, editValue.trim())
    setEditingPage(null)
    setEditValue("")
  }

  const cancelEdit = (): void => {
    setEditingPage(null)
    setEditValue("")
  }

  const handleAddPage = (): void => {
    if (!onAddPage) return
    onAddPage()
  }

  const showEmpty =
    pages.length === 0 ||
    (pages.length === 1 &&
      (pageHeadings[0]?.length ?? 0) === 0 &&
      !pages[0].name &&
      !onAddPage)

  return (
    <div className="h-full overflow-y-auto px-3 py-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {showEmpty ? (
        <p className="px-2 py-2 text-xs text-muted-foreground/60">
          No pages or headings yet.
        </p>
      ) : (
        <>
          <ul className="space-y-0.5">
            {pages.map((page, index) => {
              const isCollapsed = collapsed.has(index)
              const headings = pageHeadings[index] ?? []
              const hasHeadings = headings.length > 0
              const canRename = !!onRenamePage
              const canDelete = !!onDeletePage && pages.length > 1
              const hasMenu = canRename || canDelete
              const canDrag = !!onReorderPages && pages.length > 1
              const isEditing = editingPage === index
              const isActive = activePage === index
              const isDragging = dragFrom === index
              const pageNumber = index + 1
              const indicatorAbove =
                dropTarget?.index === index && dropTarget.position === "above"
              const indicatorBelow =
                dropTarget?.index === index && dropTarget.position === "below"
              return (
                <li
                  key={page.nodeId ?? `page-${index}`}
                  draggable={canDrag && !isEditing}
                  onDragStart={
                    canDrag && !isEditing
                      ? (e) => {
                          setDragFrom(index)
                          e.dataTransfer.effectAllowed = "move"
                          // Firefox needs data set to trigger drag events.
                          e.dataTransfer.setData("text/plain", String(index))
                        }
                      : undefined
                  }
                  onDragOver={
                    canDrag && dragFrom !== null
                      ? (e) => {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = "move"
                          const rect =
                            e.currentTarget.getBoundingClientRect()
                          const position: "above" | "below" =
                            e.clientY < rect.top + rect.height / 2
                              ? "above"
                              : "below"
                          setDropTarget((prev) =>
                            prev?.index === index && prev.position === position
                              ? prev
                              : { index, position },
                          )
                        }
                      : undefined
                  }
                  onDrop={
                    canDrag && dragFrom !== null
                      ? (e) => {
                          e.preventDefault()
                          const from = dragFrom
                          const rect =
                            e.currentTarget.getBoundingClientRect()
                          const landsAbove =
                            e.clientY < rect.top + rect.height / 2
                          const to = landsAbove ? index : index + 1
                          setDragFrom(null)
                          setDropTarget(null)
                          if (from === null) return
                          if (to === from || to === from + 1) return
                          onReorderPages?.(from, to)
                        }
                      : undefined
                  }
                  onDragEnd={() => {
                    setDragFrom(null)
                    setDropTarget(null)
                  }}
                  className={cn(
                    "relative",
                    isDragging && "opacity-40",
                  )}
                >
                  {indicatorAbove && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 -top-px h-px bg-primary"
                    />
                  )}
                  {indicatorBelow && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-primary"
                    />
                  )}
                  <div
                    className={cn(
                      "group/row flex items-center rounded transition-colors",
                      isActive
                        ? "bg-muted"
                        : "hover:bg-muted/60",
                    )}
                  >
                    {hasHeadings ? (
                      <AppTooltip label={isCollapsed ? "Show headings" : "Hide headings"}>
                        <button
                          type="button"
                          onClick={() => toggleCollapse(index)}
                          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                          aria-label={
                            isCollapsed ? "Expand page" : "Collapse page"
                          }
                        >
                          <ChevronRight
                            className={cn(
                              "size-3 transition-transform",
                              !isCollapsed && "rotate-90",
                            )}
                          />
                        </button>
                      </AppTooltip>
                    ) : (
                      <span className="size-4 shrink-0" aria-hidden />
                    )}
                    <PageLabel
                      pageNumber={pageNumber}
                      name={page.name}
                      isActive={isActive}
                      isEditing={isEditing}
                      editValue={editValue}
                      onChangeEdit={setEditValue}
                      onCommitEdit={() => commitEdit(index)}
                      onCancelEdit={cancelEdit}
                      onActivate={() => onActivatePage(index)}
                      onOpenMenu={
                        hasMenu
                          ? (x, y) => setContextMenu({ index, x, y })
                          : undefined
                      }
                      hasMenu={hasMenu}
                    />
                  </div>
                  {hasHeadings && !isCollapsed && (
                    <ul className="space-y-0.5">
                      {headings.map((heading, i) => {
                        const indent =
                          heading.level === 1
                            ? "pl-7"
                            : heading.level === 2
                              ? "pl-10"
                              : "pl-12"
                        return (
                          <li
                            key={`${index}-${i}-${heading.nodeId ?? heading.text}`}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                onActivatePage(index, heading.nodeId)
                              }
                              className={cn(
                                "block w-full truncate rounded py-1 pr-2 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground",
                                indent,
                              )}
                              title={heading.text}
                            >
                              {heading.text}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
          {onAddPage && (
            <button
              type="button"
              onClick={handleAddPage}
              className="mt-2 flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-left text-xs text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Plus className="size-3 shrink-0" />
              <span>New page</span>
            </button>
          )}
        </>
      )}
      {contextMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-50 min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {onRenamePage && (
              <button
                type="button"
                onClick={() => {
                  const idx = contextMenu.index
                  setContextMenu(null)
                  startEdit(idx, pages[idx]?.name ?? "")
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-muted"
              >
                <Pencil className="size-3.5" />
                Rename
              </button>
            )}
            {onDeletePage && pages.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  const idx = contextMenu.index
                  setContextMenu(null)
                  onDeletePage(idx)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive outline-none transition-colors hover:bg-destructive/10"
              >
                <Trash2 className="size-3.5" />
                Delete page
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
