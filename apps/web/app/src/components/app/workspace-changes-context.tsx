"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { usePathname } from "next/navigation"
import useSWR, { useSWRConfig } from "swr"
import {
  isGithubHostedDocsPublishStatusKey,
  useGithubHostedDocs,
  useGithubHostedDocsPublishStatus,
  useWorkspace,
} from "@/hooks/swr"
import {
  getWorkspaceDocumentSaveRevision,
  notifyWorkspaceDocumentSaved,
  subscribeToWorkspaceDocumentSaves,
} from "@/lib/workspace-publish-events"

export type PublishDiffFileStatus = "added" | "modified" | "removed"

export interface PublishDiffFile {
  path: string
  status: PublishDiffFileStatus
  previous: string
  next: string
  bodyOmitted?: boolean
  previousBlobSha?: string
}

export interface PublishDiffResponse {
  files: PublishDiffFile[]
  changed_file_count: number
  truncated: boolean
  compared_commit_sha: string | null
}

interface PullRequestSummary {
  number: number | null
  url: string
}

type WorkspaceChangesMutation = "commit" | "revert" | null

interface WorkspaceChangesContextValue {
  /** The file whose diff the Changes page shows; falls back to the first. */
  activeFile: PublishDiffFile | undefined
  changedFileCount: number
  checkingGitHub: boolean
  conflictCount: number
  data: PublishDiffResponse | undefined
  error: unknown
  files: PublishDiffFile[]
  loading: boolean
  mutation: WorkspaceChangesMutation
  mutationError: string | null
  pullRequest: PullRequestSummary | null
  selectedCanRevert: boolean
  selectedCount: number
  selectedPaths: ReadonlySet<string>
  allSelected: boolean
  unavailableReason: string | null
  clearMutationError: () => void
  commitSelected: () => Promise<boolean>
  refreshDiff: () => Promise<PublishDiffResponse | undefined>
  revertSelected: () => Promise<boolean>
  setActivePath: (path: string) => void
  setAllSelected: (selected: boolean) => void
  toggleSelectedPath: (path: string) => void
}

const PUBLISH_ROLES = new Set(["owner", "admin", "editor"])

const WorkspaceChangesContext =
  createContext<WorkspaceChangesContextValue | null>(null)

async function fetchPublishDiff(url: string): Promise<PublishDiffResponse> {
  const response = await fetch(url)
  const payload = (await response.json()) as
    | PublishDiffResponse
    | { error?: string }
  if (!response.ok) {
    throw new Error(
      ("error" in payload && payload.error) ||
        "Could not load the workspace diff.",
    )
  }
  return payload as PublishDiffResponse
}

async function responseFailure(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null
  return payload?.error ?? `The GitHub action failed (${response.status}).`
}

/**
 * Keeps the expensive GitHub comparison and its staged-file set alive while
 * the user switches between Documents and Changes. The diff starts warming as
 * soon as the lightweight publish status confirms that changes exist.
 */
export function WorkspaceChangesProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  const pathname = usePathname()
  const enabled =
    pathname === "/knowledge" || pathname.startsWith("/knowledge/")
  const { data: workspace } = useWorkspace()
  const {
    data: hostedDocs,
    error: hostedDocsError,
    isLoading: hostedDocsLoading,
  } = useGithubHostedDocs({ enabled })
  const source = hostedDocs?.source ?? null
  const canPublish = Boolean(
    workspace && PUBLISH_ROLES.has(workspace.user_role),
  )
  const sourceReady = source?.sync_status === "synced"
  const {
    data: publishStatus,
    error: publishStatusError,
    isLoading: publishStatusLoading,
    mutate: mutatePublishStatus,
  } = useGithubHostedDocsPublishStatus(source, {
    enabled: enabled && canPublish,
  })
  const { mutate: globalMutate } = useSWRConfig()
  const [settledSaveRevision, setSettledSaveRevision] = useState(
    getWorkspaceDocumentSaveRevision,
  )
  const [comparisonGeneration, setComparisonGeneration] = useState(0)
  const [checkingSavedChange, setCheckingSavedChange] = useState(false)
  const latestSaveRevision = useRef(settledSaveRevision)
  const [selection, setSelection] = useState<{
    key: string
    excludedPaths: Set<string>
  }>(() => ({ key: "", excludedPaths: new Set() }))
  const [activePath, setActivePath] = useState<string | null>(null)
  const [mutation, setMutation] = useState<WorkspaceChangesMutation>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [createdPullRequest, setCreatedPullRequest] =
    useState<PullRequestSummary | null>(null)

  useEffect(() => {
    latestSaveRevision.current = getWorkspaceDocumentSaveRevision()
    setSettledSaveRevision(latestSaveRevision.current)
    setCheckingSavedChange(false)
    setCreatedPullRequest(null)
  }, [source?.id])

  useEffect(() => {
    if (!enabled || !canPublish || !sourceReady) return

    let active = true
    const unsubscribe = subscribeToWorkspaceDocumentSaves((detail) => {
      latestSaveRevision.current = detail.revision
      setCheckingSavedChange(true)
      void mutatePublishStatus()
        .catch(() => undefined)
        .finally(() => {
          if (!active || latestSaveRevision.current !== detail.revision) return
          setSettledSaveRevision(detail.revision)
          setCheckingSavedChange(false)
        })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [canPublish, enabled, mutatePublishStatus, sourceReady])

  const exactChanges =
    enabled &&
    canPublish &&
    sourceReady &&
    publishStatus?.status === "changes"
  const diffBasis = exactChanges
    ? JSON.stringify([
        source.id,
        source.last_sync_commit_sha,
        source.publish_last_commit_sha,
        publishStatus.comparison_key ??
          [
            publishStatus.compared_commit_sha,
            publishStatus.changed_file_count,
            settledSaveRevision,
          ].join(":"),
        comparisonGeneration,
      ])
    : null
  const diffKey =
    diffBasis && !checkingSavedChange
      ? `/api/github/hosted-docs/publish/diff?basis=${encodeURIComponent(diffBasis)}`
      : null
  const {
    data,
    error,
    isLoading: diffLoading,
    mutate: mutateDiff,
  } = useSWR<PublishDiffResponse>(diffKey, fetchPublishDiff, {
    dedupingInterval: 300_000,
    keepPreviousData: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
  })

  const files = data?.files ?? []
  const selectionKey = data
    ? `${source?.id ?? ""}:${data.compared_commit_sha ?? ""}:${data.files
        .map((file) => file.path)
        .join("\n")}`
    : ""
  const excludedPaths = useMemo(
    () =>
      selection.key === selectionKey
        ? selection.excludedPaths
        : new Set<string>(),
    [selection, selectionKey],
  )
  const selectedPaths = useMemo(
    () =>
      new Set(
        files
          .filter((file) => !excludedPaths.has(file.path))
          .map((file) => file.path),
      ),
    [excludedPaths, files],
  )
  const selectedFiles = useMemo(
    () => files.filter((file) => selectedPaths.has(file.path)),
    [files, selectedPaths],
  )
  const selectedCount = selectedFiles.length
  const activeFile =
    files.find((file) => file.path === activePath) ?? files[0]
  const allSelected =
    files.length > 0 && files.every((file) => selectedPaths.has(file.path))
  const selectedCanRevert =
    selectedFiles.length > 0 &&
    selectedFiles.every((file) =>
      file.status === "added"
        ? !file.path.endsWith("/.gitkeep")
        : !file.bodyOmitted && Boolean(file.previousBlobSha),
    )

  const waitingForStatus = Boolean(
    enabled &&
      workspace &&
      canPublish &&
      sourceReady &&
      !publishStatus &&
      !publishStatusError,
  )
  const checkingGitHub = Boolean(
    checkingSavedChange || publishStatusLoading || waitingForStatus,
  )
  const loading = Boolean(
    enabled &&
      (!workspace ||
        (hostedDocsLoading && !hostedDocs) ||
        checkingGitHub ||
        (exactChanges && !data && !error && diffLoading)),
  )

  const unavailableReason = !enabled || loading
    ? null
    : !workspace
      ? null
      : !canPublish
        ? "Only workspace editors, admins, and owners can review workspace changes."
        : hostedDocsError
          ? "Bread could not load the GitHub publishing setup."
          : !source
            ? "GitHub publishing is not configured for this workspace."
            : !sourceReady
              ? source.sync_status === "disabled"
                ? "Finish the GitHub activation pull request before reviewing changes."
                : source.sync_status === "error"
                  ? source.last_sync_error ??
                    "Resolve the hosted docs sync error before reviewing changes."
                  : "Hosted documents are still syncing."
              : publishStatusError
                ? "Bread could not compare the workspace with GitHub."
                : publishStatus && publishStatus.status !== "changes"
                  ? publishStatus.message ??
                    (publishStatus.status === "sync_required"
                      ? "GitHub has changes Bread has not pulled in yet. Sync the docs root, then review again."
                      : publishStatus.status === "up_to_date"
                        ? "Nothing has changed since the last publish."
                        : "Bread cannot compare the workspace with GitHub right now.")
                  : null

  const toggleSelectedPath = useCallback(
    (path: string): void => {
      setSelection((current) => {
        const next = new Set(
          current.key === selectionKey ? current.excludedPaths : [],
        )
        if (selectedPaths.has(path)) next.add(path)
        else next.delete(path)
        return { key: selectionKey, excludedPaths: next }
      })
    },
    [selectedPaths, selectionKey],
  )

  const setAllSelected = useCallback(
    (selected: boolean): void => {
      setSelection({
        key: selectionKey,
        excludedPaths: selected
          ? new Set()
          : new Set(files.map((file) => file.path)),
      })
    },
    [files, selectionKey],
  )

  const commitSelected = useCallback(async (): Promise<boolean> => {
    const paths = [...selectedPaths]
    if (paths.length === 0 || mutation) return false

    setMutation("commit")
    setMutationError(null)
    try {
      const response = await fetch("/api/github/hosted-docs/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paths,
          ...(source && source.conflict_count > 0
            ? { conflict_resolution: "bread" }
            : {}),
        }),
      })
      if (!response.ok) throw new Error(await responseFailure(response))
      const result = (await response.json()) as {
        pull_request_number: number
        pull_request_url: string
      }
      setCreatedPullRequest({
        number: result.pull_request_number,
        url: result.pull_request_url,
      })
      setCheckingSavedChange(true)
      await Promise.all([
        globalMutate("/api/github/hosted-docs?summary=1"),
        globalMutate(isGithubHostedDocsPublishStatusKey),
      ])
      setComparisonGeneration((current) => current + 1)
      setCheckingSavedChange(false)
      return true
    } catch (actionError) {
      setMutationError(
        actionError instanceof Error
          ? actionError.message
          : "Could not commit the staged changes.",
      )
      setCheckingSavedChange(false)
      return false
    } finally {
      setMutation(null)
    }
  }, [globalMutate, mutation, selectedPaths, source])

  const revertSelected = useCallback(async (): Promise<boolean> => {
    const paths = [...selectedPaths]
    if (paths.length === 0 || mutation) return false

    setMutation("revert")
    setMutationError(null)
    try {
      const response = await fetch(
        "/api/github/hosted-docs/publish/revert",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths }),
        },
      )
      if (!response.ok) throw new Error(await responseFailure(response))
      const result = (await response.json()) as {
        reverted_document_ids: string[]
      }
      notifyWorkspaceDocumentSaved({
        documentId: result.reverted_document_ids[0] ?? "workspace-revert",
        savedAt: new Date().toISOString(),
      })
      await Promise.all([
        globalMutate("/api/documents"),
        ...result.reverted_document_ids.map((id) =>
          globalMutate(`/api/documents/${id}`),
        ),
      ])
      return true
    } catch (actionError) {
      setMutationError(
        actionError instanceof Error
          ? actionError.message
          : "Could not revert the staged changes.",
      )
      return false
    } finally {
      setMutation(null)
    }
  }, [globalMutate, mutation, selectedPaths])

  const pullRequest = createdPullRequest ??
    (source?.publish_pull_request_url
      ? {
          number: source.publish_pull_request_number,
          url: source.publish_pull_request_url,
        }
      : null)

  const value = useMemo<WorkspaceChangesContextValue>(
    () => ({
      activeFile,
      changedFileCount:
        exactChanges && publishStatus
          ? publishStatus.changed_file_count
          : 0,
      checkingGitHub,
      conflictCount: source?.conflict_count ?? 0,
      data,
      error,
      files,
      loading,
      mutation,
      mutationError,
      pullRequest,
      selectedCanRevert,
      selectedCount,
      selectedPaths,
      allSelected,
      unavailableReason,
      clearMutationError: () => setMutationError(null),
      commitSelected,
      refreshDiff: async () => mutateDiff(),
      revertSelected,
      setActivePath,
      setAllSelected,
      toggleSelectedPath,
    }),
    [
      activeFile,
      allSelected,
      checkingGitHub,
      commitSelected,
      data,
      error,
      exactChanges,
      files,
      loading,
      mutation,
      mutationError,
      mutateDiff,
      publishStatus,
      pullRequest,
      revertSelected,
      selectedCanRevert,
      selectedCount,
      selectedPaths,
      setAllSelected,
      source?.conflict_count,
      toggleSelectedPath,
      unavailableReason,
    ],
  )

  return (
    <WorkspaceChangesContext.Provider value={value}>
      {children}
    </WorkspaceChangesContext.Provider>
  )
}

export function useWorkspaceChanges(): WorkspaceChangesContextValue {
  const context = useContext(WorkspaceChangesContext)
  if (!context) {
    throw new Error(
      "useWorkspaceChanges must be used within a WorkspaceChangesProvider",
    )
  }
  return context
}
