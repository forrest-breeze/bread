"use client"

import { useState, useEffect, useCallback, useRef, useMemo, startTransition, useId } from "react"
import { createPortal } from "react-dom"
import { useRouter, useParams, usePathname } from "next/navigation"
import { preload, useSWRConfig } from "swr"
import { createClient } from "@/lib/supabase/client"
import { useDocuments, useFolders, useWorkspace } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"

async function documentFetcher(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  return res.json()
}
import {
  type DocumentNavSortMode,
  DOCUMENT_NAV_SORT_OPTIONS,
  getStoredDocumentNavSortMode,
  setStoredDocumentNavSortMode,
  getStoredOpenFolderIds,
  setStoredOpenFolderIds,
} from "@/lib/document-nav-preferences"
import { reorderFolders } from "@/lib/api/folders"
import { reorderDocuments } from "@/lib/api/documents"
import { createScopeTreeView } from "@/lib/portal/scope-tree"
import type { PortalScopeEntry } from "@/lib/public-kb"
import { cn } from "@/lib/utils"
import {
  Search,
  FileText,
  ChevronRight,
  FolderOpen,
  Folder,
  Plus,
  FolderPlus,
  FilePlus,
  MoreHorizontal,
  Trash2,
  Pencil,
  AlertCircle,
  Shapes,
  Shield,
  ListFilter,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FolderScopePicker, type FolderScope } from "./folder-scope-picker"
import { FolderIconGrid } from "./folder-icon-picker"
import {
  isRenderablePortalIconName,
  PortalIcon,
} from "@/components/public-kb/portal/portal-icon"
import type { FolderVisibility, WorkspaceMemberRole } from "@/lib/types"

const DRAG_TYPE = "application/x-bread-doc-id"
const FOLDER_DRAG_TYPE = "application/x-bread-folder-id"
const MULTI_DOC_DRAG_TYPE = "application/x-bread-doc-ids"
const MULTI_FOLDER_DRAG_TYPE = "application/x-bread-folder-ids"

type FolderDropIntent = "inside" | "before" | "after"
type FolderReorderPosition = Extract<FolderDropIntent, "before" | "after">

interface InternalDragItems {
  docIds: string[]
  folderIds: string[]
}

interface DocItem {
  id: string
  title: string
  source: string
  folder_id: string | null
  sort_order: number | null
  created_at: string
  updated_at: string
}

interface FolderItem {
  id: string
  name: string
  display_name: string
  kind: "user" | "topic" | "system"
  parent_folder_id: string | null
  visibility: FolderVisibility
  required_role: WorkspaceMemberRole | null
  document_count: number
  sort_order: number | null
  icon: string | null
  last_seen_at: string
  created_at: string
  updated_at: string
}

// Explicit folder icon first (the same glyph the portal sidebar renders),
// generic open/closed folder marks otherwise.
function FolderRowIcon({
  folder,
  open,
}: {
  folder: Pick<FolderItem, "icon">
  open: boolean
}): React.ReactElement {
  // Unknown names fall back to the generic folder marks — PortalIcon's own
  // file-text fallback would read as a document.
  if (folder.icon && isRenderablePortalIconName(folder.icon)) {
    return <PortalIcon name={folder.icon} className="size-3.5 shrink-0" />
  }
  return open ? (
    <FolderOpen className="size-3.5" />
  ) : (
    <Folder className="size-3.5" />
  )
}

const ROLE_LABELS: Record<WorkspaceMemberRole, string> = {
  owner: "Owners",
  admin: "Admins",
  editor: "Editors",
  viewer: "Viewers",
  "agent-only": "Agents",
}

function FolderScopeBadge({
  folder,
}: {
  folder: Pick<FolderItem, "visibility" | "required_role">
}): React.ReactElement | null {
  if (folder.visibility === "workspace") return null

  const roleLabel = folder.required_role ? ROLE_LABELS[folder.required_role] : "Role"
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm bg-amber-500/10 px-1 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400"
      title={`Visible to ${roleLabel}`}
    >
      <Shield className="size-2.5" />
      {roleLabel}
    </span>
  )
}

function compareAlphabetical(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
}

function comparePortalOrder<T extends { sort_order: number | null; display_name: string; name: string }>(
  a: T,
  b: T,
): number {
  const aSort = a.sort_order ?? Number.MAX_SAFE_INTEGER
  const bSort = b.sort_order ?? Number.MAX_SAFE_INTEGER
  if (aSort !== bSort) return aSort - bSort
  return compareAlphabetical(a.display_name || a.name, b.display_name || b.name)
}

// Document flavor of comparePortalOrder: explicit sort_order first (nulls
// last), then title. Mirrors the public portal's per-folder document order.
function compareDocPortalOrder<T extends { sort_order?: number | null; title: string }>(
  a: T,
  b: T,
): number {
  const aSort = a.sort_order ?? Number.MAX_SAFE_INTEGER
  const bSort = b.sort_order ?? Number.MAX_SAFE_INTEGER
  if (aSort !== bSort) return aSort - bSort
  return compareAlphabetical(a.title, b.title)
}

// Doc rows have no "inside" — a drag is either above or below the midpoint.
function docDropPositionFromEvent(
  e: React.DragEvent<HTMLElement>,
): FolderReorderPosition {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY - rect.top < rect.height / 2 ? "before" : "after"
}

function folderDropIntentFromEvent(e: React.DragEvent<HTMLElement>): FolderDropIntent {
  const rect = e.currentTarget.getBoundingClientRect()
  const y = e.clientY - rect.top
  const edge = Math.min(10, rect.height * 0.3)
  if (y <= edge) return "before"
  if (y >= rect.height - edge) return "after"
  return "inside"
}

// Keep the builder's legacy wrapper behavior aligned with public taxonomy.
// These names describe a container for a portal, not a section visitors should
// have to open before reaching its content.
function isPortalWrapperFolderName(name: string): boolean {
  return /\b(help center|knowledge base|docs|documentation)\b/i.test(name)
}

function sortByMode<T extends { created_at: string; updated_at: string }>(
  items: T[],
  sortMode: Exclude<DocumentNavSortMode, "custom">,
  getLabel: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    if (sortMode === "alphabetical") {
      return compareAlphabetical(getLabel(a), getLabel(b))
    }

    const timeDiff =
      sortMode === "created"
        ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        : new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()

    if (timeDiff !== 0) return timeDiff
    return compareAlphabetical(getLabel(a), getLabel(b))
  })
}

function SortModeDropdown({
  value,
  onChange,
}: {
  value: DocumentNavSortMode
  onChange: (mode: DocumentNavSortMode) => void
}): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Sort documents"
            className="text-muted-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
          >
            <ListFilter className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sort documents</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => onChange(next as DocumentNavSortMode)}
          >
            {DOCUMENT_NAV_SORT_OPTIONS.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                className="items-start gap-2 py-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm">{option.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface ContextMenuState {
  type: "doc" | "folder" | "bulk" | "root"
  id: string
  name: string
  x: number
  y: number
  bulkCount?: number
}

interface DeleteTarget {
  type: "doc" | "folder" | "bulk"
  id: string
  name: string
  bulkCount?: number
  bulkDocIds?: string[]
  bulkFolderIds?: string[]
}

interface DocumentsSubNavProps {
  className?: string
  chrome?: "default" | "builder"
  routeRoot?: "knowledge" | "kb"
  projectSlug?: string | null
  /** Selected portal page, preserved while navigating between its editors. */
  portalPageSlug?: string | null
  /** Page-level curation applied to the workspace-wide content tree. */
  portalPageScope?: PortalScopeEntry[] | null
  /**
   * Structural content roots whose children should appear at the top level.
   * The public portal promotes these roots too, so the editor tree should not
   * add an extra folder row that visitors never see.
   */
  promotedRootFolderIds?: ReadonlySet<string>
  /** Folder that acts as the invisible root of the active portal surface. */
  projectRootFolderId?: string | null
  searchQuery?: string
  onSearchQueryChange?: (query: string) => void
  sortMode?: DocumentNavSortMode
  /** Persist a sort-mode change when `sortMode` is controlled by the parent. */
  onSortModeChange?: (mode: DocumentNavSortMode) => void
  /**
   * Called after a ROOT folder (portal section) is created in kb mode. The
   * portal builder uses it to opt the new section into the project's content
   * scope — a scoped project would otherwise never surface the new folder.
   */
  onSectionCreated?: (folderId: string) => Promise<void> | void
  /** Called after a document is created directly in the active project root. */
  onRootDocumentCreated?: (documentId: string) => Promise<void> | void
  /** Called after the folder tree order is persisted. */
  onFoldersReordered?: () => void
}

function navigationQuery(
  routeRoot: "knowledge" | "kb",
  projectSlug?: string | null,
  portalPageSlug?: string | null,
): string {
  if (routeRoot !== "kb") return ""
  const params = new URLSearchParams()
  if (projectSlug) params.set("project", projectSlug)
  if (portalPageSlug) params.set("page", portalPageSlug)
  const query = params.toString()
  return query ? `?${query}` : ""
}

function rootHref(
  routeRoot: "knowledge" | "kb",
  projectSlug?: string | null,
  portalPageSlug?: string | null,
): string {
  return routeRoot === "kb"
    ? `/kb${navigationQuery(routeRoot, projectSlug, portalPageSlug)}`
    : "/knowledge"
}

function documentHref(
  routeRoot: "knowledge" | "kb",
  id: string,
  projectSlug?: string | null,
  portalPageSlug?: string | null,
): string {
  return routeRoot === "kb"
    ? `/kb/doc/${id}${navigationQuery(routeRoot, projectSlug, portalPageSlug)}`
    : `/knowledge/${id}`
}

// Expands a set of folder ids to include every descendant folder. Deleting a
// folder deletes its whole subtree server-side, so optimistic cache updates
// must drop the same set.
function collectFolderSubtreeIds(
  folders: readonly { id: string; parent_folder_id: string | null }[] | undefined,
  rootIds: string[],
): Set<string> {
  const subtree = new Set(rootIds)
  const childrenByParent = new Map<string, string[]>()
  for (const folder of folders ?? []) {
    if (!folder.parent_folder_id) continue
    const siblings = childrenByParent.get(folder.parent_folder_id)
    if (siblings) siblings.push(folder.id)
    else childrenByParent.set(folder.parent_folder_id, [folder.id])
  }
  const queue = [...rootIds]
  while (queue.length > 0) {
    const parentId = queue.pop()!
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (!subtree.has(childId)) {
        subtree.add(childId)
        queue.push(childId)
      }
    }
  }
  return subtree
}

function parseDragIds(raw: string): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    return []
  }
}

function movableFolderRootIds(
  folderIds: readonly string[],
  targetParentId: string | null,
  folders: readonly Pick<FolderItem, "id" | "parent_folder_id">[] | undefined,
): string[] {
  const requested = [...new Set(folderIds)].filter((id) => id !== targetParentId)
  const requestedSet = new Set(requested)
  const folderById = new Map((folders ?? []).map((folder) => [folder.id, folder]))

  // If both an ancestor and its child are selected, only move the ancestor;
  // the child keeps its place in that subtree.
  return requested.filter((id) => {
    const folder = folderById.get(id)
    if (!folder) return false
    const visited = new Set<string>()
    let ancestorId = folder.parent_folder_id
    while (ancestorId && !visited.has(ancestorId)) {
      if (requestedSet.has(ancestorId)) return false
      visited.add(ancestorId)
      ancestorId = folderById.get(ancestorId)?.parent_folder_id ?? null
    }
    return (folder.parent_folder_id ?? null) !== targetParentId
  })
}

function movableDocIds(
  docIds: readonly string[],
  targetFolderId: string | null,
  docs: readonly Pick<DocItem, "id" | "folder_id">[] | undefined,
): string[] {
  const docById = new Map((docs ?? []).map((doc) => [doc.id, doc]))
  return [...new Set(docIds)].filter((id) => {
    const doc = docById.get(id)
    return Boolean(doc && (doc.folder_id ?? null) !== targetFolderId)
  })
}

function hasMovableItems(
  items: InternalDragItems,
  targetFolderId: string | null,
  folders: readonly Pick<FolderItem, "id" | "parent_folder_id">[] | undefined,
  docs: readonly Pick<DocItem, "id" | "folder_id">[] | undefined,
): boolean {
  return (
    movableFolderRootIds(items.folderIds, targetFolderId, folders).length > 0 ||
    movableDocIds(items.docIds, targetFolderId, docs).length > 0
  )
}

function deduplicateName(baseName: string, existingNames: string[]): string {
  if (!existingNames.includes(baseName)) return baseName
  let counter = 1
  while (existingNames.includes(`${baseName} (${counter})`)) {
    counter++
  }
  return `${baseName} (${counter})`
}

function DocumentTreeSkeleton(): React.ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      className="space-y-1 px-1 pt-2"
    >
      <span className="sr-only">Loading documents</span>
      <div className="space-y-0.5">
        <DocumentTreeSkeletonFolder width="w-32" />
        <div className="ml-3 space-y-0.5 border-l border-border/40 pl-1">
          <DocumentTreeSkeletonFolder width="w-24" />
          <DocumentTreeSkeletonFile width="w-36" />
          <DocumentTreeSkeletonFile width="w-28" />
        </div>
        <DocumentTreeSkeletonFolder width="w-40" />
        <div className="px-2 pt-2">
          <Skeleton className="h-2.5 w-14 rounded-sm" />
        </div>
        <DocumentTreeSkeletonFile width="w-44" />
        <DocumentTreeSkeletonFile width="w-32" />
      </div>
    </div>
  )
}

function DocumentTreeSkeletonFolder({
  width,
}: {
  width: string
}): React.ReactElement {
  return (
    <div className="flex h-7 items-center gap-1.5 rounded-md px-2">
      <Skeleton className="size-3 shrink-0 rounded-sm" />
      <Skeleton className="size-3.5 shrink-0 rounded-sm" />
      <Skeleton className={cn("h-3 min-w-0", width)} />
    </div>
  )
}

function DocumentTreeSkeletonFile({
  width,
}: {
  width: string
}): React.ReactElement {
  return (
    <div className="flex h-7 items-center gap-2 rounded-md px-2">
      <Skeleton className="size-3.5 shrink-0 rounded-sm" />
      <Skeleton className={cn("h-3 min-w-0", width)} />
    </div>
  )
}

// Nominal width of the row action menu, used to right-anchor it under the
// three-dot button so it never spills past the sidebar's right edge.
const ROW_MENU_WIDTH = 176

// The three-dot affordance on a doc/folder row. Clicking it opens the same
// menu a right-click would, anchored under the button. Rendered inside a
// `group` row so it fades in on hover (and stays visible while focused).
function RowMenuButton({
  onOpen,
  label,
}: {
  onOpen: (x: number, y: number) => void
  label: string
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        const rect = e.currentTarget.getBoundingClientRect()
        onOpen(Math.max(8, rect.right - ROW_MENU_WIDTH), rect.bottom + 4)
      }}
      className="mr-1 shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-muted-foreground focus:opacity-100 group-hover:opacity-100"
    >
      <MoreHorizontal className="size-3.5" />
    </button>
  )
}

function FileEntry({
  doc,
  isSelected,
  isMultiSelected,
  isRenaming,
  renameValue,
  selectedDocIds,
  selectedFolderIds,
  onSelect,
  onOpenMenu,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  reorderEnabled,
  onReorderDocs,
  onDropFolders,
  onInternalDragStart,
  onInternalDragEnd,
}: {
  doc: DocItem
  isSelected: boolean
  isMultiSelected: boolean
  isRenaming: boolean
  renameValue: string
  selectedDocIds: Set<string>
  selectedFolderIds: Set<string>
  onSelect: (id: string, e: React.MouseEvent) => void
  onOpenMenu: (x: number, y: number) => void
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  /**
   * Whether doc rows accept positioned drops. Off in the non-custom sort
   * modes, where drags fall through to the folder/root move targets instead.
   */
  reorderEnabled: boolean
  /** Places the dragged docs before/after this row (target = this doc). */
  onReorderDocs: (docIds: string[], position: FolderReorderPosition) => void
  /** Moves dragged folders into this doc's parent folder (mixed selections). */
  onDropFolders: (folderIds: string[]) => void
  onInternalDragStart: (items: InternalDragItems) => void
  onInternalDragEnd: () => void
}) {
  const [docDropPosition, setDocDropPosition] =
    useState<FolderReorderPosition | null>(null)
  const docDropPositionRef = useRef<FolderReorderPosition | null>(null)

  if (isRenaming) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-0.5">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          className="h-6 text-[13px] px-1"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRenameSubmit()
            if (e.key === "Escape") onRenameCancel()
          }}
          onBlur={onRenameSubmit}
        />
      </div>
    )
  }

  return (
    <div className="relative">
      {docDropPosition === "before" && (
        <div className="pointer-events-none absolute inset-x-1 top-0 z-10 h-0.5 rounded-full bg-primary" />
      )}
      {docDropPosition === "after" && (
        <div className="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-0.5 rounded-full bg-primary" />
      )}
      <div
      className={cn(
        "group flex items-center rounded-md transition-colors",
        isMultiSelected
          ? "bg-primary/15"
          : isSelected
            ? "bg-muted"
            : "hover:bg-muted/50",
      )}
      onDragOver={(e) => {
        if (!reorderEnabled) return
        const types = e.dataTransfer.types
        // Only doc drags can be positioned against a doc row; OS file drags
        // keep falling through to the folder/root import drop zones.
        const hasDocs = types.includes(DRAG_TYPE) || types.includes(MULTI_DOC_DRAG_TYPE)
        if (!hasDocs || types.includes("Files")) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = "move"
        const next = docDropPositionFromEvent(e)
        docDropPositionRef.current = next
        setDocDropPosition(next)
      }}
      onDragLeave={() => {
        docDropPositionRef.current = null
        setDocDropPosition(null)
      }}
      onDrop={(e) => {
        if (!reorderEnabled) return
        const types = e.dataTransfer.types
        const hasDocs = types.includes(DRAG_TYPE) || types.includes(MULTI_DOC_DRAG_TYPE)
        if (!hasDocs || types.includes("Files")) return
        e.preventDefault()
        e.stopPropagation()
        const position = docDropPositionRef.current ?? docDropPositionFromEvent(e)
        docDropPositionRef.current = null
        setDocDropPosition(null)

        const multiDocRaw = e.dataTransfer.getData(MULTI_DOC_DRAG_TYPE)
        const docIds = multiDocRaw
          ? parseDragIds(multiDocRaw)
          : [e.dataTransfer.getData(DRAG_TYPE)].filter(Boolean)
        const reorderIds = docIds.filter((id) => id !== doc.id)
        if (reorderIds.length > 0) onReorderDocs(reorderIds, position)

        // A mixed selection can carry folders too — they can't be ordered
        // against a doc, so they land in the same folder as this row.
        const multiFolderRaw = e.dataTransfer.getData(MULTI_FOLDER_DRAG_TYPE)
        const folderIds = parseDragIds(multiFolderRaw)
        if (folderIds.length > 0) onDropFolders(folderIds)
      }}
    >
      <button
        data-doc-id={doc.id}
        draggable
        onDragStart={(e) => {
          if (isMultiSelected && (selectedDocIds.size + selectedFolderIds.size) > 1) {
            const docIds = [...selectedDocIds]
            const folderIds = [...selectedFolderIds]
            e.dataTransfer.setData(MULTI_DOC_DRAG_TYPE, JSON.stringify(docIds))
            if (selectedFolderIds.size > 0) {
              e.dataTransfer.setData(MULTI_FOLDER_DRAG_TYPE, JSON.stringify(folderIds))
            }
            onInternalDragStart({ docIds, folderIds })
          } else {
            e.dataTransfer.setData(DRAG_TYPE, doc.id)
            onInternalDragStart({ docIds: [doc.id], folderIds: [] })
          }
          e.dataTransfer.effectAllowed = "move"
        }}
        onDragEnd={onInternalDragEnd}
        onClick={(e) => onSelect(doc.id, e)}
        onMouseEnter={() => {
          void preload(`/api/documents/${doc.id}`, documentFetcher).catch(() => {})
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onOpenMenu(e.clientX, e.clientY)
        }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors text-left cursor-grab active:cursor-grabbing",
          isMultiSelected || isSelected
            ? "text-foreground"
            : "text-muted-foreground group-hover:text-foreground",
          isSelected && "font-medium",
        )}
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="truncate">{doc.title}</span>
      </button>
      <RowMenuButton
        onOpen={onOpenMenu}
        label={`Actions for ${doc.title}`}
      />
      </div>
    </div>
  )
}

interface FolderEntryProps {
  folder: FolderItem
  docs: DocItem[]
  childFolders: FolderItem[]
  foldersByParent: Map<string | null, FolderItem[]>
  docsByFolder: Map<string | null, DocItem[]>
  selectedDocId: string | null
  selectedFolderId: string | null
  selectedDocIds: Set<string>
  selectedFolderIds: Set<string>
  isRenaming: boolean
  renameValue: string
  renamingDocId: string | null
  renamingFolderId: string | null
  docRenameValue: string
  onOpenDoc: (id: string, e: React.MouseEvent) => void
  onOpenFolder: (id: string, e: React.MouseEvent) => void
  /** Creates a document inside a folder — used by the drag-to-import file drop. */
  onCreateDoc: (folderId: string, title?: string, content?: string) => void
  onDropDoc: (docId: string, folderId: string) => void
  onDropDocs: (docIds: string[], folderId: string) => void
  onDropFolder: (folderId: string, parentFolderId: string | null) => void
  onDropFolders: (folderIds: string[], parentFolderId: string | null) => void
  /** Whether edge-drops reorder (custom sort mode); otherwise drops move inside. */
  reorderEnabled: boolean
  onReorderFolders: (
    folderIds: string[],
    targetFolderId: string,
    position: FolderReorderPosition,
  ) => void
  onReorderDocs: (
    docIds: string[],
    targetDocId: string,
    position: FolderReorderPosition,
  ) => void
  /** Opens the row action menu (rename/delete/create) for a folder at (x, y). */
  onFolderMenu: (folder: FolderItem, x: number, y: number) => void
  /** Opens the row action menu for a document at (x, y). */
  onDocMenu: (doc: DocItem, x: number, y: number) => void
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  onDocRenameChange: (value: string) => void
  onDocRenameSubmit: () => void
  onDocRenameCancel: () => void
  onError: (message: string) => void
  openFolderIds: Set<string>
  onToggleFolder: (id: string) => void
  onInternalDragStart: (items: InternalDragItems) => void
  onInternalDragEnd: () => void
  depth?: number
}

function FolderEntry({
  folder,
  docs,
  childFolders,
  foldersByParent,
  docsByFolder,
  selectedDocId,
  selectedFolderId,
  selectedDocIds,
  selectedFolderIds,
  isRenaming,
  renameValue,
  renamingDocId,
  renamingFolderId,
  docRenameValue,
  onOpenDoc,
  onOpenFolder,
  onCreateDoc,
  onDropDoc,
  onDropDocs,
  onDropFolder,
  onDropFolders,
  reorderEnabled,
  onReorderFolders,
  onReorderDocs,
  onFolderMenu,
  onDocMenu,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onDocRenameChange,
  onDocRenameSubmit,
  onDocRenameCancel,
  onError,
  openFolderIds,
  onToggleFolder,
  onInternalDragStart,
  onInternalDragEnd,
  depth = 0,
}: FolderEntryProps) {
  const [folderDropIntent, setFolderDropIntent] = useState<FolderDropIntent | null>(null)
  const folderDropIntentRef = useRef<FolderDropIntent | null>(null)
  const containsSelectedDoc = docs.some((doc) => doc.id === selectedDocId)
  const isActive = selectedFolderId === folder.id
  const isMultiSelected = selectedFolderIds.has(folder.id)
  const open = containsSelectedDoc || openFolderIds.has(folder.id)

  return (
    <div>
      <div className="relative">
        {folderDropIntent === "before" && (
          <div className="pointer-events-none absolute inset-x-1 top-0 z-10 h-0.5 rounded-full bg-primary" />
        )}
        {folderDropIntent === "after" && (
          <div className="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-0.5 rounded-full bg-primary" />
        )}
        <div
          className={cn(
            "group flex items-center rounded-md transition-colors",
            isActive && "bg-muted",
            isMultiSelected && "bg-primary/15",
            folderDropIntent === "inside" && "bg-primary/10 ring-1 ring-primary/30",
          )}
          draggable={!isRenaming}
          onDragStart={(e) => {
            if (isMultiSelected && (selectedDocIds.size + selectedFolderIds.size) > 1) {
              const folderIds = [...selectedFolderIds]
              const docIds = [...selectedDocIds]
              e.dataTransfer.setData(MULTI_FOLDER_DRAG_TYPE, JSON.stringify(folderIds))
              if (selectedDocIds.size > 0) {
                e.dataTransfer.setData(MULTI_DOC_DRAG_TYPE, JSON.stringify(docIds))
              }
              onInternalDragStart({ docIds, folderIds })
            } else {
              e.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id)
              onInternalDragStart({ docIds: [], folderIds: [folder.id] })
            }
            e.dataTransfer.effectAllowed = "move"
          }}
          onDragEnd={onInternalDragEnd}
          onDragOver={(e) => {
            e.stopPropagation()
            const types = e.dataTransfer.types
            const hasFiles = types.includes("Files")
            const hasDocs = types.includes(DRAG_TYPE) || types.includes(MULTI_DOC_DRAG_TYPE)
            const hasFolders =
              types.includes(FOLDER_DRAG_TYPE) || types.includes(MULTI_FOLDER_DRAG_TYPE)
            if (hasDocs || hasFiles || hasFolders) {
              e.preventDefault()
              e.dataTransfer.dropEffect = hasFiles ? "copy" : "move"
              const nextIntent =
                reorderEnabled && hasFolders && !hasDocs && !hasFiles
                  ? folderDropIntentFromEvent(e)
                  : "inside"
              folderDropIntentRef.current = nextIntent
              setFolderDropIntent(nextIntent)
            }
          }}
          onDragLeave={() => {
            folderDropIntentRef.current = null
            setFolderDropIntent(null)
          }}
          onDrop={async (e) => {
            e.preventDefault()
            e.stopPropagation()
            const types = e.dataTransfer.types
            const hasDocs = types.includes(DRAG_TYPE) || types.includes(MULTI_DOC_DRAG_TYPE)
            const hasFiles = types.includes("Files")
            const hasFolders =
              types.includes(FOLDER_DRAG_TYPE) || types.includes(MULTI_FOLDER_DRAG_TYPE)
            const dropIntent =
              folderDropIntentRef.current ??
              (reorderEnabled && hasFolders && !hasDocs && !hasFiles
                ? folderDropIntentFromEvent(e)
                : null)
            folderDropIntentRef.current = null
            setFolderDropIntent(null)

            if (e.dataTransfer.files.length > 0) {
              const files = Array.from(e.dataTransfer.files)
              const supported = files.filter(
                (f) =>
                  f.type.startsWith("text/") ||
                  [".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".json"].some((ext) =>
                    f.name.endsWith(ext),
                  ),
              )

              if (supported.length < files.length) {
                onError(`Skipped ${files.length - supported.length} unsupported file(s)`)
              }

              for (const file of supported) {
                const content = await new Promise<string>((resolve) => {
                  const reader = new FileReader()
                  reader.onload = (e) => resolve(e.target?.result as string)
                  reader.readAsText(file)
                })
                onCreateDoc(folder.id, file.name, content)
              }
              return
            }

            const multiFolderRaw = e.dataTransfer.getData(MULTI_FOLDER_DRAG_TYPE)
            const multiDocRaw = e.dataTransfer.getData(MULTI_DOC_DRAG_TYPE)
            if (multiFolderRaw || multiDocRaw) {
              const folderOnlyDropIntent =
                reorderEnabled && !multiDocRaw
                  ? folderDropIntentFromEvent(e)
                  : dropIntent
              if (multiFolderRaw) {
                const ids = parseDragIds(multiFolderRaw).filter((id) => id !== folder.id)
                if (ids.length > 0) {
                  if (
                    !multiDocRaw &&
                    (folderOnlyDropIntent === "before" || folderOnlyDropIntent === "after")
                  ) {
                    onReorderFolders(ids, folder.id, folderOnlyDropIntent)
                  } else {
                    onDropFolders(ids, folder.id)
                  }
                }
              }
              if (multiDocRaw) {
                const ids = parseDragIds(multiDocRaw)
                if (ids.length > 0) onDropDocs(ids, folder.id)
              }
              return
            }

            const childFolderId = e.dataTransfer.getData(FOLDER_DRAG_TYPE)
            if (childFolderId && childFolderId !== folder.id) {
              const folderOnlyDropIntent = reorderEnabled
                ? folderDropIntentFromEvent(e)
                : "inside"
              if (folderOnlyDropIntent === "before" || folderOnlyDropIntent === "after") {
                onReorderFolders([childFolderId], folder.id, folderOnlyDropIntent)
              } else {
                onDropFolder(childFolderId, folder.id)
              }
              return
            }

            const docId = e.dataTransfer.getData(DRAG_TYPE)
            if (docId) onDropDoc(docId, folder.id)
          }}
        >
        {isRenaming ? (
          <div className="flex flex-1 items-center gap-1.5 px-2 py-0.5">
            <ChevronRight
              className={cn("size-3 transition-transform", open && "rotate-90")}
            />
            <FolderRowIcon folder={folder} open={open} />
            <Input
              autoFocus
              className="h-5 text-[12px] px-1 flex-1"
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRenameSubmit()
                if (e.key === "Escape") onRenameCancel()
              }}
              onBlur={onRenameSubmit}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleFolder(folder.id)
              }}
              aria-label={open ? "Collapse folder" : "Expand folder"}
              className="rounded p-1 text-muted-foreground/60 hover:text-foreground"
            >
              <ChevronRight
                className={cn("size-3 transition-transform", open && "rotate-90")}
              />
            </button>
            <button
              type="button"
              data-folder-id={folder.id}
              onClick={(e) => onOpenFolder(folder.id, e)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onFolderMenu(folder, e.clientX, e.clientY)
              }}
              className={cn(
                "flex flex-1 items-center gap-1.5 rounded-md px-1 py-1.5 text-[13px] text-left transition-colors",
                isActive
                  ? "text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FolderRowIcon folder={folder} open={open} />
              <span className="flex-1 truncate">
                {folder.display_name || folder.name}
              </span>
              <FolderScopeBadge folder={folder} />
            </button>
          </div>
        )}
        {!isRenaming && (
          <RowMenuButton
            onOpen={(x, y) => onFolderMenu(folder, x, y)}
            label={`Actions for ${folder.display_name || folder.name}`}
          />
        )}
        </div>
      </div>

      {open && (
        <div className="ml-3 border-l border-border/40 pl-1">
          {childFolders.map((child) => (
            <FolderEntry
              key={child.id}
              folder={child}
              docs={docsByFolder.get(child.id) ?? []}
              childFolders={foldersByParent.get(child.id) ?? []}
              foldersByParent={foldersByParent}
              docsByFolder={docsByFolder}
              selectedDocId={selectedDocId}
              selectedFolderId={selectedFolderId}
              selectedDocIds={selectedDocIds}
              selectedFolderIds={selectedFolderIds}
              isRenaming={renamingFolderId === child.id}
              renameValue={renameValue}
              renamingDocId={renamingDocId}
              renamingFolderId={renamingFolderId}
              docRenameValue={docRenameValue}
              onOpenDoc={onOpenDoc}
              onOpenFolder={onOpenFolder}
              onCreateDoc={onCreateDoc}
              onDropDoc={onDropDoc}
              onDropDocs={onDropDocs}
              onDropFolder={onDropFolder}
              onDropFolders={onDropFolders}
              reorderEnabled={reorderEnabled}
              onReorderFolders={onReorderFolders}
              onReorderDocs={onReorderDocs}
              onFolderMenu={onFolderMenu}
              onDocMenu={onDocMenu}
              onRenameChange={onRenameChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onDocRenameChange={onDocRenameChange}
              onDocRenameSubmit={onDocRenameSubmit}
              onDocRenameCancel={onDocRenameCancel}
              onError={onError}
              openFolderIds={openFolderIds}
              onToggleFolder={onToggleFolder}
              onInternalDragStart={onInternalDragStart}
              onInternalDragEnd={onInternalDragEnd}
              depth={depth + 1}
            />
          ))}
          {docs.length === 0 && childFolders.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground/50 italic">
              Empty
            </p>
          ) : (
            docs.map((doc) => (
              <FileEntry
                key={doc.id}
                doc={doc}
                isSelected={doc.id === selectedDocId}
                isMultiSelected={selectedDocIds.has(doc.id)}
                isRenaming={renamingDocId === doc.id}
                renameValue={docRenameValue}
                selectedDocIds={selectedDocIds}
                selectedFolderIds={selectedFolderIds}
                onSelect={onOpenDoc}
                onOpenMenu={(x, y) => onDocMenu(doc, x, y)}
                onRenameChange={onDocRenameChange}
                onRenameSubmit={onDocRenameSubmit}
                onRenameCancel={onDocRenameCancel}
                reorderEnabled={reorderEnabled}
                onReorderDocs={(ids, position) => onReorderDocs(ids, doc.id, position)}
                onDropFolders={(ids) => onDropFolders(ids, folder.id)}
                onInternalDragStart={onInternalDragStart}
                onInternalDragEnd={onInternalDragEnd}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function DocumentsSubNav({
  className,
  chrome = "default",
  routeRoot = "knowledge",
  projectSlug,
  portalPageSlug,
  portalPageScope,
  promotedRootFolderIds,
  projectRootFolderId,
  searchQuery,
  onSearchQueryChange,
  sortMode: controlledSortMode,
  onSortModeChange,
  onSectionCreated,
  onRootDocumentCreated,
  onFoldersReordered,
}: DocumentsSubNavProps = {}): React.ReactElement {
  const router = useRouter()
  const params = useParams()
  const selectedId = (params?.id as string) ?? null

  const [internalQuery, setInternalQuery] = useState("")
  const [builderSearchOpen, setBuilderSearchOpen] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  // Parent for the folder being created: null = root (a portal "section" in kb
  // mode), an id = nested inside that folder.
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState("")
  const [newFolderScope, setNewFolderScope] = useState<FolderScope>({
    visibility: "workspace",
    required_role: null,
  })
  const [rootDragOver, setRootDragOver] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  // Glyph-grid submenu opened from a folder row's "Change icon" action.
  const [iconMenu, setIconMenu] = useState<{
    id: string
    x: number
    y: number
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renamingType, setRenamingType] = useState<"doc" | "folder" | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [internalSortMode, setInternalSortMode] =
    useState<DocumentNavSortMode>("alphabetical")
  const [openFolderIds, setOpenFolderIds] = useState<Set<string>>(() => new Set())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(() => new Set())
  const lastSelectedIdRef = useRef<string | null>(null)
  const focusIdRef = useRef<string | null>(null)
  const pathname = usePathname()
  const query = searchQuery ?? internalQuery
  const useBuilderChrome = chrome === "builder"
  // Builder chrome always receives a controlled mode from the portal builder;
  // its fallback is "custom" so the tree mirrors the published portal order.
  const sortMode =
    controlledSortMode ?? (useBuilderChrome ? "custom" : internalSortMode)
  // Drag-to-reorder only means something when the tree displays the explicit
  // order it writes. In the other modes doc rows are inert drop targets and
  // folder edge-drops fall back to "move inside".
  const reorderEnabled = sortMode === "custom"
  const rootTargetFolderId = useBuilderChrome ? projectRootFolderId ?? null : null
  const onFolderPage =
    pathname?.startsWith(
      routeRoot === "kb" ? "/kb/folder/" : "/knowledge/folder/",
    ) ?? false
  const selectedFolderId = onFolderPage ? (params?.id as string) ?? null : null

  const contextMenuRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const lastAutoScrolledIdRef = useRef<string | null>(null)

  const scopedProjectSlug = routeRoot === "kb" ? projectSlug : null
  // Home uses the project's own scope. A portal page can intentionally include
  // content outside Home, so load the workspace-wide lists and apply the page's
  // scope locally. Navigation still keeps the project slug in its URLs.
  const dataProjectSlug = portalPageSlug ? null : scopedProjectSlug
  const { data: rawDocs, isLoading: docsLoading, mutate: mutateDocs } = useDocuments({
    projectSlug: dataProjectSlug,
  })
  const { data: rawFolders, isLoading: foldersLoading, mutate: mutateFolders } = useFolders({
    projectSlug: dataProjectSlug,
  })
  const { data: wsData } = useWorkspace()
  const { mutate: globalMutate } = useSWRConfig()

  const instanceId = useId()
  const workspaceId = wsData?.id
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | undefined>(
    workspaceId,
  )

  // Counter of in-flight local drag-drop / move mutations. While non-zero, we
  // skip revalidation triggered by our own realtime events so a stale refetch
  // (read-replica lag, concurrent PATCH) can't clobber the optimistic state.
  const pendingMovesRef = useRef(0)
  const activeInternalDragRef = useRef<InternalDragItems | null>(null)

  const handleInternalDragStart = useCallback((items: InternalDragItems) => {
    activeInternalDragRef.current = items
  }, [])

  const handleInternalDragEnd = useCallback(() => {
    activeInternalDragRef.current = null
    setRootDragOver(false)
  }, [])

  // The document/folder SWR keys are not workspace-scoped, so clear them when
  // the active workspace changes and keep the tree skeleton up until the fresh
  // workspace data has landed.
  useEffect(() => {
    if (!workspaceId || loadedWorkspaceId === workspaceId) return

    let cancelled = false
    void Promise.all([
      mutateDocs(undefined, { revalidate: true }),
      mutateFolders(undefined, { revalidate: true }),
    ])
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadedWorkspaceId(workspaceId)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId, loadedWorkspaceId, mutateDocs, mutateFolders])

  // Real-time subscription for documents and folders
  useEffect(() => {
    if (!workspaceId) return

    const supabase = createClient()
    const channelName = `documents-sub-nav-${workspaceId}-${instanceId}`
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "documents",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => {
          if (pendingMovesRef.current > 0) return
          void mutateDocs()
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "folders",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => {
          if (pendingMovesRef.current > 0) return
          void mutateFolders()
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [mutateDocs, mutateFolders, workspaceId, instanceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInternalSortMode(getStoredDocumentNavSortMode())
    setOpenFolderIds(getStoredOpenFolderIds())
  }, [])

  const handleToggleFolder = useCallback((id: string) => {
    setOpenFolderIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setStoredOpenFolderIds(next)
      return next
    })
  }, [])

  const handleSortModeChange = useCallback(
    (mode: DocumentNavSortMode) => {
      // Controlled mode (builder chrome): the parent owns the value and its
      // own persistence key. Otherwise persist the knowledge-nav preference.
      if (onSortModeChange) {
        onSortModeChange(mode)
        return
      }
      setInternalSortMode(mode)
      setStoredDocumentNavSortMode(mode)
    },
    [onSortModeChange],
  )

  const handleQueryChange = useCallback(
    (value: string) => {
      if (searchQuery !== undefined) {
        onSearchQueryChange?.(value)
      } else {
        setInternalQuery(value)
      }
    },
    [onSearchQueryChange, searchQuery],
  )

  useEffect(() => {
    if (!selectedId) {
      lastAutoScrolledIdRef.current = null
      return
    }
    if (!navRef.current) return
    if (lastAutoScrolledIdRef.current === selectedId) return

    const selectedEntry = navRef.current.querySelector<HTMLElement>(
      `[data-doc-id="${selectedId}"]`,
    )

    if (!selectedEntry) return

    selectedEntry.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })

    lastAutoScrolledIdRef.current = selectedId
  }, [selectedId, rawDocs, rawFolders])

  // Close context menu on outside click or scroll
  useEffect(() => {
    if (!contextMenu && !iconMenu) return

    const handleClose = () => {
      setContextMenu(null)
      setIconMenu(null)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose()
    }

    window.addEventListener("click", handleClose)
    window.addEventListener("scroll", handleClose, true)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("click", handleClose)
      window.removeEventListener("scroll", handleClose, true)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [contextMenu, iconMenu])

  const hasMultiSelection = multiSelectedIds.size > 0
  useEffect(() => {
    if (!hasMultiSelection) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMultiSelectedIds(new Set())
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [hasMultiSelection])
  const pageEligibleFolders = useMemo(
    () =>
      portalPageSlug
        ? (rawFolders ?? []).filter(
            (folder) =>
              folder.kind === "user" && folder.visibility === "workspace",
          )
        : rawFolders ?? [],
    [portalPageSlug, rawFolders],
  )
  const pageEligibleDocs = useMemo(() => {
    if (!portalPageSlug) return rawDocs ?? []
    const eligibleFolderIds = new Set(
      pageEligibleFolders.map((folder) => folder.id),
    )
    return (rawDocs ?? []).filter(
      (document) =>
        (document.document_type == null ||
          document.document_type === "source" ||
          document.document_type === "page") &&
        (document.folder_id === null ||
          eligibleFolderIds.has(document.folder_id)),
    )
  }, [pageEligibleFolders, portalPageSlug, rawDocs])

  const pageScopeView = useMemo(() => {
    if (portalPageScope == null) return null
    return createScopeTreeView(portalPageScope, {
      folders: pageEligibleFolders.map((folder) => ({
        id: folder.id,
        parent_folder_id: folder.parent_folder_id,
      })),
      docs: pageEligibleDocs.map((document) => ({
        id: document.id,
        folder_id: document.folder_id ?? null,
      })),
      // Page scopes are workspace-wide and may include content outside Home's
      // root. Decode from the workspace root, then keep only the page picks.
      rootId: null,
    })
  }, [pageEligibleDocs, pageEligibleFolders, portalPageScope])

  const pageDocs = useMemo(
    () =>
      pageScopeView
        ? pageEligibleDocs.filter((document) =>
            pageScopeView.docChecked(document.id),
          )
        : pageEligibleDocs,
    [pageEligibleDocs, pageScopeView],
  )
  const pageFolders = useMemo(
    () =>
      pageScopeView
        ? pageEligibleFolders.filter(
            (folder) => pageScopeView.folderState(folder.id) !== "none",
          )
        : pageEligibleFolders,
    [pageEligibleFolders, pageScopeView],
  )

  const docs: DocItem[] = useMemo(() => pageDocs.map((d) => ({
    id: d.id,
    title: d.title,
    source: d.source,
    folder_id: d.folder_id ?? null,
    sort_order: d.sort_order ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
  })), [pageDocs])

  const folders: FolderItem[] = useMemo(() => {
    const visibleFolderIds = new Set(pageFolders.map((f) => f.id))
    return pageFolders.map((f) => ({
      id: f.id,
      name: f.name,
      display_name: f.display_name,
      kind: f.kind,
      parent_folder_id:
        f.parent_folder_id && visibleFolderIds.has(f.parent_folder_id)
          ? f.parent_folder_id
          : null,
      visibility: f.visibility,
      required_role: f.required_role,
      document_count: f.document_count,
      sort_order: f.sort_order,
      icon: f.icon ?? null,
      last_seen_at: f.last_seen_at,
      created_at: f.created_at,
      updated_at: f.updated_at,
    }))
  }, [pageFolders])

  const userFolders = useMemo(() => folders.filter((f) => f.kind === "user"), [folders])

  // Filter by search. "Custom" mirrors the published portal's document order
  // (explicit sort_order first, nulls last) — same rule as folders.
  const filteredDocs = useMemo(() => {
    const normalizedQuery = query.toLowerCase()
    const baseDocs = query
      ? docs.filter((d) => d.title.toLowerCase().includes(normalizedQuery))
      : docs

    return sortMode === "custom"
      ? [...baseDocs].sort(compareDocPortalOrder)
      : sortByMode(baseDocs, sortMode, (doc) => doc.title)
  }, [docs, query, sortMode])

  // Only user folders get the user's sort preference — topic folders have
  // their own natural ordering (most recently active first) that preserves
  // the "what's happening now" feel.
  const sortedFolders = useMemo(
    () =>
      sortMode === "custom"
        ? [...userFolders].sort(comparePortalOrder)
        : sortByMode(userFolders, sortMode, (folder) => folder.display_name || folder.name),
    [userFolders, sortMode],
  )

  // Group user folders by parent so we can render a tree. Sorting is applied
  // at each level via the same sort mode.
  const foldersByParent = useMemo(() => {
    const map = new Map<string | null, FolderItem[]>()
    for (const f of sortedFolders) {
      const key = f.parent_folder_id ?? null
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(f)
    }
    return map
  }, [sortedFolders])

  const rootUserFolders = useMemo(
    () => foldersByParent.get(null) ?? [],
    [foldersByParent],
  )

  // A portal project root is a structural wrapper, not a visible section.
  // Surface its immediate children in place of the wrapper so the editor tree
  // matches the published portal and does not require an extra disclosure click.
  const structuralRootFolderIds = useMemo(
    () =>
      new Set(
        useBuilderChrome
          ? rootUserFolders
              .filter(
                (folder) =>
                  promotedRootFolderIds?.has(folder.id) ||
                  isPortalWrapperFolderName(folder.display_name || folder.name),
              )
              .map((folder) => folder.id)
          : [],
      ),
    [promotedRootFolderIds, rootUserFolders, useBuilderChrome],
  )
  const visibleRootFolders = useMemo(
    () =>
      rootUserFolders.flatMap((folder) =>
        structuralRootFolderIds.has(folder.id)
          ? foldersByParent.get(folder.id) ?? []
          : [folder],
      ),
    [foldersByParent, rootUserFolders, structuralRootFolderIds],
  )

  // Group docs by folder; docs whose folder_id doesn't reference a navigable
  // user folder — because the folder was deleted, or because automation set it
  // to a non-user (topic/system) folder that the tree never renders — are
  // reclassified as unfiled so they're never invisible. Only kind='user'
  // folders are tree locations, so the known set is the user folders only.
  const knownFolderIds = useMemo(
    () => new Set(userFolders.map((f) => f.id)),
    [userFolders],
  )
  const docsByFolder = useMemo(() => {
    const map = new Map<string | null, DocItem[]>()
    for (const doc of filteredDocs) {
      const key =
        !foldersLoading && doc.folder_id && !knownFolderIds.has(doc.folder_id)
          ? null
          : doc.folder_id
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(doc)
    }
    return map
  }, [filteredDocs, foldersLoading, knownFolderIds])

  const rootDocs = useMemo(() => docsByFolder.get(null) ?? [], [docsByFolder])
  const visibleRootDocs = useMemo(() => {
    if (structuralRootFolderIds.size === 0) return rootDocs

    const promotedDocs = rootUserFolders.flatMap((folder) =>
      structuralRootFolderIds.has(folder.id) ? docsByFolder.get(folder.id) ?? [] : [],
    )
    const merged = [...rootDocs, ...promotedDocs]
    return sortMode === "custom"
      ? merged.sort(compareDocPortalOrder)
      : sortByMode(merged, sortMode, (doc) => doc.title)
  }, [
    docsByFolder,
    rootDocs,
    rootUserFolders,
    sortMode,
    structuralRootFolderIds,
  ])

  const selectedDocIds = useMemo(
    () => new Set([...multiSelectedIds].filter((id) => !knownFolderIds.has(id))),
    [multiSelectedIds, knownFolderIds],
  )
  const selectedFolderIds = useMemo(
    () => new Set([...multiSelectedIds].filter((id) => knownFolderIds.has(id))),
    [multiSelectedIds, knownFolderIds],
  )

  const orderedVisibleIds = useMemo(() => {
    const ids: string[] = []
    const visit = (parentId: string | null): void => {
      const childFolders = foldersByParent.get(parentId) ?? []
      for (const f of childFolders) {
        ids.push(f.id)
        const folderDocs = docsByFolder.get(f.id) ?? []
        const containsSelected = folderDocs.some((d) => d.id === selectedId)
        const open = containsSelected || openFolderIds.has(f.id)
        if (open) {
          visit(f.id)
          for (const d of folderDocs) ids.push(d.id)
        }
      }
    }
    for (const folder of visibleRootFolders) {
      ids.push(folder.id)
      const folderDocs = docsByFolder.get(folder.id) ?? []
      const containsSelected = folderDocs.some((d) => d.id === selectedId)
      if (containsSelected || openFolderIds.has(folder.id)) {
        visit(folder.id)
        for (const d of folderDocs) ids.push(d.id)
      }
    }
    for (const d of visibleRootDocs) ids.push(d.id)
    return ids
  }, [
    docsByFolder,
    foldersByParent,
    openFolderIds,
    selectedId,
    visibleRootDocs,
    visibleRootFolders,
  ])

  const applyModifierClick = useCallback(
    (id: string, e: React.MouseEvent): boolean => {
      if (e.shiftKey) {
        e.preventDefault()
        const anchor = lastSelectedIdRef.current
        if (anchor && anchor !== id) {
          const startIdx = orderedVisibleIds.indexOf(anchor)
          const endIdx = orderedVisibleIds.indexOf(id)
          if (startIdx !== -1 && endIdx !== -1) {
            const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
            setMultiSelectedIds(new Set(orderedVisibleIds.slice(from, to + 1)))
            focusIdRef.current = id
            return true
          }
        }
        setMultiSelectedIds(new Set([id]))
        lastSelectedIdRef.current = id
        focusIdRef.current = id
        return true
      }
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        setMultiSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        lastSelectedIdRef.current = id
        focusIdRef.current = id
        return true
      }
      return false
    },
    [orderedVisibleIds],
  )

  // Shift+Arrow extends the selection from the anchor (last non-shift click)
  // to a moving focus cursor. Matches Finder-style range selection.
  const orderedVisibleIdsRef = useRef(orderedVisibleIds)
  useEffect(() => {
    orderedVisibleIdsRef.current = orderedVisibleIds
  }, [orderedVisibleIds])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.shiftKey) return
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return
      }
      const ordered = orderedVisibleIdsRef.current
      if (ordered.length === 0) return

      const currentId =
        focusIdRef.current ??
        lastSelectedIdRef.current ??
        selectedId ??
        selectedFolderId
      let currentIdx = currentId ? ordered.indexOf(currentId) : -1
      if (currentIdx === -1) {
        currentIdx = e.key === "ArrowDown" ? -1 : ordered.length
      }
      const nextIdx =
        e.key === "ArrowDown"
          ? Math.min(currentIdx + 1, ordered.length - 1)
          : Math.max(currentIdx - 1, 0)
      if (nextIdx === currentIdx) return

      e.preventDefault()
      const nextId = ordered[nextIdx]
      focusIdRef.current = nextId

      const anchorId = lastSelectedIdRef.current ?? nextId
      const anchorIdx = ordered.indexOf(anchorId)
      if (anchorIdx === -1) {
        setMultiSelectedIds(new Set([nextId]))
      } else {
        const [from, to] =
          anchorIdx < nextIdx ? [anchorIdx, nextIdx] : [nextIdx, anchorIdx]
        setMultiSelectedIds(new Set(ordered.slice(from, to + 1)))
      }

      const el = navRef.current?.querySelector<HTMLElement>(
        `[data-doc-id="${nextId}"], [data-folder-id="${nextId}"]`,
      )
      el?.scrollIntoView({ block: "nearest" })
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [selectedId, selectedFolderId])

  const handleSelect = useCallback(
    (id: string, e?: React.MouseEvent) => {
      if (e && applyModifierClick(id, e)) return
      setMultiSelectedIds(new Set())
      lastSelectedIdRef.current = id
      focusIdRef.current = id
      router.push(
        documentHref(routeRoot, id, scopedProjectSlug, portalPageSlug),
      )
    },
    [applyModifierClick, portalPageSlug, routeRoot, router, scopedProjectSlug],
  )

  const handleOpenFolder = useCallback(
    (id: string, e?: React.MouseEvent) => {
      if (e && applyModifierClick(id, e)) return
      setMultiSelectedIds(new Set())
      lastSelectedIdRef.current = id
      focusIdRef.current = id
      handleToggleFolder(id)
    },
    [applyModifierClick, handleToggleFolder],
  )

  const handleMoveFolder = useCallback(
    async (folderIdToMove: string, newParentId: string | null) => {
      if (
        movableFolderRootIds([folderIdToMove], newParentId, rawFolders).length === 0
      ) {
        return
      }
      const prev = rawFolders
      pendingMovesRef.current += 1
      await mutateFolders(
        (current) =>
          current?.map((f) =>
            f.id === folderIdToMove ? { ...f, parent_folder_id: newParentId } : f,
          ),
        { revalidate: false },
      )
      try {
        const res = await fetch(`/api/folders/${folderIdToMove}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parent_folder_id: newParentId }),
        })
        if (!res.ok) throw new Error(`Move folder failed: ${res.status}`)
      } catch (err) {
        console.error("[Bread] Move folder failed:", err)
        await mutateFolders(prev, { revalidate: false })
      } finally {
        pendingMovesRef.current -= 1
      }
    },
    [rawFolders, mutateFolders],
  )

  const handleMoveDoc = useCallback(
    async (docId: string, folderId: string | null) => {
      if (movableDocIds([docId], folderId, rawDocs).length === 0) return
      const prevDocs = rawDocs
      pendingMovesRef.current += 1
      await mutateDocs(
        (current) =>
          current?.map((d) =>
            d.id === docId ? { ...d, folder_id: folderId } : d
          ),
        { revalidate: false },
      )

      try {
        await fetch(`/api/documents/${docId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder_id: folderId }),
        })
        if (folderId) {
          await fetch(`/api/folders/${folderId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ touch: true }),
          })
          // Optimistic update already applied above — no refetch needed
        }
      } catch {
        await mutateDocs(prevDocs, { revalidate: false })
      } finally {
        pendingMovesRef.current -= 1
      }
    },
    [rawDocs, mutateDocs],
  )

  const handleMoveDocs = useCallback(
    async (docIds: string[], folderId: string | null) => {
      const idsToMove = movableDocIds(docIds, folderId, rawDocs)
      if (idsToMove.length === 0) return
      const idSet = new Set(idsToMove)
      const prevDocs = rawDocs
      pendingMovesRef.current += 1
      await mutateDocs(
        (current) =>
          current?.map((d) => (idSet.has(d.id) ? { ...d, folder_id: folderId } : d)),
        { revalidate: false },
      )
      try {
        await Promise.all(
          idsToMove.map((id) =>
            fetch(`/api/documents/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ folder_id: folderId }),
            }).then((res) => {
              if (!res.ok) throw new Error(`PATCH document ${id} failed: ${res.status}`)
            }),
          ),
        )
        if (folderId) {
          await fetch(`/api/folders/${folderId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ touch: true }),
          })
        }
      } catch (err) {
        console.error("[Bread] Move docs failed:", err)
        await mutateDocs(prevDocs, { revalidate: false })
      } finally {
        pendingMovesRef.current -= 1
      }
    },
    [rawDocs, mutateDocs],
  )

  const handleMoveFolders = useCallback(
    async (folderIds: string[], newParentId: string | null) => {
      const roots = movableFolderRootIds(folderIds, newParentId, rawFolders)
      if (roots.length === 0) return
      const moveSet = new Set(roots)
      const prev = rawFolders
      pendingMovesRef.current += 1
      await mutateFolders(
        (current) =>
          current?.map((f) =>
            moveSet.has(f.id) ? { ...f, parent_folder_id: newParentId } : f,
          ),
        { revalidate: false },
      )
      try {
        await Promise.all(
          roots.map((id) =>
            fetch(`/api/folders/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parent_folder_id: newParentId }),
            }).then((res) => {
              if (!res.ok) throw new Error(`PATCH folder ${id} failed: ${res.status}`)
            }),
          ),
        )
      } catch (err) {
        console.error("[Bread] Move folders failed:", err)
        await mutateFolders(prev, { revalidate: false })
      } finally {
        pendingMovesRef.current -= 1
      }
    },
    [rawFolders, mutateFolders],
  )

  const showError = useCallback((message: string) => {
    setErrorMessage(message)
    setTimeout(() => setErrorMessage(null), 3000)
  }, [])

  const handleReorderFolders = useCallback(
    async (
      folderIds: string[],
      targetFolderId: string,
      position: FolderReorderPosition,
    ) => {
      const currentFolders = rawFolders ?? []
      const folderById = new Map(currentFolders.map((folder) => [folder.id, folder]))
      const targetFolder = folderById.get(targetFolderId)
      if (!targetFolder || targetFolder.kind !== "user") return

      const requested = folderIds.filter((id) => id !== targetFolderId)
      if (requested.length === 0) return

      const requestedSet = new Set(requested)
      const roots = requested.filter((id) => {
        const folder = folderById.get(id)
        if (!folder || folder.kind !== "user") return false
        const parentId = folder.parent_folder_id
        return !parentId || !requestedSet.has(parentId)
      })
      if (roots.length === 0) return

      const parentById = new Map(
        currentFolders.map((folder) => [folder.id, folder.parent_folder_id] as const),
      )
      const isDescendantOf = (folderId: string, possibleAncestorId: string): boolean => {
        let parentId = parentById.get(folderId) ?? null
        while (parentId) {
          if (parentId === possibleAncestorId) return true
          parentId = parentById.get(parentId) ?? null
        }
        return false
      }
      if (roots.some((id) => isDescendantOf(targetFolderId, id))) return

      const targetParentId = targetFolder.parent_folder_id ?? null
      const rootSet = new Set(roots)
      const siblingIds = currentFolders
        .filter(
          (folder) =>
            folder.kind === "user" &&
            (folder.parent_folder_id ?? null) === targetParentId,
        )
        .sort(comparePortalOrder)
        .map((folder) => folder.id)
        .filter((id) => !rootSet.has(id))

      const targetIndex = siblingIds.indexOf(targetFolderId)
      if (targetIndex === -1) return

      const insertIndex = position === "before" ? targetIndex : targetIndex + 1
      const orderedIds = [
        ...siblingIds.slice(0, insertIndex),
        ...roots,
        ...siblingIds.slice(insertIndex),
      ]
      const orderById = new Map(orderedIds.map((id, index) => [id, index]))
      const prevFolders = rawFolders

      pendingMovesRef.current += 1
      await mutateFolders(
        (current) =>
          current?.map((folder) => {
            const sortOrder = orderById.get(folder.id)
            if (rootSet.has(folder.id)) {
              return {
                ...folder,
                parent_folder_id: targetParentId,
                sort_order: sortOrder ?? folder.sort_order,
              }
            }
            return sortOrder === undefined
              ? folder
              : { ...folder, sort_order: sortOrder }
          }),
        { revalidate: false },
      )

      try {
        await Promise.all([
          ...roots
            .filter((id) => (folderById.get(id)?.parent_folder_id ?? null) !== targetParentId)
            .map((id) =>
              fetch(`/api/folders/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parent_folder_id: targetParentId }),
              }).then((res) => {
                if (!res.ok) {
                  throw new Error(`Move folder failed: ${res.status}`)
                }
              }),
            ),
          reorderFolders("user", orderedIds),
        ])
        onFoldersReordered?.()
      } catch (err) {
        console.error("[Bread] Reorder folders failed:", err)
        showError(err instanceof Error ? err.message : "Failed to save folder order")
        await mutateFolders(prevFolders, { revalidate: false })
      } finally {
        pendingMovesRef.current -= 1
      }
    },
    [mutateFolders, onFoldersReordered, rawFolders, showError],
  )

  const handleReorderDocs = useCallback(
    async (
      docIds: string[],
      targetDocId: string,
      position: FolderReorderPosition,
    ) => {
      const currentDocs = rawDocs ?? []
      const docById = new Map(currentDocs.map((doc) => [doc.id, doc]))
      const targetDoc = docById.get(targetDocId)
      if (!targetDoc) return

      const requested = docIds.filter(
        (id) => id !== targetDocId && docById.has(id),
      )
      if (requested.length === 0) return
      const requestedSet = new Set(requested)

      // Dropping before/after a doc also adopts its folder, so a cross-folder
      // drag lands exactly where the indicator showed it.
      const targetFolderId = targetDoc.folder_id ?? null
      const siblingIds = currentDocs
        .filter((doc) => (doc.folder_id ?? null) === targetFolderId)
        .sort(compareDocPortalOrder)
        .map((doc) => doc.id)
        .filter((id) => !requestedSet.has(id))

      const targetIndex = siblingIds.indexOf(targetDocId)
      if (targetIndex === -1) return

      const insertIndex = position === "before" ? targetIndex : targetIndex + 1
      const orderedIds = [
        ...siblingIds.slice(0, insertIndex),
        ...requested,
        ...siblingIds.slice(insertIndex),
      ]
      const orderById = new Map(orderedIds.map((id, index) => [id, index]))
      const prevDocs = rawDocs

      pendingMovesRef.current += 1
      await mutateDocs(
        (current) =>
          current?.map((doc) => {
            const sortOrder = orderById.get(doc.id)
            if (requestedSet.has(doc.id)) {
              return {
                ...doc,
                folder_id: targetFolderId,
                sort_order: sortOrder ?? doc.sort_order ?? null,
              }
            }
            return sortOrder === undefined
              ? doc
              : { ...doc, sort_order: sortOrder }
          }),
        { revalidate: false },
      )

      try {
        await Promise.all([
          ...requested
            .filter((id) => (docById.get(id)?.folder_id ?? null) !== targetFolderId)
            .map((id) =>
              fetch(`/api/documents/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ folder_id: targetFolderId }),
              }).then((res) => {
                if (!res.ok) {
                  throw new Error(`Move document failed: ${res.status}`)
                }
              }),
            ),
          reorderDocuments(orderedIds),
        ])
        onFoldersReordered?.()
      } catch (err) {
        console.error("[Bread] Reorder documents failed:", err)
        showError(
          err instanceof Error ? err.message : "Failed to save document order",
        )
        await mutateDocs(prevDocs, { revalidate: false })
      } finally {
        pendingMovesRef.current -= 1
      }
    },
    [mutateDocs, onFoldersReordered, rawDocs, showError],
  )

  const handleCreateFolder = useCallback(async () => {
    const baseName = newFolderName.trim()
    if (!baseName) return

    const existingNames = folders.map((f) => f.name)
    const name = deduplicateName(baseName, existingNames)

    const optimisticId = crypto.randomUUID()
    const now = new Date().toISOString()
    const parentFolderId = newFolderParentId
    // A nested folder inherits its parent's scope (the picker is only shown for
    // root folders); a root folder uses whatever the picker selected. Portal
    // sections default to workspace here — the project governs their access.
    const parentFolder = parentFolderId
      ? folders.find((f) => f.id === parentFolderId)
      : undefined
    const scopeForRequest: FolderScope = parentFolder
      ? {
          visibility: parentFolder.visibility,
          required_role: parentFolder.required_role,
        }
      : newFolderScope
    const optimisticFolder = {
      id: optimisticId,
      name,
      display_name: name,
      kind: "user" as const,
      parent_folder_id: parentFolderId,
      visibility: scopeForRequest.visibility,
      required_role: scopeForRequest.required_role,
      sort_order: null,
      icon: null,
      document_count: 0,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    }

    // Optimistically add the new folder to the cache
    await mutateFolders(
      (current) => current ? [...current, optimisticFolder] : [optimisticFolder],
      { revalidate: false },
    )
    setNewFolderName("")
    setCreatingFolder(false)
    setNewFolderParentId(null)
    if (parentFolderId) {
      // Reveal the new nested folder immediately.
      setOpenFolderIds((prev) => new Set(prev).add(parentFolderId))
    }
    setNewFolderScope({ visibility: "workspace", required_role: null })

    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: optimisticId,
          name,
          parent_folder_id: parentFolderId,
          visibility: scopeForRequest.visibility,
          required_role: scopeForRequest.required_role,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to create folder" }))
        throw new Error(err.error ?? "Failed to create folder")
      }
      const created = await res.json()
      await mutateFolders(
        (current) => current?.map((f) => f.id === optimisticId ? created : f),
        { revalidate: false },
      )
      // A new folder directly under the visible project root is a portal
      // section. Opt it into selective scopes before revalidation hides it.
      if (
        onSectionCreated &&
        (parentFolderId ?? null) === rootTargetFolderId
      ) {
        await onSectionCreated(created.id as string)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create folder"
      showError(message)
      await mutateFolders(
        (current) => current?.filter((f) => f.id !== optimisticId),
        { revalidate: false },
      )
    }
  }, [
    newFolderName,
    newFolderParentId,
    newFolderScope,
    folders,
    mutateFolders,
    onSectionCreated,
    rootTargetFolderId,
    showError,
  ])

  const handleCreateDoc = useCallback(
    async (folderId?: string, initialTitle?: string, initialContent?: string) => {
      const existingTitles = docs.map((d) => d.title)
      const title = initialTitle || deduplicateName("Untitled", existingTitles)

      const optimisticId = crypto.randomUUID()
      const now = new Date().toISOString()
      const documentPath = documentHref(
        routeRoot,
        optimisticId,
        scopedProjectSlug,
        portalPageSlug,
      )
      const documentKey = `/api/documents/${optimisticId}`
      const optimisticDoc = {
        id: optimisticId,
        title,
        content: initialContent || "",
        source: "Manual",
        status: "Draft",
        author: "You", // Fallback for optimistic UI
        folder_id: folderId ?? null,
        created_at: now,
        updated_at: now,
        __optimistic: true,
      }

      // Pre-populate the document editor's cache so it loads instantly
      globalMutate(documentKey, optimisticDoc, { revalidate: false })

      // Optimistically add the new doc to the cache
      void mutateDocs(
        (current) => current ? [...current, optimisticDoc as any] : [optimisticDoc as any],
        { revalidate: false },
      )

      // Only redirect if we're not bulk uploading (or just redirect to the last one)
      // For now, let's keep the redirect as is, or maybe only redirect if it's a manual "New Doc" click
      if (!initialContent) {
        void router.prefetch(documentPath)
        startTransition(() => {
          router.push(documentPath)
        })
      }

      try {
        const res = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: optimisticId,
            title,
            content: initialContent || "",
            folder_id: folderId ?? null,
          }),
        })
        if (!res.ok) throw new Error("Failed to create doc")
        const created = await res.json()
        if (
          useBuilderChrome &&
          (folderId ?? null) === rootTargetFolderId
        ) {
          await onRootDocumentCreated?.(created.id as string)
        }
        globalMutate(documentKey, created, { revalidate: false })
        // Use upsert semantics: a concurrent revalidation (e.g. from a
        // realtime event fired by the save-on-unmount of the previously
        // active doc) can wipe the optimistic entry before the POST resolves.
        // `map` alone would then silently drop the new doc.
        await mutateDocs(
          (current) => {
            if (!current) return [created]
            const exists = current.some((d) => d.id === optimisticId || d.id === created.id)
            return exists
              ? current.map((d) => (d.id === optimisticId || d.id === created.id ? created : d))
              : [...current, created]
          },
          { revalidate: false },
        )
      } catch {
        // Revert optimistic update
        globalMutate(documentKey, undefined, { revalidate: false })
        await mutateDocs(
          (current) => current?.filter((d) => d.id !== optimisticId),
          { revalidate: false },
        )
        if (selectedId === optimisticId) {
          router.push(rootHref(routeRoot, scopedProjectSlug, portalPageSlug))
        }
      }
    },
    [
      docs,
      globalMutate,
      mutateDocs,
      onRootDocumentCreated,
      portalPageSlug,
      rootTargetFolderId,
      routeRoot,
      router,
      scopedProjectSlug,
      selectedId,
      useBuilderChrome,
    ],
  )

  const openItemMenu = useCallback(
    (type: "doc" | "folder", id: string, name: string, x: number, y: number) => {
      const isInSelection = multiSelectedIds.has(id) && multiSelectedIds.size > 1
      const menuType = isInSelection ? "bulk" : type
      // Keep the menu on screen: a folder menu can be six rows tall and a
      // right-click near the sidebar's bottom-right corner would otherwise clip.
      const estimatedHeight =
        menuType === "bulk" ? 48 : menuType === "folder" ? 260 : 96
      const clampedX = Math.min(x, window.innerWidth - ROW_MENU_WIDTH - 8)
      const clampedY = Math.min(y, window.innerHeight - estimatedHeight - 8)
      if (isInSelection) {
        setContextMenu({
          type: "bulk",
          id,
          name,
          x: clampedX,
          y: clampedY,
          bulkCount: multiSelectedIds.size,
        })
      } else {
        setMultiSelectedIds(new Set())
        setContextMenu({ type, id, name, x: clampedX, y: clampedY })
      }
    },
    [multiSelectedIds],
  )

  // Right-clicking the empty space below the tree opens a root create menu.
  // The knowledge editor allows root docs (New document + New folder); the
  // portal builder is folder-only, so it offers just a new section.
  const openRootMenu = useCallback((x: number, y: number) => {
    const allowRootDocs = routeRoot === "knowledge"
    const estimatedHeight = (allowRootDocs ? 2 : 1) * 36 + 12
    const clampedX = Math.min(x, window.innerWidth - ROW_MENU_WIDTH - 8)
    const clampedY = Math.min(y, window.innerHeight - estimatedHeight - 8)
    setMultiSelectedIds(new Set())
    setContextMenu({ type: "root", id: "", name: "", x: clampedX, y: clampedY })
  }, [routeRoot])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    const prevDocs = rawDocs
    const prevFolders = rawFolders

    setDeleteTarget(null)

    if (deleteTarget.type === "bulk") {
      const docIds = deleteTarget.bulkDocIds ?? []
      const folderIds = deleteTarget.bulkFolderIds ?? []
      const docIdSet = new Set(docIds)
      const folderIdSet = collectFolderSubtreeIds(rawFolders, folderIds)
      const deletedAt = new Date().toISOString()

      if (docIds.length > 0) {
        await mutateDocs(
          (current) => current?.filter((d) => !docIdSet.has(d.id)),
          { revalidate: false },
        )
        for (const id of docIds) {
          globalMutate(
            `/api/documents/${id}`,
            (current: Record<string, unknown> | undefined) =>
              current
                ? { ...current, deleted_at: deletedAt, updated_at: deletedAt }
                : current,
            { revalidate: false },
          )
        }
        if (selectedId && docIdSet.has(selectedId)) {
          router.push(rootHref(routeRoot, scopedProjectSlug, portalPageSlug))
        }
      }
      if (folderIds.length > 0) {
        await mutateFolders(
          (current) => current?.filter((f) => !folderIdSet.has(f.id)),
          { revalidate: false },
        )
        // Documents inside deleted folders are moved to trash server-side.
        await mutateDocs(
          (current) =>
            current?.filter((d) => !(d.folder_id && folderIdSet.has(d.folder_id))),
          { revalidate: false },
        )
        if (selectedFolderId && folderIdSet.has(selectedFolderId)) {
          router.push(rootHref(routeRoot, scopedProjectSlug, portalPageSlug))
        } else if (selectedId && !docIdSet.has(selectedId)) {
          const selectedDoc = prevDocs?.find((d) => d.id === selectedId)
          if (selectedDoc?.folder_id && folderIdSet.has(selectedDoc.folder_id)) {
            router.push(rootHref(routeRoot, scopedProjectSlug, portalPageSlug))
          }
        }
      }

      setMultiSelectedIds(new Set())

      const results = await Promise.allSettled([
        ...docIds.map((id) => fetch(`/api/documents/${id}`, { method: "DELETE" })),
        ...folderIds.map((id) => fetch(`/api/folders/${id}`, { method: "DELETE" })),
      ])
      const failed = results.filter(
        (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok),
      ).length
      if (failed > 0) {
        showError(`Failed to delete ${failed} item${failed === 1 ? "" : "s"}`)
        await mutateDocs(prevDocs, { revalidate: false })
        await mutateFolders(prevFolders, { revalidate: false })
      }
      // The knowledge home page reads its own key and stays mounted while the
      // sidebar deletes, so it never revalidates on its own.
      void globalMutate("/api/documents/home")
      return
    }

    const { type, id } = deleteTarget
    if (type === "doc") {
      const deletedAt = new Date().toISOString()
      await mutateDocs(
        (current) => current?.filter((d) => d.id !== id),
        { revalidate: false },
      )
      globalMutate(
        `/api/documents/${id}`,
        (current: Record<string, unknown> | undefined) =>
          current
            ? { ...current, deleted_at: deletedAt, updated_at: deletedAt }
            : current,
        { revalidate: false },
      )
      if (selectedId === id) {
        router.push(rootHref(routeRoot, scopedProjectSlug, portalPageSlug))
      }
    } else {
      const subtreeIds = collectFolderSubtreeIds(rawFolders, [id])
      await mutateFolders(
        (current) => current?.filter((f) => !subtreeIds.has(f.id)),
        { revalidate: false },
      )
      // Documents inside the subtree are moved to trash server-side.
      await mutateDocs(
        (current) =>
          current?.filter((d) => !(d.folder_id && subtreeIds.has(d.folder_id))),
        { revalidate: false },
      )
      if (selectedFolderId && subtreeIds.has(selectedFolderId)) {
        router.push(rootHref(routeRoot, scopedProjectSlug, portalPageSlug))
      } else if (selectedId) {
        const selectedDoc = prevDocs?.find((d) => d.id === selectedId)
        if (selectedDoc?.folder_id && subtreeIds.has(selectedDoc.folder_id)) {
          router.push(rootHref(routeRoot, scopedProjectSlug, portalPageSlug))
        }
      }
    }

    try {
      const endpoint = type === "doc" ? `/api/documents/${id}` : `/api/folders/${id}`
      const res = await fetch(endpoint, { method: "DELETE" })
      if (!res.ok) throw new Error("Delete failed")
      void globalMutate("/api/documents/home")
    } catch {
      if (type === "doc") {
        await mutateDocs(prevDocs, { revalidate: false })
      } else {
        await mutateFolders(prevFolders, { revalidate: false })
        await mutateDocs(prevDocs, { revalidate: false })
      }
    }
  }, [
    deleteTarget,
    mutateDocs,
    mutateFolders,
    portalPageSlug,
    routeRoot,
    router,
    scopedProjectSlug,
    selectedFolderId,
    selectedId,
    rawDocs,
    rawFolders,
    globalMutate,
    showError,
  ])

  const handleRenameStart = useCallback((type: "doc" | "folder", id: string, name: string) => {
    setRenamingType(type)
    setRenamingId(id)
    setRenameValue(name)
    setContextMenu(null)
  }, [])

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingId || !renamingType) return
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setRenamingId(null)
      setRenamingType(null)
      return
    }

    try {
      if (renamingType === "doc") {
        // Optimistically update the title in cache
        await mutateDocs(
          (current) => current?.map((d) => d.id === renamingId ? { ...d, title: trimmed } : d),
          { revalidate: false },
        )
        await fetch(`/api/documents/${renamingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        })
      } else {
        // Optimistically update the folder name in cache
        await mutateFolders(
          (current) => current?.map((f) => f.id === renamingId ? { ...f, name: trimmed } : f),
          { revalidate: false },
        )
        await fetch(`/api/folders/${renamingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        })
      }
    } catch {
      // Error handled silently
    } finally {
      setRenamingId(null)
      setRenamingType(null)
    }
  }, [renamingId, renamingType, renameValue, mutateDocs, mutateFolders])

  const handleRenameCancel = useCallback(() => {
    setRenamingId(null)
    setRenamingType(null)
  }, [])

  const handleSetFolderIcon = useCallback(
    async (folderId: string, icon: string | null) => {
      // Optimistic: the tree row re-icons immediately.
      await mutateFolders(
        (current) =>
          current?.map((f) => (f.id === folderId ? { ...f, icon } : f)),
        { revalidate: false },
      )
      try {
        const res = await fetch(`/api/folders/${folderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ icon }),
        })
        if (!res.ok) throw new Error(`Failed: ${res.status}`)
      } catch (err) {
        console.error("[Bread] Update folder icon failed:", err)
        void mutateFolders()
      }
      // An open folder page header reads the detail cache — refresh it too
      // (keys carry optional ?project= suffixes, hence the prefix match).
      void globalMutate(
        (key) =>
          typeof key === "string" && key.startsWith(`/api/folders/${folderId}`),
      )
    },
    [globalMutate, mutateFolders],
  )

  // Hold the skeleton through the first client render: the SWR cache is
  // seeded synchronously from localStorage (see swr-provider), so docs/folders
  // can be present on the client while the server rendered the skeleton —
  // branching on that data before hydration completes throws a hydration error.
  const hasHydrated = useHasHydrated()
  const isLoading =
    !hasHydrated ||
    !workspaceId ||
    loadedWorkspaceId !== workspaceId ||
    (docsLoading && !rawDocs) ||
    (foldersLoading && !rawFolders)

  return (
    <div
      ref={navRef}
      className={cn(
        "flex flex-1 flex-col",
        useBuilderChrome ? "space-y-3 pt-0" : "min-h-0 pt-1",
        className,
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget && multiSelectedIds.size > 0) {
          setMultiSelectedIds(new Set())
        }
      }}
    >
      {useBuilderChrome ? (
        <div className="space-y-2 px-2">
          <div className="flex h-7 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                Documents
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Popover
                open={builderSearchOpen}
                onOpenChange={(open) => {
                  if (!open) handleQueryChange("")
                  setBuilderSearchOpen(open)
                }}
              >
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant={builderSearchOpen ? "secondary" : "ghost"}
                      size="icon-sm"
                      aria-label="Search documents"
                      className="text-muted-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
                    >
                      <Search className="size-4" />
                    </Button>
                  }
                />
                <PopoverContent align="end" className="w-64 p-2">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      autoFocus
                      placeholder="Filter documents..."
                      className="h-8 pl-7 text-xs"
                      value={query}
                      onChange={(e) => handleQueryChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          handleQueryChange("")
                          setBuilderSearchOpen(false)
                        }
                      }}
                    />
                  </div>
                </PopoverContent>
              </Popover>
              <SortModeDropdown value={sortMode} onChange={handleSortModeChange} />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Create document or folder"
                      className="text-muted-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
                    >
                      <Plus className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem
                    onClick={() => void handleCreateDoc(rootTargetFolderId ?? undefined)}
                  >
                    <FilePlus className="size-3.5" />
                    New doc
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setNewFolderParentId(rootTargetFolderId)
                      setCreatingFolder(true)
                    }}
                  >
                    <FolderPlus className="size-3.5" />
                    New folder
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      ) : (
        <div
          data-slot="documents-sub-nav-controls"
          className="shrink-0 space-y-3 bg-background pb-3"
        >
          {/* Search + sort */}
          <div className="flex items-center gap-1">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter..."
                className="h-7 pl-7 text-xs"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
              />
            </div>
            <SortModeDropdown value={sortMode} onChange={handleSortModeChange} />
          </div>

          {/* Action buttons — the knowledge editor allows root-level docs, so
              both create actions live here. (The portal builder, which is
              folder-only, uses builder chrome above instead.) Docs can also be
              created inside a folder from its row menu (three dots / right-click). */}
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                // Create inside the folder the user is currently in (viewing a
                // folder, or a doc that lives in one); otherwise create at root.
                const targetFolderId =
                  selectedFolderId ??
                  docs.find((d) => d.id === selectedId)?.folder_id ??
                  undefined
                if (targetFolderId) {
                  setOpenFolderIds((prev) => new Set(prev).add(targetFolderId))
                }
                void handleCreateDoc(targetFolderId)
              }}
              className="flex-1 gap-1 text-[11px] text-muted-foreground"
            >
              <Plus className="size-3" />
              New Doc
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setNewFolderParentId(null)
                setCreatingFolder(true)
              }}
              className="flex-1 gap-1 text-[11px] text-muted-foreground"
            >
              <FolderPlus className="size-3" />
              New Folder
            </Button>
          </div>
        </div>
      )}

      {/* Create folder dialog */}
      <Dialog
        open={creatingFolder}
        onOpenChange={(open) => {
          if (!open) {
            setCreatingFolder(false)
            setNewFolderParentId(null)
            setNewFolderName("")
            setNewFolderScope({
              visibility: "workspace",
              required_role: null,
            })
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {useBuilderChrome && newFolderParentId === rootTargetFolderId
                ? "New section"
                : "New folder"}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleCreateFolder()
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              placeholder={
                useBuilderChrome && newFolderParentId === rootTargetFolderId
                  ? "Section name"
                  : "Folder name"
              }
              className="h-8 text-sm"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            {/* Scope is only chosen for a root folder in the knowledge editor.
                Nested folders inherit their parent; portal sections inherit the
                project. */}
            {!useBuilderChrome && !newFolderParentId && (
              <FolderScopePicker
                value={newFolderScope}
                onChange={setNewFolderScope}
              />
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreatingFolder(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!newFolderName.trim()}>
                {useBuilderChrome && newFolderParentId === rootTargetFolderId
                  ? "Create section"
                  : "Create folder"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* File tree — the default Knowledge chrome makes this the sole scroll
          viewport. Its sibling controls therefore remain stationary even
          during elastic overscroll. Builder chrome keeps using its existing
          parent-owned scroll region. */}
      <div
        data-slot="documents-sub-nav-tree"
        className={cn(
          "flex-1",
          !useBuilderChrome &&
            "min-h-0 overflow-x-hidden overflow-y-auto overscroll-y-none scrollbar-none",
        )}
        onContextMenu={(e) => {
          e.preventDefault()
          openRootMenu(e.clientX, e.clientY)
        }}
      >
        {isLoading ? (
          <DocumentTreeSkeleton />
        ) : filteredDocs.length === 0 && visibleRootFolders.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {query
              ? "No matches."
              : useBuilderChrome
                ? "No sections yet. Create one to get started."
                : "No documents yet. Create one to get started."}
          </p>
        ) : (
          <div className="space-y-1">
          {/* User folders (nested tree) */}
          {visibleRootFolders.map((folder) => (
            <FolderEntry
              key={folder.id}
              folder={folder}
              docs={docsByFolder.get(folder.id) ?? []}
              childFolders={foldersByParent.get(folder.id) ?? []}
              foldersByParent={foldersByParent}
              docsByFolder={docsByFolder}
              selectedDocId={selectedId}
              selectedFolderId={selectedFolderId}
              selectedDocIds={selectedDocIds}
              selectedFolderIds={selectedFolderIds}
              isRenaming={renamingType === "folder" && renamingId === folder.id}
              renameValue={renameValue}
              renamingDocId={renamingType === "doc" ? renamingId : null}
              renamingFolderId={renamingType === "folder" ? renamingId : null}
              docRenameValue={renameValue}
              onOpenDoc={handleSelect}
              onOpenFolder={handleOpenFolder}
              onCreateDoc={(folderId) => handleCreateDoc(folderId)}
              onDropDoc={(docId, folderId) => handleMoveDoc(docId, folderId)}
              onDropDocs={handleMoveDocs}
              onDropFolder={handleMoveFolder}
              onDropFolders={handleMoveFolders}
              reorderEnabled={reorderEnabled}
              onReorderFolders={handleReorderFolders}
              onReorderDocs={handleReorderDocs}
              onFolderMenu={(f, x, y) => openItemMenu("folder", f.id, f.name, x, y)}
              onDocMenu={(doc, x, y) => openItemMenu("doc", doc.id, doc.title, x, y)}
              onRenameChange={setRenameValue}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              onDocRenameChange={setRenameValue}
              onDocRenameSubmit={handleRenameSubmit}
              onDocRenameCancel={handleRenameCancel}
              onError={showError}
              openFolderIds={openFolderIds}
              onToggleFolder={handleToggleFolder}
              onInternalDragStart={handleInternalDragStart}
              onInternalDragEnd={handleInternalDragEnd}
            />
          ))}

          {/* Documents owned by the visible project root — also a drop target. */}
          <div
            data-testid="documents-root-drop-zone"
            className={cn(
              "rounded-md transition-colors",
              rootDragOver && "bg-primary/10 ring-1 ring-primary/30",
            )}
            onDragOver={(e) => {
              const types = e.dataTransfer.types
              const hasFiles = types.includes("Files")
              const hasInternalItems =
                types.includes(DRAG_TYPE) ||
                types.includes(MULTI_DOC_DRAG_TYPE) ||
                types.includes(FOLDER_DRAG_TYPE) ||
                types.includes(MULTI_FOLDER_DRAG_TYPE)
              const activeItems = activeInternalDragRef.current
              if (
                !hasFiles &&
                hasInternalItems &&
                activeItems &&
                !hasMovableItems(
                  activeItems,
                  rootTargetFolderId,
                  rawFolders,
                  rawDocs,
                )
              ) {
                e.dataTransfer.dropEffect = "none"
                setRootDragOver(false)
                return
              }
              if (
                hasInternalItems ||
                hasFiles
              ) {
                e.preventDefault()
                e.dataTransfer.dropEffect = hasFiles ? "copy" : "move"
                setRootDragOver(true)
              }
            }}
            onDragLeave={() => setRootDragOver(false)}
            onDrop={async (e) => {
              const activeItems = activeInternalDragRef.current
              activeInternalDragRef.current = null
              e.preventDefault()
              setRootDragOver(false)

              if (
                e.dataTransfer.files.length === 0 &&
                activeItems &&
                !hasMovableItems(
                  activeItems,
                  rootTargetFolderId,
                  rawFolders,
                  rawDocs,
                )
              ) {
                e.dataTransfer.dropEffect = "none"
                return
              }

              if (e.dataTransfer.files.length > 0) {
                const files = Array.from(e.dataTransfer.files)
                const supported = files.filter(
                  (f) =>
                    f.type.startsWith("text/") ||
                    [".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".json"].some((ext) =>
                      f.name.endsWith(ext),
                    ),
                )

                if (supported.length < files.length) {
                  showError(
                    `Skipped ${files.length - supported.length} unsupported file(s)`,
                  )
                }

                for (const file of supported) {
                  const content = await new Promise<string>((resolve) => {
                    const reader = new FileReader()
                    reader.onload = (e) => resolve(e.target?.result as string)
                    reader.readAsText(file)
                  })
                  handleCreateDoc(
                    rootTargetFolderId ?? undefined,
                    file.name,
                    content,
                  )
                }
                return
              }

              const multiFolderRaw = e.dataTransfer.getData(MULTI_FOLDER_DRAG_TYPE)
              const multiDocRaw = e.dataTransfer.getData(MULTI_DOC_DRAG_TYPE)
              if (multiFolderRaw || multiDocRaw) {
                if (multiFolderRaw) {
                  const ids = parseDragIds(multiFolderRaw)
                  if (ids.length > 0) handleMoveFolders(ids, rootTargetFolderId)
                }
                if (multiDocRaw) {
                  const ids = parseDragIds(multiDocRaw)
                  if (ids.length > 0) handleMoveDocs(ids, rootTargetFolderId)
                }
                return
              }

              const folderToMove = e.dataTransfer.getData(FOLDER_DRAG_TYPE)
              if (folderToMove) {
                handleMoveFolder(folderToMove, rootTargetFolderId)
                return
              }

              const docId = e.dataTransfer.getData(DRAG_TYPE)
              if (docId) handleMoveDoc(docId, rootTargetFolderId)
            }}
          >
            {visibleRootFolders.length > 0 && (
              <div className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                {rootDragOver
                  ? "Drop to root"
                  : visibleRootDocs.length > 0
                    ? useBuilderChrome
                      ? "Documents"
                      : "Unfiled"
                    : ""}
              </div>
            )}
            {visibleRootDocs.length > 0 && (
              <div className="space-y-0.5">
                {visibleRootDocs.map((doc) => (
                  <FileEntry
                    key={doc.id}
                    doc={doc}
                    isSelected={doc.id === selectedId}
                    isMultiSelected={selectedDocIds.has(doc.id)}
                    isRenaming={renamingType === "doc" && renamingId === doc.id}
                    renameValue={renameValue}
                    selectedDocIds={selectedDocIds}
                    selectedFolderIds={selectedFolderIds}
                    onSelect={handleSelect}
                    onOpenMenu={(x, y) =>
                      openItemMenu("doc", doc.id, doc.title, x, y)
                    }
                    onRenameChange={setRenameValue}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    reorderEnabled={reorderEnabled}
                    onReorderDocs={(ids, position) =>
                      handleReorderDocs(ids, doc.id, position)
                    }
                    onDropFolders={(ids) =>
                      handleMoveFolders(ids, doc.folder_id ?? rootTargetFolderId)
                    }
                    onInternalDragStart={handleInternalDragStart}
                    onInternalDragEnd={handleInternalDragEnd}
                  />
                ))}
              </div>
            )}
            {visibleRootDocs.length === 0 && folders.length > 0 && (
              <div className="h-8" />
            )}
          </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu &&
        createPortal(
          <div
            ref={contextMenuRef}
            className="fixed z-50 min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.type === "root" ? (
              <>
                <button
                  onClick={() => {
                    setContextMenu(null)
                    void handleCreateDoc(rootTargetFolderId ?? undefined)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <FilePlus className="size-3.5" />
                  New document
                </button>
                <button
                  onClick={() => {
                    setNewFolderParentId(rootTargetFolderId)
                    setCreatingFolder(true)
                    setContextMenu(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <FolderPlus className="size-3.5" />
                  {useBuilderChrome ? "New section" : "New folder"}
                </button>
              </>
            ) : (
              <>
                {contextMenu.type === "folder" && (
                  <>
                    <button
                      onClick={() => {
                        const folderId = contextMenu.id
                        setContextMenu(null)
                        setOpenFolderIds((prev) => new Set(prev).add(folderId))
                        void handleCreateDoc(folderId)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <FilePlus className="size-3.5" />
                      New document
                    </button>
                    <button
                      onClick={() => {
                        setNewFolderParentId(contextMenu.id)
                        setCreatingFolder(true)
                        setContextMenu(null)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <FolderPlus className="size-3.5" />
                      New folder
                    </button>
                    <div className="my-1 h-px bg-border" />
                  </>
                )}
                {contextMenu.type !== "bulk" && (
                  <button
                    onClick={() => {
                      handleRenameStart(
                        contextMenu.type as "doc" | "folder",
                        contextMenu.id,
                        contextMenu.name,
                      )
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <Pencil className="size-3.5" />
                    Rename
                  </button>
                )}
                {contextMenu.type === "folder" && (
                  <button
                    onClick={() => {
                      // Swap the row menu for the glyph grid at the same spot,
                      // re-clamped for the taller panel.
                      const gridHeight = 280
                      const gridWidth = 256
                      setIconMenu({
                        id: contextMenu.id,
                        x: Math.min(contextMenu.x, window.innerWidth - gridWidth - 8),
                        y: Math.min(contextMenu.y, window.innerHeight - gridHeight - 8),
                      })
                      setContextMenu(null)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <Shapes className="size-3.5" />
                    Change icon
                  </button>
                )}
                {contextMenu.type === "folder" && (
                  <button
                    onClick={() => {
                      setContextMenu(null)
                      handleOpenFolder(contextMenu.id)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <Shield className="size-3.5" />
                    Change visibility
                  </button>
                )}
                <button
                  onClick={() => {
                    if (contextMenu.type === "bulk") {
                      const docIds = [...selectedDocIds]
                      const folderIds = [...selectedFolderIds]
                      setDeleteTarget({
                        type: "bulk",
                        id: contextMenu.id,
                        name: contextMenu.name,
                        bulkCount: contextMenu.bulkCount ?? docIds.length + folderIds.length,
                        bulkDocIds: docIds,
                        bulkFolderIds: folderIds,
                      })
                    } else if (contextMenu.type !== "root") {
                      setDeleteTarget({
                        type: contextMenu.type,
                        id: contextMenu.id,
                        name: contextMenu.name,
                      })
                    }
                    setContextMenu(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive outline-none transition-colors hover:bg-destructive/10"
                >
                  <Trash2 className="size-3.5" />
                  {contextMenu.type === "bulk"
                    ? `Delete ${contextMenu.bulkCount ?? 0} selected items`
                    : contextMenu.type === "doc"
                      ? "Move to trash"
                      : "Delete"}
                </button>
              </>
            )}
          </div>,
          document.body,
        )}

      {/* Folder icon glyph grid (opened from the folder context menu) */}
      {iconMenu &&
        createPortal(
          <div
            className="fixed z-50 w-64 rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
            style={{ left: iconMenu.x, top: iconMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <FolderIconGrid
              value={folders.find((f) => f.id === iconMenu.id)?.icon ?? null}
              onSelect={(icon) => {
                const folderId = iconMenu.id
                setIconMenu(null)
                void handleSetFolderIcon(folderId, icon)
              }}
            />
          </div>,
          document.body,
        )}

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.type === "bulk"
                ? `Delete ${deleteTarget?.bulkCount ?? 0} items`
                : deleteTarget?.type === "folder"
                  ? "Delete folder"
                  : "Move document to trash"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "bulk"
                ? `Selected folders will be deleted along with all their subfolders. Selected documents and documents inside deleted folders will be moved to trash.`
                : deleteTarget?.type === "folder"
                  ? `Are you sure you want to delete "${deleteTarget?.name}"? All subfolders will be deleted and documents inside will be moved to trash.`
                  : `"${deleteTarget?.name}" will be moved to trash. You can restore it from Settings.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDeleteConfirm}
            >
              {deleteTarget?.type === "doc" ? "Move to trash" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Error message toast-like notification */}
      {errorMessage && (
        <div className="absolute bottom-4 left-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-destructive bg-destructive/10 p-3 text-destructive shadow-lg animate-in slide-in-from-bottom-2">
          <AlertCircle className="size-4 shrink-0" />
          <p className="text-xs font-medium leading-tight">{errorMessage}</p>
        </div>
      )}
    </div>
  )
}
