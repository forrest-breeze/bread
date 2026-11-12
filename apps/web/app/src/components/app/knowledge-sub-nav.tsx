"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { FileText, GitCompareArrows } from "lucide-react"
import { cn } from "@/lib/utils"
import { LoadingBar } from "@/components/ui/loading-bar"
import { DocumentsSubNav } from "@/components/app/documents-sub-nav"
import { WorkspaceChangesCommitPanel } from "@/components/app/workspace-changes-commit-panel"
import { WorkspaceChangesFileList } from "@/components/app/workspace-changes-file-list"
import { useWorkspaceChanges } from "@/components/app/workspace-changes-context"

type DocumentsNavProps = Omit<
  React.ComponentProps<typeof DocumentsSubNav>,
  "routeRoot" | "projectSlug" | "portalPageSlug" | "portalPageScope"
>

/**
 * Knowledge navigation plus the workspace-wide GitHub review surface. The
 * portal builder rail renders this same component, so both read the one
 * workspace-wide document/folder cache.
 */
export function KnowledgeSubNav({
  navProps,
  className,
}: {
  /** Extra props for the document tree (search, sort, builder chrome). */
  navProps?: DocumentsNavProps
  className?: string
} = {}): React.ReactElement {
  const pathname = usePathname()
  const {
    changedFileCount,
    checkingGitHub,
    data: diff,
    loading,
  } = useWorkspaceChanges()

  const showingChanges =
    pathname === "/knowledge/changes" ||
    pathname.startsWith("/knowledge/changes/")
  const preparingDiff = loading && changedFileCount > 0 && !diff

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="shrink-0 border-b border-border pb-2">
        <div
          role="tablist"
          aria-label="Knowledge views"
          className="grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1"
        >
          <Link
            href="/knowledge"
            role="tab"
            aria-selected={!showingChanges}
            className={cn(
              "flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
              !showingChanges &&
                "bg-background text-foreground shadow-sm ring-1 ring-border/60",
            )}
          >
            <FileText className="size-3.5" aria-hidden="true" />
            Documents
          </Link>
          <Link
            href="/knowledge/changes"
            role="tab"
            aria-selected={showingChanges}
            className={cn(
              "flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
              showingChanges &&
                "bg-background text-foreground shadow-sm ring-1 ring-border/60",
            )}
          >
            <GitCompareArrows className="size-3.5 shrink-0" aria-hidden="true" />
            <span>Changes</span>
            {changedFileCount > 0 ? (
              <span className="flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground tabular-nums">
                {changedFileCount}
              </span>
            ) : null}
          </Link>
        </div>
        {!showingChanges && (checkingGitHub || preparingDiff) ? (
          <LoadingBar
            label={
              checkingGitHub
                ? "Checking saved changes against GitHub"
                : "Preparing GitHub changes"
            }
            className="mt-2"
          />
        ) : null}
      </div>

      {showingChanges ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-3">
          <div className="space-y-1 px-1 pb-2">
            <p className="text-xs font-medium">GitHub review</p>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {checkingGitHub
                ? "Checking your latest saved edit against GitHub."
                : changedFileCount > 0
                  ? `${changedFileCount} saved file${changedFileCount === 1 ? " differs" : "s differ"} from GitHub. Select a file to view its diff; check it to stage it.`
                  : "Saved workspace changes will appear here as soon as they differ from GitHub."}
            </p>
          </div>
          <WorkspaceChangesCommitPanel />
          <WorkspaceChangesFileList />
        </div>
      ) : (
        <DocumentsSubNav {...navProps} routeRoot="knowledge" />
      )}
    </div>
  )
}
