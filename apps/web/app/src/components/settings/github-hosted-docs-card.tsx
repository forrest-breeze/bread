"use client"

import React, { useMemo, useState } from "react"
import useSWR from "swr"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  GitMerge,
  RefreshCw,
  Search,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { LoadingBar } from "@/components/ui/loading-bar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useGithubHostedDocs } from "@/hooks/swr"
import {
  bootstrapGithubHostedDocsSource,
  disableGithubHostedDocsSource,
  saveGithubHostedDocsSource,
} from "@/lib/github/api/github-integrations"
import type {
  GitHubAvailableRepo,
  GitHubHostedDocsTree,
} from "@/lib/github/types"
import { cn } from "@/lib/utils"

interface FolderNode {
  path: string
  name: string
  children: FolderNode[]
}

type ReconciliationMode = "merge" | "breezify_wins" | "github_wins"
type ProposalKind = "create" | "breezify_wins"
type HostedDocsAction = "link" | "create" | "open_pr" | "disable"

export function expandedPathsForSelection(paths: string[]): Set<string> {
  const expanded = new Set<string>()
  for (const path of paths) {
    const parts = path.split("/")
    for (let index = 1; index < parts.length; index++) {
      expanded.add(parts.slice(0, index).join("/"))
    }
  }
  return expanded
}

export function buildHostedDocsFolderTree(paths: string[]): FolderNode[] {
  const roots: FolderNode[] = []
  const byPath = new Map<string, FolderNode>()
  for (const path of paths) {
    const parts = path.split("/")
    for (let index = 0; index < parts.length; index++) {
      const currentPath = parts.slice(0, index + 1).join("/")
      if (byPath.has(currentPath)) continue
      const node: FolderNode = {
        path: currentPath,
        name: parts[index]!,
        children: [],
      }
      byPath.set(currentPath, node)
      if (index === 0) roots.push(node)
      else byPath.get(parts.slice(0, index).join("/"))?.children.push(node)
    }
  }
  const sort = (nodes: FolderNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    nodes.forEach((node) => sort(node.children))
  }
  sort(roots)
  return roots
}

async function fetchTree(url: string): Promise<GitHubHostedDocsTree> {
  const response = await fetch(url)
  const body = (await response.json().catch(() => ({}))) as
    | GitHubHostedDocsTree
    | { error?: string }
  if (!response.ok) {
    throw new Error(
      (body as { error?: string }).error ?? "Could not load repository folders.",
    )
  }
  return body as GitHubHostedDocsTree
}

function FolderRow({
  node,
  depth,
  selectedPath,
  expanded,
  onToggleExpand,
  onSelectPath,
}: {
  node: FolderNode
  depth: number
  selectedPath: string | null
  expanded: ReadonlySet<string>
  onToggleExpand: (path: string) => void
  onSelectPath: (path: string) => void
}): React.JSX.Element {
  const open = expanded.has(node.path)
  const checked = selectedPath === node.path
  return (
    <>
      <div
        className="flex min-w-0 items-center gap-1 rounded-md py-1 pr-2 hover:bg-muted/50"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <button
          type="button"
          aria-label={open ? `Collapse ${node.path}` : `Expand ${node.path}`}
          disabled={node.children.length === 0}
          onClick={() => onToggleExpand(node.path)}
          className="flex size-6 shrink-0 items-center justify-center text-muted-foreground disabled:opacity-0"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={checked}
          onClick={() => onSelectPath(node.path)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
        >
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-full border",
              checked
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border",
            )}
          >
            {checked ? <CheckCircle2 className="size-3" /> : null}
          </span>
          {open ? (
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {open
        ? node.children.map((child) => (
            <FolderRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onSelectPath={onSelectPath}
            />
          ))
        : null}
    </>
  )
}

const RECONCILIATION_OPTIONS: Array<{
  value: ReconciliationMode
  title: string
  description: string
}> = [
  {
    value: "merge",
    title: "Merge both",
    description:
      "Validate the root, then bring in GitHub documents while preserving differing Breezify edits for review. Folders follow the repository tree under the root; documents keep their Breezify placement.",
  },
  {
    value: "breezify_wins",
    title: "Use Breezify",
    description:
      "Open a pull request that makes the GitHub root’s Markdown tree match Breezify.",
  },
  {
    value: "github_wins",
    title: "Use GitHub",
    description:
      "Validate the root, then make Breezify match GitHub: documents take the repository's content and folder layout, and Breezify documents under the root that are not in GitHub are removed.",
  },
]

export function GithubHostedDocsCard({
  repositories,
  repositoriesLoading = false,
}: {
  repositories: GitHubAvailableRepo[]
  repositoriesLoading?: boolean
}): React.JSX.Element {
  const {
    data,
    error: sourceError,
    isLoading: sourceLoading,
    mutate,
  } = useGithubHostedDocs()
  const source = data?.source ?? null
  const currentRoot = source?.paths[0] ?? null
  const repoOptions = useMemo(() => {
    if (!source || repositories.some((repo) => repo.id === source.repo_id)) {
      return repositories
    }
    return [
      ...repositories,
      {
        id: source.repo_id,
        name: source.repo_full_name.split("/").at(-1) ?? source.repo_full_name,
        full_name: source.repo_full_name,
        private: false,
      },
    ]
  }, [repositories, source])

  const sourceKey = source ? `${source.repo_id}:${currentRoot ?? ""}` : "none"
  const [appliedSourceKey, setAppliedSourceKey] = useState("")
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null)
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [reconciliation, setReconciliation] =
    useState<ReconciliationMode>("merge")
  if (!sourceLoading && sourceKey !== appliedSourceKey) {
    setAppliedSourceKey(sourceKey)
    setSelectedRepoId(source?.repo_id ?? repoOptions[0]?.id ?? null)
    setSelectedRoot(currentRoot)
    setExpanded(expandedPathsForSelection(currentRoot ? [currentRoot] : []))
    setReconciliation("merge")
  }

  const effectiveRepoId = selectedRepoId ?? source?.repo_id ?? repoOptions[0]?.id ?? null
  const effectiveRepo = repoOptions.find((repo) => repo.id === effectiveRepoId) ?? null
  const {
    data: tree,
    error: treeError,
    isLoading: treeLoading,
    mutate: mutateTree,
  } = useSWR<GitHubHostedDocsTree>(
    !source && effectiveRepoId
      ? `/api/github/hosted-docs/tree?repo_id=${effectiveRepoId}`
      : null,
    fetchTree,
    { dedupingInterval: 60_000 },
  )

  const [query, setQuery] = useState("")
  const [newRootPath, setNewRootPath] = useState("docs")
  const [pendingAction, setPendingAction] = useState<HostedDocsAction | null>(null)
  const [proposalKind, setProposalKind] = useState<ProposalKind | null>(null)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [pullRequestUrl, setPullRequestUrl] = useState<string | null>(null)

  const folderTree = useMemo(
    () => buildHostedDocsFolderTree(tree?.folders ?? []),
    [tree?.folders],
  )
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return (tree?.folders ?? [])
      .filter((path) => path.toLowerCase().includes(normalized))
      .slice(0, 100)
  }, [query, tree?.folders])
  const status = source?.sync_status
  const syncing = status === "syncing" || status === "pending"
  const busy = pendingAction !== null
  const statusLabel =
    status === "disabled"
      ? "Waiting for PR merge"
      : syncing
        ? "Syncing root"
        : status === "synced"
          ? `${source?.document_count ?? 0} docs linked`
          : status === "error"
            ? "Needs attention"
            : null

  const chooseRoot = (path: string): void => {
    setSelectedRoot(path)
    setMessage("")
    setError("")
  }

  const runExistingRootSetup = async (): Promise<void> => {
    if (!effectiveRepoId || !selectedRoot) return
    if (reconciliation === "breezify_wins") {
      setProposalKind("breezify_wins")
      return
    }
    setPendingAction("link")
    setError("")
    setMessage("")
    setPullRequestUrl(null)
    try {
      const result = await saveGithubHostedDocsSource({
        repoId: effectiveRepoId,
        rootPath: selectedRoot,
        mode: reconciliation,
      })
      if (result.error) {
        setError(result.error)
      } else {
        setAppliedSourceKey("")
        setMessage(
          "GitHub root linked. Breezify is syncing its documents now.",
        )
        await mutate()
      }
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setPendingAction(null)
    }
  }

  const proposeFromBreezify = async (kind: ProposalKind): Promise<void> => {
    if (!effectiveRepoId) return
    const targetPath = kind === "create" ? newRootPath.trim() : selectedRoot
    if (!targetPath) return
    setPendingAction(kind === "create" ? "create" : "open_pr")
    setError("")
    setMessage("")
    setPullRequestUrl(null)
    try {
      const result = await bootstrapGithubHostedDocsSource({
        repoId: effectiveRepoId,
        targetPath,
        allowExisting: kind === "breezify_wins",
      })
      if (result.error) {
        setError(result.error)
      } else {
        setProposalKind(null)
        setSelectedRoot(targetPath)
        setAppliedSourceKey("")
        setPullRequestUrl(result.pullRequestUrl ?? null)
        setMessage(
          kind === "create"
            ? "Pull request opened. Merging it creates the root and activates the link."
            : "Pull request opened to make the selected Markdown tree match Breezify.",
        )
        await Promise.all([mutate(), mutateTree()])
      }
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setPendingAction(null)
    }
  }

  const disable = async (): Promise<void> => {
    setPendingAction("disable")
    setError("")
    try {
      const result = await disableGithubHostedDocsSource()
      if (result.error) {
        setError(result.error)
      } else {
        setAppliedSourceKey("")
        setSelectedRoot(null)
        setMessage("GitHub root link disabled. Existing Breezify documents were preserved.")
        await mutate()
      }
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>GitHub docs root</CardTitle>
            <CardDescription>
              Link one repository folder as the root for the Breezify folder tree.
              This does not monitor or index the rest of the repository.
            </CardDescription>
          </div>
          {statusLabel ? (
            <div className="space-y-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                {status === "synced" ? (
                  <CheckCircle2 className="size-3 text-emerald-600" />
                ) : status === "error" ? (
                  <RefreshCw className="size-3" />
                ) : (
                  <GitMerge className="size-3" />
                )}
                {statusLabel}
              </span>
              {syncing ? (
                <LoadingBar label="GitHub docs root sync progress" className="w-full" />
              ) : null}
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {sourceLoading || repositoriesLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : repoOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The GitHub App cannot access any repositories yet. Update its repository
            access on GitHub, then choose one here.
          </p>
        ) : (
          <>
            {source ? (
              <div className="rounded-md border bg-muted/40 px-3 py-2.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Current root
                </p>
                <p className="mt-1 font-mono text-sm font-medium">
                  {source.repo_full_name}/{currentRoot}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {source.sync_status === "disabled"
                    ? "A pull request is open. Root setup is locked until this link is disabled."
                    : syncing
                      ? "Breezify is activating this root now."
                      : source.sync_status === "error"
                        ? "This root needs attention. Disable the link to choose or create a different folder."
                        : "This root is active. Disable the link before choosing or creating a different folder."}
                </p>
                {source.sync_status === "disabled" &&
                source.pending_pull_request_url ? (
                  <a
                    href={source.pending_pull_request_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
                  >
                    View pull request <ExternalLink className="size-3" />
                  </a>
                ) : null}
                {source.conflict_count > 0 ? (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    {source.conflict_count} document conflict
                    {source.conflict_count === 1 ? " needs" : "s need"} review.
                  </p>
                ) : null}
              </div>
            ) : null}

            {!source ? (
              <>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Repository</label>
              <Select
                value={effectiveRepoId ? String(effectiveRepoId) : ""}
                onValueChange={(value) => {
                  setSelectedRepoId(Number(value))
                  setSelectedRoot(null)
                  setExpanded(new Set())
                  setQuery("")
                  setMessage("")
                  setError("")
                }}
              >
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue placeholder="Choose a repository">
                    {effectiveRepo?.full_name ?? "Choose a repository"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {repoOptions.map((repo) => (
                    <SelectItem
                      key={repo.id}
                      value={String(repo.id)}
                      className="font-mono"
                    >
                      {repo.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                  1
                </span>
                <div>
                  <p className="text-sm font-medium">Select an existing folder</p>
                  <p className="text-xs text-muted-foreground">
                    Choose one folder as the root. Everything below it belongs to
                    this link.
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Repository folders
                </p>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search repository folders…"
                    className="pl-9"
                  />
                </div>
                <div
                  role="radiogroup"
                  aria-label="GitHub root folder"
                  className="max-h-64 overflow-y-auto rounded-md border p-1"
                >
                  {treeLoading ? (
                    <div className="space-y-2 px-3 py-8 text-sm text-muted-foreground">
                      <LoadingBar label="Repository folders loading" />
                      <p>Loading folders…</p>
                    </div>
                  ) : treeError ? (
                    <p className="px-3 py-8 text-sm text-destructive">
                      {treeError instanceof Error
                        ? treeError.message
                        : "Could not load folders."}
                    </p>
                  ) : query.trim() ? (
                    matches.length > 0 ? (
                      matches.map((path) => (
                        <button
                          key={path}
                          type="button"
                          role="radio"
                          aria-checked={selectedRoot === path}
                          onClick={() => chooseRoot(path)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                        >
                          <span
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-full border",
                              selectedRoot === path
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border",
                            )}
                          >
                            {selectedRoot === path ? (
                              <CheckCircle2 className="size-3" />
                            ) : null}
                          </span>
                          <Folder className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate font-mono text-xs">{path}</span>
                        </button>
                      ))
                    ) : (
                      <p className="px-3 py-8 text-sm text-muted-foreground">
                        No folders match.
                      </p>
                    )
                  ) : folderTree.length > 0 ? (
                    folderTree.map((node) => (
                      <FolderRow
                        key={node.path}
                        node={node}
                        depth={0}
                        selectedPath={selectedRoot}
                        expanded={expanded}
                        onToggleExpand={(path) =>
                          setExpanded((current) => {
                            const next = new Set(current)
                            if (next.has(path)) next.delete(path)
                            else next.add(path)
                            return next
                          })
                        }
                        onSelectPath={chooseRoot}
                      />
                    ))
                  ) : (
                    <p className="px-3 py-8 text-sm text-muted-foreground">
                      No folders containing Markdown or MDX were found.
                    </p>
                  )}
                </div>
              </div>

              {selectedRoot ? (
                <div className="space-y-3 rounded-lg bg-muted/40 p-3">
                  <div>
                    <p className="text-sm font-medium">Initial reconciliation</p>
                    <p className="text-xs text-muted-foreground">
                      Choose which side wins where the selected root and Breezify differ.
                    </p>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Initial reconciliation"
                    className="grid gap-2 md:grid-cols-3"
                  >
                    {RECONCILIATION_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={reconciliation === option.value}
                        onClick={() => setReconciliation(option.value)}
                        className={cn(
                          "rounded-lg border bg-background p-3 text-left transition-colors",
                          reconciliation === option.value
                            ? "border-primary ring-1 ring-primary"
                            : "hover:bg-muted/50",
                        )}
                      >
                        <span className="text-sm font-medium">{option.title}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <div className="space-y-1.5">
                      <Button
                        size="sm"
                        disabled={busy || syncing || treeLoading || Boolean(treeError)}
                        onClick={() => void runExistingRootSetup()}
                        aria-busy={pendingAction === "link"}
                      >
                        {pendingAction === "link" ? "Linking folder…" : "Link selected folder"}
                      </Button>
                      {pendingAction === "link" ? (
                        <LoadingBar label="Link selected folder progress" />
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-3" aria-label="Or create a folder">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Or
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-semibold">
                  2
                </span>
                <div>
                  <p className="text-sm font-medium">Create a new folder</p>
                  <p className="text-xs text-muted-foreground">
                    Enter its repository path. Breezify will build the workspace tree
                    there on a branch and open a pull request.
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={newRootPath}
                  onChange={(event) => setNewRootPath(event.target.value)}
                  placeholder="docs"
                  className="font-mono"
                  aria-label="New GitHub root path"
                />
                <div className="space-y-1.5">
                  <Button
                    variant="outline"
                    disabled={!effectiveRepoId || !newRootPath.trim() || busy}
                    onClick={() => void proposeFromBreezify("create")}
                    aria-busy={pendingAction === "create"}
                  >
                    {pendingAction === "create" ? "Creating pull request…" : "Create via pull request"}
                  </Button>
                  {pendingAction === "create" ? (
                    <LoadingBar label="Create GitHub docs folder progress" />
                  ) : null}
                </div>
              </div>
            </div>

            {tree?.truncated ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                GitHub truncated this repository tree. Some deep folders may not appear.
              </p>
            ) : null}
              </>
            ) : null}
            {source?.last_sync_error ? (
              <p className="text-sm text-destructive">{source.last_sync_error}</p>
            ) : null}
            {sourceError || error ? (
              <p className="text-sm text-destructive">
                {error || "Could not load the GitHub root link."}
              </p>
            ) : null}
            {message ? (
              <p className="text-sm text-muted-foreground">
                {message}{" "}
                {pullRequestUrl ? (
                  <a
                    href={pullRequestUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                  >
                    View pull request <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </p>
            ) : null}

            {source ? (
              <div className="flex justify-start">
                <div className="space-y-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void disable()}
                    aria-busy={pendingAction === "disable"}
                  >
                    {pendingAction === "disable"
                      ? "Disabling root link…"
                      : "Disable root link"}
                  </Button>
                  {pendingAction === "disable" ? (
                    <LoadingBar label="Disable GitHub docs root progress" />
                  ) : null}
                </div>
              </div>
            ) : null}

            <Dialog
              open={proposalKind !== null}
              onOpenChange={(open) => {
                if (!open && !busy) setProposalKind(null)
              }}
            >
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>
                    Use Breezify versions
                  </DialogTitle>
                  <DialogDescription>
                    Breezify will create a branch and open a pull request. The default
                    branch is not changed until that pull request is merged.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 text-sm">
                  <div className="rounded-md border bg-muted/40 px-3 py-2.5">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Proposed root
                    </p>
                    <p className="mt-1 font-mono text-xs">
                      {effectiveRepo?.full_name}/
                      {selectedRoot}
                    </p>
                  </div>
                  <p className="text-muted-foreground">
                    The pull request makes the selected root’s Markdown and MDX
                    tree match Breezify. Reviewable assets and non-document files
                    remain in place.
                  </p>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setProposalKind(null)}
                  >
                    Cancel
                  </Button>
                  <div className="space-y-1.5">
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (proposalKind) void proposeFromBreezify(proposalKind)
                      }}
                      aria-busy={pendingAction === "open_pr"}
                    >
                      {pendingAction === "open_pr" ? "Opening pull request…" : "Open pull request"}
                    </Button>
                    {pendingAction === "open_pr" ? (
                      <LoadingBar label="Open GitHub pull request progress" />
                    ) : null}
                  </div>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </CardContent>
    </Card>
  )
}
