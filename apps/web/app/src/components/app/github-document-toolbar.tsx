"use client"

import { useState } from "react"
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Trash2,
} from "lucide-react"
import type { GitHubDocumentStateResponse } from "@/hooks/swr"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { TextDiffViewer } from "@/components/app/text-diff-viewer"
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

interface GitHubDocumentToolbarProps {
  documentId: string
  state: GitHubDocumentStateResponse
  hasUnsavedChanges: boolean
  saveDraft: () => Promise<boolean>
  refresh: () => Promise<unknown>
  onUseDeployment: (content: string) => void
  disabled?: boolean
}

type PublishMode = "pr" | "commit"

async function responseMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string }
    if (payload.error) return payload.error
  } catch {
    // Use the status-based fallback below.
  }
  return `GitHub returned ${response.status}.`
}

export function GitHubDocumentToolbar({
  documentId,
  state,
  hasUnsavedChanges,
  saveDraft,
  refresh,
  onUseDeployment,
  disabled = false,
}: GitHubDocumentToolbarProps): React.ReactElement {
  const session = state.session
  const [publishMode, setPublishMode] = useState<PublishMode>("pr")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState(
    `docs: update ${state.repository.file_path}`,
  )
  const [pullRequestTitle, setPullRequestTitle] = useState(
    `Update ${state.repository.file_path}`,
  )
  const [pullRequestBody, setPullRequestBody] = useState(
    `Updates \`${state.repository.file_path}\` from Breezify's collaborative editor.`,
  )
  const [busy, setBusy] = useState<
    "idle" | "publishing" | "discarding" | "resolving"
  >("idle")
  const [announcement, setAnnouncement] = useState("")
  const [branchCopied, setBranchCopied] = useState(false)
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false)
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)

  const beginPublish = (mode: PublishMode): void => {
    setPublishMode(mode)
    setAnnouncement("")
    setDialogOpen(true)
  }

  const publish = async (): Promise<void> => {
    setBusy("publishing")
    setAnnouncement("Saving the shared draft before publishing.")
    try {
      const saved = await saveDraft()
      if (!saved) {
        setAnnouncement("The draft could not be saved.")
        return
      }
      const response = await fetch(`/api/documents/${documentId}/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          mode: publishMode,
          message: commitMessage,
          ...(publishMode === "pr"
            ? {
                pr_title: pullRequestTitle,
                pr_body: pullRequestBody,
              }
            : {}),
        }),
      })
      if (!response.ok) {
        const message = await responseMessage(response)
        await refresh()
        setAnnouncement(message)
        return
      }
      await refresh()
      setDialogOpen(false)
      setAnnouncement(
        publishMode === "pr"
          ? "Pull request created. GitHub now has the latest draft."
          : "Draft committed to the feature branch.",
      )
    } catch {
      setAnnouncement("Could not reach GitHub. Try again.")
    } finally {
      setBusy("idle")
    }
  }

  const discard = async (): Promise<void> => {
    setBusy("discarding")
    try {
      const response = await fetch(`/api/documents/${documentId}/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discard" }),
      })
      if (!response.ok) throw new Error(await responseMessage(response))
      await refresh()
      setDiscardDialogOpen(false)
      setAnnouncement("Draft discarded. Showing the deployment version.")
    } catch (error) {
      setAnnouncement(
        error instanceof Error ? error.message : "Could not discard the draft.",
      )
    } finally {
      setBusy("idle")
    }
  }

  const acceptDeploymentVersion = async (): Promise<void> => {
    setBusy("resolving")
    try {
      const response = await fetch(`/api/documents/${documentId}/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "use_deployment" }),
      })
      if (!response.ok) throw new Error(await responseMessage(response))
      const payload = (await response.json()) as {
        session: { draft_content: string }
      }
      onUseDeployment(payload.session.draft_content)
      await refresh()
      setConflictDialogOpen(false)
      setAnnouncement("The shared draft now matches the deployment branch.")
    } catch (error) {
      setAnnouncement(
        error instanceof Error
          ? error.message
          : "Could not use the deployment version.",
      )
    } finally {
      setBusy("idle")
    }
  }

  const acceptDraftVersion = async (): Promise<void> => {
    setBusy("resolving")
    try {
      const response = await fetch(`/api/documents/${documentId}/github`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "use_draft" }),
      })
      if (!response.ok) throw new Error(await responseMessage(response))
      await refresh()
      setConflictDialogOpen(false)
      setAnnouncement(
        "Conflict resolved in favor of the Breezify draft. Publish again when ready.",
      )
    } catch (error) {
      setAnnouncement(
        error instanceof Error
          ? error.message
          : "Could not keep the Breezify draft.",
      )
    } finally {
      setBusy("idle")
    }
  }

  const copyBranch = async (): Promise<void> => {
    if (!session?.branch_name) return
    try {
      await navigator.clipboard.writeText(session.branch_name)
      setBranchCopied(true)
      setTimeout(() => setBranchCopied(false), 1600)
    } catch {
      setAnnouncement("Could not copy the branch name.")
    }
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <div className="hidden min-w-0 items-center gap-1.5 lg:flex">
          <GitBranch
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="max-w-52 truncate text-xs text-muted-foreground">
            {session?.branch_name ?? state.repository.deploy_branch}
          </span>
          {session && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-full"
              onClick={() => void copyBranch()}
              aria-label="Copy Git branch name"
            >
              {branchCopied ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          )}
        </div>

        {state.behind_deployment && (
          <Badge variant="outline" className="gap-1 border-amber-500/40">
            <AlertTriangle className="size-3" aria-hidden="true" />
            GitHub changed
          </Badge>
        )}

        {session?.pr_url ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full"
            render={
              <a
                href={session.pr_url}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <GitPullRequest className="size-3.5" />
            PR #{session.pr_number}
            <ExternalLink className="size-3" />
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-8 rounded-full"
            disabled={
              disabled ||
              busy !== "idle" ||
              (!session && !hasUnsavedChanges)
            }
            onClick={() => beginPublish("pr")}
          >
            {busy === "publishing" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <GitPullRequest className="size-3.5" />
            )}
            Publish
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                aria-label="More GitHub draft actions"
                disabled={disabled || busy !== "idle"}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              disabled={!session}
              onClick={() => beginPublish("commit")}
            >
              <GitCommitHorizontal className="size-3.5" />
              Save commit in branch
            </DropdownMenuItem>
            <DropdownMenuItem
              render={
                <a
                  href={state.repository.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              <ExternalLink className="size-3.5" />
              Open file on GitHub
            </DropdownMenuItem>
            {session?.status === "conflict" && (
              <DropdownMenuItem
                onClick={() => setConflictDialogOpen(true)}
              >
                <RotateCcw className="size-3.5" />
                Review conflict
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={!session || Boolean(session.pr_url)}
              variant="destructive"
              onClick={() => setDiscardDialogOpen(true)}
            >
              <Trash2 className="size-3.5" />
              Discard shared draft
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {publishMode === "pr"
                ? "Publish for review"
                : "Save a branch commit"}
            </DialogTitle>
            <DialogDescription>
              {publishMode === "pr"
                ? `Commit the shared draft to ${session?.branch_name ?? "a feature branch"} and open a pull request into ${state.repository.deploy_branch}.`
                : `Commit the shared draft to ${session?.branch_name ?? "the feature branch"} without opening a pull request.`}
              {hasUnsavedChanges
                ? " Your unsaved editor changes will be saved to the shared draft first."
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {session && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
                  <span>Current GitHub file</span>
                  <span>Breezify draft</span>
                </div>
                <TextDiffViewer
                  previousText={state.repository_content}
                  nextText={session.draft_content}
                  emptyMessage="The Breezify draft already matches GitHub."
                  className="max-h-[38vh] overflow-auto shadow-none"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="github-commit-message">Commit message</Label>
              <Input
                id="github-commit-message"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                maxLength={200}
                autoComplete="off"
              />
            </div>
            {publishMode === "pr" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="github-pr-title">Pull request title</Label>
                  <Input
                    id="github-pr-title"
                    value={pullRequestTitle}
                    onChange={(event) =>
                      setPullRequestTitle(event.target.value)
                    }
                    maxLength={240}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="github-pr-body">
                    Pull request description
                  </Label>
                  <Textarea
                    id="github-pr-body"
                    value={pullRequestBody}
                    onChange={(event) =>
                      setPullRequestBody(event.target.value)
                    }
                    rows={5}
                    maxLength={20_000}
                  />
                </div>
              </>
            )}
            {announcement && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              >
                {announcement}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={busy === "publishing"}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void publish()}
              disabled={
                busy === "publishing" ||
                commitMessage.trim().length === 0 ||
                (publishMode === "pr" &&
                  pullRequestTitle.trim().length === 0)
              }
            >
              {busy === "publishing" && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              {publishMode === "pr"
                ? "Create pull request"
                : "Commit to branch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={discardDialogOpen}
        onOpenChange={setDiscardDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard the shared draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the unpublished Breezify draft. The deployment branch
              and any commits already saved to GitHub will not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "discarding"}>
              Keep draft
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "discarding"}
              onClick={(event) => {
                event.preventDefault()
                void discard()
              }}
            >
              {busy === "discarding" && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Discard draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={conflictDialogOpen}
        onOpenChange={setConflictDialogOpen}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Review conflicting changes</DialogTitle>
            <DialogDescription>
              GitHub and the shared Breezify draft changed overlapping lines.
              Compare both versions, then choose which complete file should be
              the starting point. This choice does not write to GitHub.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
              <span>GitHub deployment version</span>
              <span>Breezify shared draft</span>
            </div>
            <TextDiffViewer
              previousText={state.repository_content}
              nextText={session?.draft_content ?? ""}
              emptyMessage="The two versions now match."
              className="max-h-[45vh] overflow-auto shadow-none"
            />
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={() => setConflictDialogOpen(false)}
              disabled={busy === "resolving"}
            >
              Continue editing
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => void acceptDeploymentVersion()}
                disabled={busy === "resolving"}
              >
                Use GitHub version
              </Button>
              <Button
                onClick={() => void acceptDraftVersion()}
                disabled={busy === "resolving"}
              >
                {busy === "resolving" && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                Keep Breezify draft
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
