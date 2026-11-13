"use client"

import { useState } from "react"
import {
  useDocument,
  useDocumentVersions,
  useGitHubDocumentHistory,
  useGitHubDocumentState,
  useWorkspace,
} from "@/hooks/swr"
import { cn } from "@/lib/utils"
import {
  History,
  Loader2,
  RotateCcw,
  X,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitCommitHorizontal,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RichContentPreview } from "@/components/app/rich-content-preview"
import { DiffStat, TextDiffViewer } from "@/components/app/text-diff-viewer"
import type { DocumentVersionRow, GitHubFileCommit } from "@breezify/core"

function formatVersionDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function sourceLabel(source: string | null): string {
  switch (source) {
    case "manual":
      return "Manual edit"
    case "smart_ingest":
      return "Smart ingest update"
    case "slack":
      return "Slack capture"
    case "restore":
      return "Restore"
    case "github":
      return "GitHub sync"
    default:
      return "Edit"
  }
}

interface VersionHistoryPanelProps {
  documentId: string
  onRestore: () => void
  onClose?: () => void
  className?: string
}

interface GitHubRevision {
  content: string
  blob_sha: string
  html_url: string
}

export function VersionHistoryPanel({
  documentId,
  onRestore,
  onClose,
  className,
}: VersionHistoryPanelProps): React.ReactElement {
  const { data: document } = useDocument(documentId)
  const { data: workspace } = useWorkspace()
  const { data, isLoading, mutate } = useDocumentVersions(documentId)
  const isGitHubDocument =
    document?.source === "GitHub" &&
    document.source_metadata?.kind === "repository_file"
  const canRestore =
    !isGitHubDocument ||
    Boolean(
      workspace &&
        ["owner", "admin", "editor"].includes(workspace.user_role),
    )
  const {
    data: githubState,
    mutate: mutateGitHubState,
  } = useGitHubDocumentState(documentId, {
    enabled: isGitHubDocument,
  })
  const {
    data: githubFirstPage,
    isLoading: githubFirstPageLoading,
    error: githubFirstPageError,
  } = useGitHubDocumentHistory(documentId, 1, {
    enabled: isGitHubDocument,
  })
  const versions = data?.versions ?? []
  const showLoading = isLoading && !data

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailViewByVersion, setDetailViewByVersion] = useState<Record<string, "preview" | "changes">>({})
  const [restoring, setRestoring] = useState<string | null>(null)
  const [confirmVersion, setConfirmVersion] = useState<DocumentVersionRow | null>(null)
  const [olderGitHubCommits, setOlderGitHubCommits] = useState<
    GitHubFileCommit[]
  >([])
  const [githubPage, setGitHubPage] = useState(1)
  const [olderGitHubHasMore, setOlderGitHubHasMore] = useState(false)
  const [olderGitHubLoading, setOlderGitHubLoading] = useState(false)
  const [githubError, setGitHubError] = useState<string | null>(null)
  const [githubRevisions, setGitHubRevisions] = useState<
    Record<string, GitHubRevision>
  >({})
  const [confirmCommit, setConfirmCommit] = useState<GitHubFileCommit | null>(
    null,
  )

  const githubCommits = [
    ...(githubFirstPage?.commits ?? []),
    ...olderGitHubCommits,
  ]
  const githubHasMore =
    githubPage === 1
      ? (githubFirstPage?.has_more ?? false)
      : olderGitHubHasMore
  const githubLoading = githubFirstPageLoading || olderGitHubLoading
  const displayedGitHubError =
    githubError ??
    (githubFirstPageError ? "Could not load GitHub history." : null)

  const loadGitHubPage = async (page: number): Promise<void> => {
    if (!isGitHubDocument || olderGitHubLoading || page <= 1) return
    setOlderGitHubLoading(true)
    setGitHubError(null)
    try {
      const response = await fetch(
        `/api/documents/${documentId}/github/history?page=${page}`,
      )
      if (!response.ok) throw new Error("Could not load GitHub history.")
      const payload = (await response.json()) as {
        commits: GitHubFileCommit[]
        has_more: boolean
        page: number
      }
      setOlderGitHubCommits((current) => [
        ...current,
        ...payload.commits.filter(
          (commit) =>
            !current.some((candidate) => candidate.sha === commit.sha) &&
            !githubFirstPage?.commits.some(
              (candidate) => candidate.sha === commit.sha,
            ),
        ),
      ])
      setGitHubPage(payload.page)
      setOlderGitHubHasMore(payload.has_more)
    } catch (error) {
      setGitHubError(
        error instanceof Error
          ? error.message
          : "Could not load GitHub history.",
      )
    } finally {
      setOlderGitHubLoading(false)
    }
  }

  const loadGitHubRevision = async (commit: GitHubFileCommit): Promise<void> => {
    if (githubRevisions[commit.sha]) return
    setRestoring(`loading:${commit.sha}`)
    try {
      const response = await fetch(
        `/api/documents/${documentId}/github/history/${commit.sha}`,
      )
      if (!response.ok) throw new Error("Could not load this revision.")
      const revision = (await response.json()) as GitHubRevision
      setGitHubRevisions((current) => ({
        ...current,
        [commit.sha]: revision,
      }))
    } catch (error) {
      setGitHubError(
        error instanceof Error
          ? error.message
          : "Could not load this revision.",
      )
    } finally {
      setRestoring(null)
    }
  }

  const expandGitHubCommit = (commit: GitHubFileCommit): void => {
    const id = `github:${commit.sha}`
    const nextExpanded = expandedId === id ? null : id
    setExpandedId(nextExpanded)
    if (nextExpanded) void loadGitHubRevision(commit)
  }

  const restoreGitHubCommit = async (
    commit: GitHubFileCommit,
  ): Promise<void> => {
    setRestoring(commit.sha)
    try {
      const response = await fetch(
        `/api/documents/${documentId}/github/history/${commit.sha}`,
        { method: "POST" },
      )
      if (!response.ok) throw new Error("Could not restore this revision.")
      await mutateGitHubState()
      onRestore()
    } catch (error) {
      setGitHubError(
        error instanceof Error
          ? error.message
          : "Could not restore this revision.",
      )
    } finally {
      setRestoring(null)
    }
  }

  const handleRestore = async (version: DocumentVersionRow): Promise<void> => {
    setRestoring(version.id)
    try {
      const res = await fetch(`/api/documents/${documentId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version_id: version.id }),
      })
      if (!res.ok) throw new Error("Restore failed")
      await mutate()
      onRestore()
    } catch {
      // Silent — the UI will show the button is no longer loading
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className={cn("flex h-full flex-col shadow-none", className)}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Version History</span>
        </div>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close version history"
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isGitHubDocument && (
          <section aria-labelledby="github-history-heading">
            <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2 backdrop-blur">
              <h3
                id="github-history-heading"
                className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"
              >
                <GitCommitHorizontal className="size-3.5" />
                GitHub file history
              </h3>
              {githubState && (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {githubState.repository.deploy_branch} ·{" "}
                  {githubState.repository.file_path}
                </p>
              )}
            </div>

            {githubCommits.map((commit) => {
              const itemId = `github:${commit.sha}`
              const isExpanded = expandedId === itemId
              const revision = githubRevisions[commit.sha]
              const detailView =
                detailViewByVersion[itemId] ?? "changes"
              const currentContent =
                githubState?.session?.draft_content ??
                githubState?.repository_content ??
                ""
              return (
                <div key={commit.sha} className="border-b">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/50"
                    onClick={() => expandGitHubCommit(commit)}
                    aria-expanded={isExpanded}
                    aria-controls={`github-history-${commit.sha}`}
                  >
                    {isExpanded ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      aria-hidden="true"
                      className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold"
                    >
                      {commit.author_name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {commit.message.split("\n")[0]}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="truncate">{commit.author_name}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatVersionDate(commit.authored_at)}</span>
                        <span
                          className="font-mono text-[10px]"
                          title={commit.sha}
                        >
                          {commit.sha.slice(0, 7)}
                        </span>
                      </div>
                    </div>
                  </button>

                  {isExpanded && (
                    <div
                      id={`github-history-${commit.sha}`}
                      className="space-y-2 px-4 pb-3"
                    >
                      <div className="flex rounded-md border border-border p-0.5">
                        <button
                          type="button"
                          onClick={() =>
                            setDetailViewByVersion((current) => ({
                              ...current,
                              [itemId]: "changes",
                            }))
                          }
                          className={cn(
                            "flex-1 rounded-sm px-3 py-1 text-[11px] font-medium transition-colors",
                            detailView === "changes"
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          aria-pressed={detailView === "changes"}
                        >
                          Changes
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDetailViewByVersion((current) => ({
                              ...current,
                              [itemId]: "preview",
                            }))
                          }
                          className={cn(
                            "flex-1 rounded-sm px-3 py-1 text-[11px] font-medium transition-colors",
                            detailView === "preview"
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          aria-pressed={detailView === "preview"}
                        >
                          Preview
                        </button>
                      </div>

                      {!revision ? (
                        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          Loading revision…
                        </div>
                      ) : detailView === "preview" ? (
                        <RichContentPreview
                          content={revision.content}
                          className="shadow-none"
                        />
                      ) : (
                        <TextDiffViewer
                          previousText={revision.content}
                          nextText={currentContent}
                          emptyMessage="No changes from this GitHub revision."
                          className="shadow-none"
                        />
                      )}

                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 gap-1.5"
                          disabled={
                            !canRestore ||
                            !revision ||
                            restoring === commit.sha
                          }
                          title={
                            canRestore
                              ? "Restore this commit to the shared draft"
                              : "Editor access is required to restore a commit"
                          }
                          onClick={() => setConfirmCommit(commit)}
                        >
                          {restoring === commit.sha ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="size-3.5" />
                          )}
                          Restore to draft
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          render={
                            <a
                              href={commit.html_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            />
                          }
                          aria-label={`Open commit ${commit.sha.slice(0, 7)} on GitHub`}
                        >
                          <ExternalLink className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {displayedGitHubError && (
              <p role="alert" className="px-4 py-3 text-xs text-red-600">
                {displayedGitHubError}
              </p>
            )}
            {!githubLoading &&
              !displayedGitHubError &&
              githubCommits.length === 0 && (
                <p className="border-b px-4 py-3 text-xs text-muted-foreground">
                  No GitHub commits have touched this file yet.
                </p>
              )}
            {(githubLoading || githubHasMore) && (
              <div className="border-b p-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={githubLoading}
                  onClick={() => void loadGitHubPage(githubPage + 1)}
                >
                  {githubLoading && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  {githubLoading ? "Loading history…" : "Load older commits"}
                </Button>
              </div>
            )}
          </section>
        )}

        {isGitHubDocument && (
          <div className="border-b bg-muted/20 px-4 py-2">
            <h3 className="text-xs font-semibold text-muted-foreground">
              Breezify snapshots
            </h3>
          </div>
        )}

        {showLoading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading versions…
          </div>
        )}

        {!showLoading && versions.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            No previous versions yet.
          </p>
        )}

        {versions.map((version, index) => {
          const isExpanded = expandedId === version.id
          const detailView = detailViewByVersion[version.id] ?? "preview"
          // A version row snapshots the content as it was BEFORE an edit (see
          // the POST in api/documents/[id]), so what that edit actually changed
          // is this row against the state that replaced it — the next NEWER
          // row, or the live document for the most recent one. Diffing every
          // row against the current document instead (which this panel used to
          // do) shows the cumulative drift since that point, not the edit.
          const successorContent =
            index === 0 ? (document?.content ?? "") : (versions[index - 1]?.content ?? "")
          return (
            <div
              key={version.id}
              className="border-b last:border-b-0"
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/50 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : version.id)}
                aria-expanded={isExpanded}
                aria-controls={`breezify-history-${version.id}`}
              >
                {isExpanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{version.title}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    <span>{formatVersionDate(version.created_at)}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span>{sourceLabel(version.source)}</span>
                  </div>
                </div>
              </button>

              {isExpanded && (
                <div
                  id={`breezify-history-${version.id}`}
                  className="px-4 pb-3 space-y-2"
                >
                  <div className="flex rounded-md border border-border p-0.5">
                    <button
                      type="button"
                      onClick={() =>
                        setDetailViewByVersion((current) => ({
                          ...current,
                          [version.id]: "preview",
                        }))
                      }
                      className={cn(
                        "flex-1 rounded-sm px-3 py-1 text-[11px] font-medium transition-colors",
                        detailView === "preview"
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      aria-pressed={detailView === "preview"}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDetailViewByVersion((current) => ({
                          ...current,
                          [version.id]: "changes",
                        }))
                      }
                      className={cn(
                        "flex-1 rounded-sm px-3 py-1 text-[11px] font-medium transition-colors",
                        detailView === "changes"
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      aria-pressed={detailView === "changes"}
                    >
                      Changes
                    </button>
                  </div>
                  {detailView === "preview" ? (
                    <RichContentPreview content={version.content} className="shadow-none" />
                  ) : (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-medium text-muted-foreground">
                          {index === 0
                            ? "Changes since this snapshot"
                            : "Changes made by this edit"}
                        </p>
                        <DiffStat
                          previousText={version.content}
                          nextText={successorContent}
                        />
                      </div>
                      <TextDiffViewer
                        previousText={version.content}
                        nextText={successorContent}
                        emptyMessage="Nothing changed in this edit."
                        className="shadow-none"
                      />
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-1.5"
                    disabled={!canRestore || restoring === version.id}
                    title={
                      canRestore
                        ? undefined
                        : "Editor access is required to restore a snapshot"
                    }
                    onClick={() => setConfirmVersion(version)}
                  >
                    {restoring === version.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3.5" />
                    )}
                    {version.source === "smart_ingest" ? "Apply this update" : "Revert to this version"}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <Dialog open={!!confirmVersion} onOpenChange={(open) => { if (!open) setConfirmVersion(null) }}>
        <DialogContent className="shadow-none">
          <DialogHeader>
            <DialogTitle>
              {confirmVersion?.source === "smart_ingest" ? "Apply this update?" : "Revert to this version?"}
            </DialogTitle>
            <DialogDescription>
              This will overwrite the current document content with the version from{" "}
              <span className="font-medium text-foreground">
                {confirmVersion ? formatVersionDate(confirmVersion.created_at) : ""}
              </span>
              . The current content is preserved as a new snapshot, so the
              complete timeline remains available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmVersion(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={restoring !== null}
              onClick={async () => {
                if (!confirmVersion) return
                await handleRestore(confirmVersion)
                setConfirmVersion(null)
              }}
            >
              {restoring ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Reverting…
                </>
              ) : (
                confirmVersion?.source === "smart_ingest" ? "Apply update" : "Revert"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!confirmCommit}
        onOpenChange={(open) => {
          if (!open) setConfirmCommit(null)
        }}
      >
        <DialogContent className="shadow-none">
          <DialogHeader>
            <DialogTitle>Restore this GitHub revision?</DialogTitle>
            <DialogDescription>
              The file from commit{" "}
              <span className="font-mono text-foreground">
                {confirmCommit?.sha.slice(0, 7)}
              </span>{" "}
              will become the current shared draft. GitHub history will not be
              rewritten; publishing creates a new commit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmCommit(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={restoring !== null}
              onClick={async () => {
                if (!confirmCommit) return
                await restoreGitHubCommit(confirmCommit)
                setConfirmCommit(null)
              }}
            >
              {restoring ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Restoring…
                </>
              ) : (
                "Restore to draft"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
