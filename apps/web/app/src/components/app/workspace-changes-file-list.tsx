"use client"

import { useEffect, useRef } from "react"
import { FileMinus2, FilePen, FilePlus2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { DiffStat } from "@/components/app/text-diff-viewer"
import { useWorkspaceChanges } from "@/components/app/workspace-changes-context"

export const STATUS_ICON = {
  added: FilePlus2,
  modified: FilePen,
  removed: FileMinus2,
} as const

export const STATUS_TONE = {
  added: "text-emerald-700 dark:text-emerald-300",
  modified: "text-amber-700 dark:text-amber-400",
  removed: "text-red-700 dark:text-red-300",
} as const

/** Trailing path segment, with the leading directories shown muted beside it. */
function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/")
  return index === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

/**
 * Sidebar list of changed files: click a row to show its diff in the main
 * view, tick its checkbox to stage it for the next commit.
 */
export function WorkspaceChangesFileList(): React.ReactElement | null {
  const selectAllRef = useRef<HTMLInputElement>(null)
  const {
    activeFile,
    allSelected,
    files,
    selectedCount,
    selectedPaths,
    setActivePath,
    setAllSelected,
    toggleSelectedPath,
  } = useWorkspaceChanges()

  useEffect(() => {
    if (!selectAllRef.current) return
    selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected
  }, [allSelected, selectedCount])

  if (files.length === 0) return null

  return (
    <div className="mt-2 border-t border-border pt-2">
      <label className="flex h-8 items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
        <input
          ref={selectAllRef}
          type="checkbox"
          aria-label="Stage all changed files"
          checked={allSelected}
          onChange={() => setAllSelected(!allSelected)}
          className="size-3.5 accent-primary"
        />
        Stage all
      </label>
      <ul className="space-y-0.5">
        {files.map((file) => {
          const Icon = STATUS_ICON[file.status]
          const { dir, name } = splitPath(file.path)
          const isActive = activeFile?.path === file.path
          return (
            <li
              key={file.path}
              className={cn(
                "flex items-start rounded-md",
                isActive ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <label className="flex h-9 shrink-0 items-center pl-2">
                <input
                  type="checkbox"
                  aria-label={`Stage ${file.path}`}
                  checked={selectedPaths.has(file.path)}
                  onChange={() => toggleSelectedPath(file.path)}
                  className="size-3.5 accent-primary"
                />
              </label>
              <button
                type="button"
                onClick={() => setActivePath(file.path)}
                aria-current={isActive}
                title={file.path}
                className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left"
              >
                <Icon
                  className={cn("mt-0.5 size-3.5 shrink-0", STATUS_TONE[file.status])}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {name}
                  </span>
                  {dir ? (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {dir}
                    </span>
                  ) : null}
                </span>
                <DiffStat
                  previousText={file.previous}
                  nextText={file.next}
                  className="mt-0.5"
                />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
