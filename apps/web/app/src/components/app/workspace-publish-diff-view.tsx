"use client"

import { AlertTriangle, FileDiff } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { LoadingBar } from "@/components/ui/loading-bar"
import { TextDiffViewer } from "@/components/app/text-diff-viewer"
import { useWorkspaceChanges } from "@/components/app/workspace-changes-context"
import { STATUS_TONE } from "@/components/app/workspace-changes-file-list"

// ---------------------------------------------------------------------------
// "Files changed" review for a pending workspace publish. The changed paths
// (and their staging checkboxes) live in the Knowledge sidebar; this view
// shows the unified diff for whichever one is active there.
//
// The persistent Knowledge provider warms the bodies after its body-free
// publish-status check finds changes, then keeps them across route switches.
// ---------------------------------------------------------------------------

export type {
  PublishDiffFile,
  PublishDiffFileStatus,
} from "@/components/app/workspace-changes-context"

export function WorkspacePublishDiffView(): React.ReactElement {
  const {
    activeFile: selected,
    changedFileCount,
    data,
    error,
    files,
    loading,
    selectedCount,
    unavailableReason,
    refreshDiff,
  } = useWorkspaceChanges()
  const headerCount = data
    ? data.changed_file_count
    : loading
      ? null
      : changedFileCount
  return (
    // Standalone it owns the viewport height; inside the builder's preview
    // frame it fills the frame instead.
    <div className="flex h-[calc(100svh-3.5rem)] flex-col lg:h-screen [[data-preview-editor]_&]:h-full">
      <header className="shrink-0 border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-sm font-medium">
            <FileDiff className="size-4" />
            Files changed
          </h1>
          {files.length > 0 ? (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {selectedCount} staged
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 pl-6 text-xs text-muted-foreground">
          {/* Prefer the count the diff itself reported. The polled status
              count can go stale while this is open — it flipping to 0
              mid-request is what made the header read "0 files would change"
              under a spinner. */}
          {headerCount === null
            ? "Comparing the workspace with GitHub…"
            : `${headerCount} file${headerCount === 1 ? "" : "s"} would change on GitHub if you publish now.`}
          {data?.truncated ? ` Showing the first ${files.length}.` : ""}
        </p>
      </header>

      {unavailableReason ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle
            className="size-5 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="max-w-sm text-sm text-muted-foreground">
            {unavailableReason}
          </p>
        </div>
      ) : loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-sm text-muted-foreground">
          <span>Comparing the workspace with GitHub…</span>
          <LoadingBar
            label="Workspace GitHub comparison progress"
            className="w-full max-w-48"
          />
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-destructive">
            {error instanceof Error
              ? error.message
              : "Could not load the workspace diff."}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refreshDiff()}
          >
            Retry comparison
          </Button>
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Nothing has changed since the last publish.
        </div>
      ) : (
        // min-w-0 is load-bearing: a flex child defaults to min-width auto, so
        // one long unbroken token (a document UUID in the frontmatter) widened
        // this pane until the diff spilled past the page instead of scrolling.
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-4">
            {selected ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate font-mono text-xs">
                    {selected.path}
                  </p>
                  <span
                    className={cn(
                      "shrink-0 text-[11px] font-medium uppercase tracking-wide",
                      STATUS_TONE[selected.status],
                    )}
                  >
                    {selected.status}
                  </span>
                </div>
                {selected.bodyOmitted ? (
                  <p className="rounded border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    This file is too large to show a diff for. It will still be{" "}
                    {selected.status === "removed" ? "deleted" : "written"} when
                    you publish.
                  </p>
                ) : (
                  <TextDiffViewer
                    previousText={selected.previous}
                    nextText={selected.next}
                    emptyMessage="No textual changes."
                    className="h-full min-h-0 flex-1"
                  />
                )}
              </>
            ) : null}
          </div>
      )}
    </div>
  )
}
