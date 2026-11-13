"use client"

import { useEffect, useId, useState } from "react"
import Link from "next/link"
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Upload,
} from "lucide-react"
import {
  useGithubHostedDocs,
  useGithubHostedDocsPublishStatus,
  useWorkspace,
} from "@/hooks/swr"
import { saveActiveDocumentBeforeWorkspacePublish } from "@/lib/workspace-publish-events"
import { Button, buttonVariants } from "@/components/ui/button"
import { LoadingBar } from "@/components/ui/loading-bar"
import { cn } from "@/lib/utils"
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

interface WorkspacePublishResult {
  pull_request_number: number
  pull_request_url: string
  branch?: string
  head?: string
  changed_file_count?: number
  file_count?: number
  commit_sha?: string
  reused?: boolean
}

const PUBLISH_ROLES = new Set(["owner", "admin", "editor"])
const CONFIGURE_ROLES = new Set(["owner", "admin"])
const UP_TO_DATE_ACKNOWLEDGEMENT_MS = 3000

async function responseFailure(
  response: Response,
): Promise<{ message: string; code: string | null }> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; message?: string; code?: string }
    | null
  return {
    message:
      payload?.error ??
      payload?.message ??
      `Could not publish workspace changes (${response.status}).`,
    code: payload?.code ?? null,
  }
}

/** Workspace-scoped GitHub publishing control for the Knowledge sidebar. */
export function WorkspaceGitHubPublish(): React.ReactElement | null {
  const { data: workspace } = useWorkspace()
  const { data, isLoading, mutate } = useGithubHostedDocs()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissedUpToDateKey, setDismissedUpToDateKey] = useState<string | null>(
    null,
  )
  const helperId = useId()

  const source = data?.source ?? null
  const canPublish = Boolean(
    workspace && PUBLISH_ROLES.has(workspace.user_role),
  )
  const canConfigure = Boolean(
    workspace && CONFIGURE_ROLES.has(workspace.user_role),
  )
  const sourceReady = source?.sync_status === "synced"

  const {
    data: publishStatus,
    error: publishStatusError,
    isLoading: publishStatusLoading,
    mutate: mutatePublishStatus,
  } = useGithubHostedDocsPublishStatus(source, { enabled: canPublish })
  const pullRequest = source?.publish_pull_request_url
    ? {
        number: source.publish_pull_request_number,
        url: source.publish_pull_request_url,
      }
    : null
  // A ReadMe-format link can commit straight to the synced branch, the way
  // ReadMe's own GitHub integration does, instead of opening a pull request.
  const directCommit =
    source?.format === "readme" && source.publish_mode === "direct"
  const exactStatusUpToDate = Boolean(
    canPublish && sourceReady && publishStatus?.status === "up_to_date",
  )
  const upToDateKey = [
    source?.id ?? "",
    source?.publish_pull_request_url ?? "",
    publishStatus?.compared_commit_sha ?? "",
  ].join(":")
  const upToDateVisible =
    exactStatusUpToDate && dismissedUpToDateKey !== upToDateKey

  useEffect(() => {
    if (!exactStatusUpToDate) return

    const timeout = window.setTimeout(
      () => setDismissedUpToDateKey(upToDateKey),
      UP_TO_DATE_ACKNOWLEDGEMENT_MS,
    )
    return () => window.clearTimeout(timeout)
  }, [
    exactStatusUpToDate,
    upToDateKey,
  ])

  useEffect(() => {
    if (publishStatus?.status !== "sync_required") return

    // Revalidate the lightweight hosted-docs source immediately. That check
    // reserves the persisted sync row and starts the narrow inbound sync, so
    // this path never waits for repository indexing or the scheduled sweep.
    void mutate()
  }, [mutate, publishStatus?.status])

  if (isLoading || !workspace) return null

  // Breeze internal tool: GitHub publishing isn't offered (no GitHub App), so
  // there is nothing to set up when no source is linked.
  if (!source) return null

  const disabledReason = !sourceReady
    ? source.sync_status === "disabled"
      ? "Merge the activation pull request before publishing workspace changes."
      : source.sync_status === "error"
        ? source.last_sync_error ??
          "Resolve the hosted docs sync error before publishing."
        : "Hosted documents are still syncing."
    : !canPublish
      ? "Only workspace editors, admins, and owners can publish changes."
      : undefined
  const activationPullRequest =
    source.sync_status === "disabled" && source.pending_pull_request_url
      ? {
          number: source.pending_pull_request_number,
          url: source.pending_pull_request_url,
        }
      : null

  const publish = async (): Promise<void> => {
    setPublishing(true)
    setError(null)
    try {
      await saveActiveDocumentBeforeWorkspacePublish()
      const response = await fetch("/api/github/hosted-docs/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          source.conflict_count > 0
            ? { conflict_resolution: "breezify" }
          : {},
        ),
      })
      if (!response.ok) {
        const failure = await responseFailure(response)
        if (failure.code === "no_changes") {
          setConfirmOpen(false)
          await mutatePublishStatus()
          return
        }
        throw new Error(failure.message)
      }

      const nextResult = (await response.json()) as WorkspacePublishResult
      await mutate(
        (current) =>
          current?.source
            ? {
                ...current,
                source: {
                  ...current.source,
                  publish_pull_request_number:
                    nextResult.pull_request_number,
                  publish_pull_request_url: nextResult.pull_request_url,
                  publish_pull_request_head:
                    nextResult.head ?? nextResult.branch ?? null,
                  publish_last_commit_sha: nextResult.commit_sha ?? null,
                },
              }
            : current,
        { revalidate: false },
      )
      setConfirmOpen(false)
      await Promise.all([mutate(), mutatePublishStatus()])
    } catch (publishError) {
      setError(
        publishError instanceof Error
          ? publishError.message
          : "Could not publish workspace changes.",
      )
    } finally {
      setPublishing(false)
    }
  }

  // Only offer publishing when the exact status says there is something to
  // send — a stale or blocked status must not open a misleading confirmation.
  const exactStatusPending =
    canPublish &&
    sourceReady &&
    !publishStatus &&
    !publishStatusError
  const exactStatusUnavailable =
    canPublish &&
    sourceReady &&
    (Boolean(publishStatusError) || publishStatus?.status === "unavailable")
  const exactStatusBlocked =
    canPublish && sourceReady && publishStatus?.status === "blocked"
  const exactStatusSyncRequired =
    canPublish && sourceReady && publishStatus?.status === "sync_required"
  if (exactStatusUpToDate && !upToDateVisible && !pullRequest) return null

  return (
    <div className="shrink-0 space-y-1 border-t border-border pt-3">
      {activationPullRequest ? (
        <a
          href={activationPullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "w-full justify-center",
          )}
          aria-describedby={helperId}
        >
          View activation pull request
          {activationPullRequest.number
            ? ` #${activationPullRequest.number}`
            : ""}
          <ExternalLink className="size-3" />
        </a>
      ) : !sourceReady ? (
        source.sync_status === "error" ? (
          canConfigure ? (
            <Link
              href="/settings/integrations/github"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "w-full justify-center",
              )}
              aria-describedby={helperId}
            >
              <AlertTriangle className="size-3.5" />
              Review GitHub sync
            </Link>
          ) : (
            <div className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground">
              <AlertTriangle className="size-3.5" />
              GitHub sync needs attention
            </div>
          )
        ) : source.sync_status === "disabled" ? (
          canConfigure ? (
            <Link
              href="/settings/integrations/github"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "w-full justify-center",
              )}
              aria-describedby={helperId}
            >
              Finish GitHub setup
            </Link>
          ) : (
            <div className="flex h-8 w-full items-center justify-center rounded-md border border-border px-2 text-xs font-medium text-muted-foreground">
              GitHub setup pending
            </div>
          )
        ) : (
          <div
            className="flex min-h-10 w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border px-2 py-2 text-xs font-medium text-muted-foreground"
            aria-live="polite"
          >
            <span>Syncing GitHub…</span>
            <LoadingBar label="GitHub sync progress" className="w-full max-w-32" />
          </div>
        )
      ) : exactStatusPending || publishStatusLoading ? (
        <div
          className="flex min-h-10 w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border px-2 py-2 text-xs font-medium text-muted-foreground"
          aria-live="polite"
        >
          <span>Checking GitHub…</span>
          <LoadingBar label="GitHub status check progress" className="w-full max-w-32" />
        </div>
      ) : upToDateVisible ? (
        <div
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground"
          aria-live="polite"
        >
          <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          {pullRequest ? "Pull request up to date" : "GitHub up to date"}
        </div>
      ) : exactStatusUpToDate ? null : exactStatusSyncRequired ? (
        <div
          className="flex min-h-10 w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border px-2 py-2 text-xs font-medium text-muted-foreground"
          aria-live="polite"
        >
          <span>Syncing latest GitHub changes…</span>
          <LoadingBar
            label="Latest GitHub changes sync progress"
            className="w-full max-w-32"
          />
        </div>
      ) : exactStatusUnavailable ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full justify-center"
          onClick={() => void mutatePublishStatus()}
        >
          <RefreshCw className="size-3.5" />
          Retry GitHub check
        </Button>
      ) : exactStatusBlocked ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full justify-center"
          disabled
          aria-describedby={helperId}
        >
          <AlertTriangle className="size-3.5" />
          Publishing unavailable
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          className="w-full justify-center"
          disabled={Boolean(disabledReason)}
          aria-describedby={disabledReason ? helperId : undefined}
          title={
            disabledReason ??
            (pullRequest
              ? "Add the latest workspace changes to the open pull request"
              : "Publish workspace changes through GitHub review")
          }
          onClick={() => {
            setError(null)
            setConfirmOpen(true)
          }}
        >
          <Upload className="size-3.5" />
          {pullRequest ? "Update pull request" : "Publish workspace"}
        </Button>
      )}

      {disabledReason ? (
        <p
          id={helperId}
          className="px-1 pt-0.5 text-[11px] leading-4 text-muted-foreground"
        >
          {disabledReason}
        </p>
      ) : null}

      {exactStatusUnavailable || exactStatusBlocked ? (
        <p
          id={helperId}
          className="px-1 pt-0.5 text-[11px] leading-4 text-muted-foreground"
        >
          {publishStatus?.message ??
            (exactStatusUnavailable
              ? "Breezify could not compare the workspace with GitHub."
              : "Resolve the publishing issue before trying again.")}
        </p>
      ) : null}

      {pullRequest ? (
        <a
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-6 w-full items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          View pull request
          {pullRequest.number ? ` #${pullRequest.number}` : ""}
          <ExternalLink className="size-3" />
        </a>
      ) : null}

      {source.conflict_count > 0 ? (
        <p className="flex items-start gap-1.5 px-1 pt-1 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {source.conflict_count} conflict
          {source.conflict_count === 1 ? "" : "s"} will keep the Breezify
          {" "}version.
        </p>
      ) : null}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!publishing) setConfirmOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pullRequest
                ? "Update the workspace pull request?"
                : "Publish workspace changes?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {directCommit ? (
                <>
                  Breezify will compare all linked documents in{" "}
                  {source.repo_full_name} and commit every saved change straight
                  to the {source.branch ?? "default"} branch.
                </>
              ) : (
                <>
                  Breezify will compare all linked documents in{" "}
                  {source.repo_full_name} and put every saved change into{" "}
                  {pullRequest ? "the open" : "one"} pull request. The{" "}
                  {source.branch ?? "default"} branch will not change until that
                  pull request is merged.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {source.conflict_count > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                {source.conflict_count} linked document
                {source.conflict_count === 1 ? " has" : "s have"} changes in
                both GitHub and Breezify. This {directCommit ? "commit will write" : "pull request will propose"} the Breezify
                versions for those files. Review those conflicts before continuing.
              </p>
            </div>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          {publishing ? (
            <LoadingBar
              label={
                directCommit
                  ? "GitHub commit progress"
                  : pullRequest
                    ? "Pull request update progress"
                    : "Pull request creation progress"
              }
            />
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={publishing}
              onClick={(event) => {
                event.preventDefault()
                void publish()
              }}
            >
              {directCommit
                ? publishing
                  ? "Committing to GitHub"
                  : "Commit to GitHub"
                : publishing
                  ? pullRequest
                    ? "Updating pull request"
                    : "Creating pull request"
                  : pullRequest
                    ? "Update pull request"
                    : "Create pull request"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
