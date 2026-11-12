"use client"

import { useMemo, useState } from "react"
import {
  Check,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Minus,
} from "lucide-react"
import type { FolderResponse } from "@/hooks/swr"
import {
  createScopeTreeView,
  toggleDoc as toggleScopeDoc,
  toggleFolder as toggleScopeFolder,
  toggleWorkspaceDocs as toggleScopeWorkspaceDocs,
  type ScopeTreeContext,
} from "@/lib/portal/scope-tree"
import type { PortalScopeEntry } from "@/lib/public-kb"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The scope tree selector: ONE checkbox tree for every surface that picks
// portal content. The project's "Included docs" panel and a page's own included
// docs are the same question asked about different scopes, so they ask it with
// the same component — tri-state folders, expandable subfolders, per-document
// leaves — over the shared scope algebra in lib/portal/scope-tree.ts.
// ---------------------------------------------------------------------------

// Tri-state checkbox square shared by folder and doc rows in the scope tree.
function ScopeCheckbox({ state }: { state: "full" | "partial" | "none" }): React.ReactElement {
  return (
    <span
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded border border-border transition-colors",
        state !== "none" && "border-emerald-600 bg-emerald-600/10 text-emerald-600",
      )}
    >
      {state === "full" ? <Check className="size-3" /> : null}
      {state === "partial" ? <Minus className="size-3" /> : null}
    </span>
  )
}

function ScopeDocLeaf({
  doc,
  checked,
  saving,
  depth,
  onToggle,
}: {
  doc: ScopeTreeDocRow
  checked: boolean
  saving: boolean
  depth: number
  onToggle: (docId: string) => void
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex h-7 items-center gap-1 rounded-md px-2 text-left text-xs transition-colors",
        checked
          ? "text-foreground"
          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
      )}
      // Chevron-width spacer (20px) keeps doc rows aligned with folder labels.
      style={{ paddingLeft: `${depth * 12 + 8 + 20}px` }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={saving}
        onClick={() => onToggle(doc.id)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
      >
        <ScopeCheckbox state={checked ? "full" : "none"} />
        <FileText className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate">{doc.title || "Untitled"}</span>
      </button>
    </div>
  )
}

interface ChecklistFolderNodeProps {
  folder: FolderResponse
  childrenByParent: Map<string | null, FolderResponse[]>
  docsByFolder: Map<string | null, ScopeTreeDocRow[]>
  folderStateOf: (id: string) => "full" | "partial" | "none"
  docCheckedOf: (id: string) => boolean
  expandedIds: Set<string>
  onToggleExpand: (id: string) => void
  onToggleCheck: (id: string) => void
  onToggleDoc: (id: string) => void
  saving: boolean
  depth: number
}

function ChecklistFolderNode({
  folder,
  childrenByParent,
  docsByFolder,
  folderStateOf,
  docCheckedOf,
  expandedIds,
  onToggleExpand,
  onToggleCheck,
  onToggleDoc,
  saving,
  depth,
}: ChecklistFolderNodeProps) {
  const children = childrenByParent.get(folder.id) ?? []
  const docs = docsByFolder.get(folder.id) ?? []
  const expandable = children.length > 0 || docs.length > 0
  const isExpanded = expandedIds.has(folder.id)
  const state = folderStateOf(folder.id)

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          "flex h-8 items-center gap-1 rounded-md px-2 text-left text-xs transition-colors",
          state === "full"
            ? "bg-background text-foreground shadow-sm font-medium"
            : state === "partial"
              ? "text-foreground hover:bg-background/70"
              : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <button
          type="button"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${folder.display_name}`}
          aria-expanded={expandable ? isExpanded : undefined}
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand(folder.id)
          }}
          disabled={!expandable}
          className={cn(
            "p-1 text-muted-foreground/60 hover:text-foreground rounded transition-opacity",
            !expandable && "opacity-0 pointer-events-none"
          )}
        >
          <ChevronRight
            className={cn("size-3 transition-transform", isExpanded && "rotate-90")}
          />
        </button>
        <button
          type="button"
          role="checkbox"
          aria-checked={state === "full" ? true : state === "partial" ? "mixed" : false}
          disabled={saving}
          onClick={() => onToggleCheck(folder.id)}
          className="flex flex-1 items-center gap-2 py-1 text-left min-w-0"
        >
          <ScopeCheckbox state={state} />
          {isExpanded ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate flex-1 min-w-0">{folder.display_name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {folder.document_count}
          </span>
        </button>
      </div>
      {expandable && isExpanded && (
        <div className="flex flex-col mt-0.5">
          {children.map((child) => (
            <ChecklistFolderNode
              key={child.id}
              folder={child}
              childrenByParent={childrenByParent}
              docsByFolder={docsByFolder}
              folderStateOf={folderStateOf}
              docCheckedOf={docCheckedOf}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onToggleCheck={onToggleCheck}
              onToggleDoc={onToggleDoc}
              saving={saving}
              depth={depth + 1}
            />
          ))}
          {docs.map((doc) => (
            <ScopeDocLeaf
              key={doc.id}
              doc={doc}
              checked={docCheckedOf(doc.id)}
              saving={saving}
              depth={depth + 1}
              onToggle={onToggleDoc}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export interface ScopeTreeDocRow {
  id: string
  title: string
  folder_id: string | null
}

interface ScopeTreeSelectorProps {
  /** Folders the caller already filtered to what this scope may include. */
  folders: FolderResponse[]
  /** Public-eligible documents, used for the per-document leaves. */
  documents: ScopeTreeDocRow[]
  /**
   * Folder the tree starts from. null = the whole workspace, which also adds
   * the "documents without a folder" group.
   */
  rootId: string | null
  scope: PortalScopeEntry[] | null
  onScopeChange: (scope: PortalScopeEntry[] | null) => void
  /** Disables every control (a save in flight, or an "all content" override). */
  disabled?: boolean
  /** Copy for a root that holds nothing yet. */
  emptyLabel?: string
  /** Overrides the scroll area's height cap. */
  listClassName?: string
}

const WORKSPACE_DOCS_KEY = "__workspace_docs__"

export function ScopeTreeSelector({
  folders,
  documents,
  rootId,
  scope,
  onScopeChange,
  disabled = false,
  emptyLabel = "No content here yet. Folders and documents saved into it will appear here.",
  listClassName,
}: ScopeTreeSelectorProps): React.ReactElement {
  const eligibleIds = useMemo(
    () => new Set(folders.map((folder) => folder.id)),
    [folders],
  )
  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  )

  // Children are keyed by parent, with any parent outside the eligible set
  // collapsed to the top level — the tree never renders a folder this scope
  // can't include.
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, FolderResponse[]>()
    for (const folder of folders) {
      const parentKey =
        folder.parent_folder_id && eligibleIds.has(folder.parent_folder_id)
          ? folder.parent_folder_id
          : null
      const siblings = map.get(parentKey) ?? []
      siblings.push(folder)
      map.set(parentKey, siblings)
    }
    map.forEach((list) =>
      list.sort((a, b) => a.display_name.localeCompare(b.display_name)),
    )
    return map
  }, [folders, eligibleIds])

  const docsByFolder = useMemo(() => {
    const map = new Map<string | null, ScopeTreeDocRow[]>()
    for (const doc of documents) {
      const key = doc.folder_id ?? null
      const list = map.get(key) ?? []
      list.push(doc)
      map.set(key, list)
    }
    map.forEach((list) => list.sort((a, b) => a.title.localeCompare(b.title)))
    return map
  }, [documents])

  // Open the branches that already carry a selection, so an existing scope is
  // visible without hunting for it.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>()
    for (const entry of scope ?? []) {
      const id =
        typeof entry === "string" ? entry : "id" in entry ? entry.id : ""
      let currentId = id
      let hops = 0
      while (currentId && hops < 32) {
        const parentId = folderById.get(currentId)?.parent_folder_id ?? null
        if (parentId) ids.add(parentId)
        currentId = parentId ?? ""
        hops += 1
      }
    }
    return ids
  })

  const toggleExpand = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const context: ScopeTreeContext = {
    folders: folders.map((folder) => ({
      id: folder.id,
      parent_folder_id: folder.parent_folder_id,
    })),
    docs: documents.map((doc) => ({ id: doc.id, folder_id: doc.folder_id })),
    rootId,
  }
  const treeView = createScopeTreeView(scope, context)

  const topFolders = childrenByParent.get(rootId ?? null) ?? []
  const rootLevelDocs = rootId ? docsByFolder.get(rootId) ?? [] : []
  const looseDocs = rootId === null ? docsByFolder.get(null) ?? [] : []
  const workspaceDocsState = treeView.workspaceDocsState()

  if (
    topFolders.length === 0 &&
    rootLevelDocs.length === 0 &&
    looseDocs.length === 0
  ) {
    return (
      <p className="rounded-md border border-dashed border-border px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {emptyLabel}
      </p>
    )
  }

  return (
    <div
      className={cn(
        "max-h-60 space-y-0.5 overflow-y-auto pr-1 scrollbar-none",
        listClassName,
      )}
    >
      {topFolders.map((folder) => (
        <ChecklistFolderNode
          key={folder.id}
          folder={folder}
          childrenByParent={childrenByParent}
          docsByFolder={docsByFolder}
          folderStateOf={treeView.folderState}
          docCheckedOf={treeView.docChecked}
          expandedIds={expandedIds}
          onToggleExpand={toggleExpand}
          onToggleCheck={(folderId) =>
            onScopeChange(toggleScopeFolder(scope, context, folderId))
          }
          onToggleDoc={(docId) =>
            onScopeChange(toggleScopeDoc(scope, context, docId))
          }
          saving={disabled}
          depth={0}
        />
      ))}
      {rootLevelDocs.map((doc) => (
        <ScopeDocLeaf
          key={doc.id}
          doc={doc}
          checked={treeView.docChecked(doc.id)}
          saving={disabled}
          depth={0}
          onToggle={(docId) => onScopeChange(toggleScopeDoc(scope, context, docId))}
        />
      ))}
      {looseDocs.length > 0 ? (
        <div className="flex flex-col">
          <div
            className={cn(
              "flex h-8 items-center gap-1 rounded-md px-2 text-left text-xs transition-colors",
              workspaceDocsState === "full"
                ? "bg-background text-foreground shadow-sm font-medium"
                : workspaceDocsState === "partial"
                  ? "text-foreground hover:bg-background/70"
                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
          >
            <button
              type="button"
              aria-label={`${expandedIds.has(WORKSPACE_DOCS_KEY) ? "Collapse" : "Expand"} documents without a folder`}
              aria-expanded={expandedIds.has(WORKSPACE_DOCS_KEY)}
              onClick={() => toggleExpand(WORKSPACE_DOCS_KEY)}
              className="rounded p-1 text-muted-foreground/60 hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-3 transition-transform",
                  expandedIds.has(WORKSPACE_DOCS_KEY) && "rotate-90",
                )}
              />
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={
                workspaceDocsState === "full"
                  ? true
                  : workspaceDocsState === "partial"
                    ? "mixed"
                    : false
              }
              disabled={disabled}
              onClick={() => onScopeChange(toggleScopeWorkspaceDocs(scope, context))}
              className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
            >
              <ScopeCheckbox state={workspaceDocsState} />
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                Documents without a folder
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {looseDocs.length}
              </span>
            </button>
          </div>
          {expandedIds.has(WORKSPACE_DOCS_KEY) ? (
            <div className="mt-0.5 flex flex-col">
              {looseDocs.map((doc) => (
                <ScopeDocLeaf
                  key={doc.id}
                  doc={doc}
                  checked={treeView.docChecked(doc.id)}
                  saving={disabled}
                  depth={1}
                  onToggle={(docId) =>
                    onScopeChange(toggleScopeDoc(scope, context, docId))
                  }
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
