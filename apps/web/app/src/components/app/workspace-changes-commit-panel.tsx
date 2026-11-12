"use client"

import { useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitCommitHorizontal,
  RotateCcw,
} from "lucide-react"
import { useWorkspaceChanges } from "@/components/app/workspace-changes-context"
import { WorkspaceGitHubPublish } from "@/components/app/workspace-github-publish"
import { Button } from "@/components/ui/button"
import { LoadingBar } from "@/components/ui/loading-bar"
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

/** Git-style staging summary and one commit action for the selected files. */
export function WorkspaceChangesCommitPanel(): React.ReactElement {
  const {
    conflictCount,
    data,
    error,
    files,
    loading,
    mutation,
    mutationError,
    pullRequest,
    selectedCanRevert,
    selectedCount,
    clearMutationError,
    commitSelected,
    refreshDiff,
    revertSelected,
  } = useWorkspaceChanges()
  const [confirmation, setConfirmation] = useState<
    "commit" | "revert" | null
  >(null)

  // Preserve setup, sync, and error recovery controls until an exact diff is
  // available. The publish-all button never renders once files can be staged.
  if (!loading && !data && !error) return <WorkspaceGitHubPublish />

  const confirmAction = async (): Promise<void> => {
    const succeeded =
      confirmation === "revert"
        ? await revertSelected()
        : await commitSelected()
    if (succeeded) setConfirmation(null)
  }

  return (
    <div className="mt-2 space-y-3 border-t border-border px-1 pt-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium">Staged changes</p>
          {files.length > 0 ? (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {selectedCount} of {files.length}
            </span>
          ) : null}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          Use the checkboxes below to add or remove files from this commit.
        </p>
      </div>

      {loading ? (
        <p className="rounded-md border border-border px-3 py-2 text-[11px] text-muted-foreground">
          Preparing saved changes…
        </p>
      ) : error ? (
        <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[11px] leading-4 text-destructive">
            {error instanceof Error
              ? error.message
              : "Could not load the workspace diff."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => void refreshDiff()}
          >
            Retry
          </Button>
        </div>
      ) : files.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              selectedCount === 0 || !selectedCanRevert || mutation !== null
            }
            title={
              selectedCanRevert
                ? "Make the staged Bread files match GitHub"
                : "One or more staged files cannot be safely reverted from this diff"
            }
            onClick={() => {
              clearMutationError()
              setConfirmation("revert")
            }}
          >
            <RotateCcw className="size-3.5" />
            Revert
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={selectedCount === 0 || mutation !== null}
            onClick={() => {
              clearMutationError()
              setConfirmation("commit")
            }}
          >
            <GitCommitHorizontal className="size-3.5" />
            Commit
          </Button>
        </div>
      ) : (
        <div className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-border text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          GitHub up to date
        </div>
      )}

      {mutationError && confirmation === null ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] leading-4 text-destructive"
        >
          {mutationError}
        </p>
      ) : null}

      {pullRequest ? (
        <a
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-7 w-full items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          View pull request{pullRequest.number ? ` #${pullRequest.number}` : ""}
          <ExternalLink className="size-3" />
        </a>
      ) : null}

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !mutation) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation === "revert"
                ? `Revert ${selectedCount} staged change${selectedCount === 1 ? "" : "s"}?`
                : `Commit ${selectedCount} staged change${selectedCount === 1 ? "" : "s"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === "revert"
                ? "Modified and removed files will be restored from the GitHub comparison. Newly added Bread documents will move to Trash, where they can still be recovered."
                : "Bread will create one GitHub commit containing every staged file and add it to the workspace pull request. Unstaged changes will remain in this view."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {conflictCount > 0 && confirmation === "commit" ? (
            <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                {conflictCount} GitHub conflict
                {conflictCount === 1 ? "" : "s"} will keep the current Bread
                version for this commit.
              </span>
            </p>
          ) : null}
          {mutationError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {mutationError}
            </p>
          ) : null}
          {mutation ? (
            <LoadingBar
              label={
                mutation === "commit"
                  ? "Staged changes commit progress"
                  : "Staged changes revert progress"
              }
            />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant={confirmation === "revert" ? "destructive" : "default"}
              disabled={mutation !== null}
              onClick={(event) => {
                event.preventDefault()
                void confirmAction()
              }}
            >
              {mutation === "revert"
                ? "Reverting staged changes"
                : mutation === "commit"
                  ? "Committing staged changes"
                  : confirmation === "revert"
                    ? "Revert staged changes"
                    : "Commit staged changes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
