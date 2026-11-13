"use client"

import React, { Suspense, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { AlertTriangle, CheckCircle2, ExternalLink, GitBranch, RefreshCw } from "lucide-react"
import type { GitHubHostedDocsSourceRow } from "@bread/core"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LoadingBar } from "@/components/ui/loading-bar"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import {
  useAvailableGithubRepos,
  useGithubHostedDocs,
  useGithubIntegration,
  useWorkspace,
} from "@/hooks/swr"
import {
  disableGithubHostedDocsSource,
  initiateGithubInstall,
  saveGithubHostedDocsSource,
} from "@/lib/github/api/github-integrations"

// ---------------------------------------------------------------------------
// Settings -> Integrations -> GitHub.
//
// Two-way sync between this workspace and a GitHub repository, in the layout
// ReadMe's GitHub integration uses (docs/, reference/, _order.yaml, index.md,
// YAML frontmatter). A repository that was synced with ReadMe can be linked
// here as it is.
// ---------------------------------------------------------------------------

type PublishMode = "direct" | "pull_request"

const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: "The GitHub App installation was cancelled.",
  invalid_request: "GitHub returned an incomplete installation response. Try again.",
  invalid_state: "The installation link expired. Start again from this page.",
  server_misconfigured: "The GitHub App is not configured on this deployment.",
  github_api_error: "GitHub could not confirm the installation. Try again.",
  unauthorized: "Sign in as a workspace admin to connect GitHub.",
}

interface SkippedFile {
  path: string
  reason: string
  quiet?: boolean
}

function skippedFiles(source: GitHubHostedDocsSourceRow): SkippedFile[] {
  const skipped = (source.sync_state as { skipped?: unknown } | null | undefined)?.skipped
  if (!Array.isArray(skipped)) return []
  return skipped.filter(
    (entry): entry is SkippedFile =>
      typeof (entry as SkippedFile)?.path === "string" &&
      typeof (entry as SkippedFile)?.reason === "string",
  )
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function PublishModeField({
  value,
  onChange,
  disabled,
}: {
  value: PublishMode
  onChange: (value: PublishMode) => void
  disabled?: boolean
}): React.JSX.Element {
  const options: Array<{ value: PublishMode; title: string; description: string }> = [
    {
      value: "direct",
      title: "Commit directly",
      description:
        "Publishing commits straight to the synced branch, as ReadMe does. A protected branch must let the Bread GitHub App bypass its rules.",
    },
    {
      value: "pull_request",
      title: "Open a pull request",
      description:
        "Publishing collects changes on a Bread branch and opens one pull request. Use this when the branch is protected.",
    },
  ]
  return (
    <div role="radiogroup" aria-label="How Bread publishes to GitHub" className="space-y-2">
      {options.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 has-[:checked]:border-foreground"
        >
          <input
            type="radio"
            name="publish-mode"
            className="mt-1"
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <span>
            <span className="block text-sm font-medium">{option.title}</span>
            <span className="block text-xs text-muted-foreground">{option.description}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

function LinkForm({ onLinked }: { onLinked: () => Promise<unknown> }): React.JSX.Element {
  const { data, isLoading, error: reposError } = useAvailableGithubRepos()
  const repositories = data?.repositories ?? []
  const [repoId, setRepoId] = useState<number | null>(null)
  const [branch, setBranch] = useState("")
  const [rootPath, setRootPath] = useState("")
  const [publishMode, setPublishMode] = useState<PublishMode>("direct")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const selected = repositories.find((repo) => repo.id === repoId) ?? null

  const link = async (): Promise<void> => {
    if (!repoId) return
    setSaving(true)
    setError("")
    try {
      const result = await saveGithubHostedDocsSource({
        repoId,
        rootPath: rootPath.trim(),
        mode: "merge",
        format: "readme",
        publishMode,
        branch: branch.trim() || null,
      })
      if (result.error) setError(result.error)
      else await onLinked()
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) return <Skeleton className="h-40 w-full" />
  if (reposError || repositories.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The GitHub App cannot access any repositories yet. Grant it access to the
        docs repository on GitHub, then reload this page.
      </p>
    )
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="space-y-1.5">
        <Label>Repository</Label>
        <Select
          value={repoId ? String(repoId) : ""}
          onValueChange={(value) => setRepoId(Number(value))}
        >
          <SelectTrigger className="font-mono text-sm">
            <SelectValue placeholder="Choose a repository">
              {selected?.full_name ?? "Choose a repository"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {repositories.map((repo) => (
              <SelectItem key={repo.id} value={String(repo.id)} className="font-mono">
                {repo.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="github-branch">Branch</Label>
          <Input
            id="github-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="Default branch"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            ReadMe keeps one branch per docs version. Leave empty to follow the
            repository&apos;s default branch.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="github-root">Folder</Label>
          <Input
            id="github-root"
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="Repository root"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            The folder that contains <code>docs/</code> and <code>reference/</code>.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Publishing</Label>
        <PublishModeField value={publishMode} onChange={setPublishMode} disabled={saving} />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button onClick={() => void link()} disabled={!repoId || saving}>
        {saving ? "Linking…" : "Link repository"}
      </Button>
    </div>
  )
}

function LinkedSource({
  source,
  canManage,
  refresh,
}: {
  source: GitHubHostedDocsSourceRow
  canManage: boolean
  refresh: () => Promise<unknown>
}): React.JSX.Element {
  const [pending, setPending] = useState<"sync" | "replace" | "mode" | "unlink" | null>(null)
  const [confirm, setConfirm] = useState<"replace" | "unlink" | null>(null)
  const [error, setError] = useState("")
  const publishMode: PublishMode = source.publish_mode === "direct" ? "direct" : "pull_request"
  const root = source.paths[0] && source.paths[0] !== "." ? source.paths[0] : ""
  const syncing = source.sync_status === "pending" || source.sync_status === "syncing"
  const skipped = skippedFiles(source)
  const problems = skipped.filter((entry) => !entry.quiet)
  const ignored = skipped.length - problems.length
  const repositoryUrl = `https://github.com/${source.repo_full_name}`

  const save = async (
    action: "sync" | "replace" | "mode",
    overrides: { mode?: "merge" | "github_wins"; publishMode?: PublishMode } = {},
  ): Promise<void> => {
    setPending(action)
    setError("")
    try {
      const result = await saveGithubHostedDocsSource({
        repoId: source.repo_id,
        rootPath: root,
        mode: overrides.mode ?? "merge",
        format: "readme",
        publishMode: overrides.publishMode ?? publishMode,
        branch: source.branch ?? null,
      })
      if (result.error) setError(result.error)
      await refresh()
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setPending(null)
      setConfirm(null)
    }
  }

  const unlink = async (): Promise<void> => {
    setPending("unlink")
    setError("")
    try {
      const result = await disableGithubHostedDocsSource()
      if (result.error) setError(result.error)
      await refresh()
    } catch {
      setError("Could not reach the server. Try again shortly.")
    } finally {
      setPending(null)
      setConfirm(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-sm font-medium hover:underline"
            >
              {source.repo_full_name}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3.5" aria-hidden="true" />
                {source.branch ?? "default branch"}
              </span>
              <span className="font-mono">/{root}</span>
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
            {source.sync_status === "synced" ? (
              <CheckCircle2 className="size-3 text-emerald-600" aria-hidden="true" />
            ) : source.sync_status === "error" ? (
              <AlertTriangle className="size-3 text-destructive" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-3" aria-hidden="true" />
            )}
            {syncing
              ? "Syncing"
              : source.sync_status === "error"
                ? "Needs attention"
                : `${source.document_count} pages in sync`}
          </span>
        </div>
        {syncing ? <LoadingBar label="GitHub sync progress" className="mt-3" /> : null}

        <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Last sync</dt>
            <dd>{formatWhen(source.last_sync_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Synced commit</dt>
            <dd className="font-mono">
              {source.last_sync_commit_sha ? (
                <a
                  href={`${repositoryUrl}/commit/${source.last_sync_commit_sha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {source.last_sync_commit_sha.slice(0, 7)}
                </a>
              ) : (
                "none yet"
              )}
            </dd>
          </div>
        </dl>

        {source.last_sync_error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {source.last_sync_error}
          </p>
        ) : null}
        {source.conflict_count > 0 ? (
          <p className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {source.conflict_count} page{source.conflict_count === 1 ? " was" : "s were"} changed
              in both Bread and GitHub. Bread kept its version. Publishing asks
              before overwriting GitHub, or use &quot;Use GitHub&quot; below to take the
              repository&apos;s version everywhere.
            </span>
          </p>
        ) : null}
        {source.publish_pull_request_url ? (
          <a
            href={source.publish_pull_request_url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
          >
            Open publish pull request
            {source.publish_pull_request_number ? ` #${source.publish_pull_request_number}` : ""}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      {problems.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Files that could not be synced</h3>
          <ul className="divide-y rounded-lg border text-sm">
            {problems.slice(0, 25).map((entry) => (
              <li key={entry.path} className="px-3 py-2">
                <span className="font-mono text-xs">{entry.path}</span>
                <span className="block text-xs text-muted-foreground">{entry.reason}</span>
              </li>
            ))}
          </ul>
          {problems.length > 25 ? (
            <p className="text-xs text-muted-foreground">
              and {problems.length - 25} more.
            </p>
          ) : null}
        </div>
      ) : null}
      {ignored > 0 ? (
        <p className="text-xs text-muted-foreground">
          {ignored} file{ignored === 1 ? " is" : "s are"} left as they are in the
          repository: API reference pages generated from an OpenAPI definition and
          ReadMe&apos;s own settings pages. The API reference itself is built from
          the definition under{" "}
          <Link href="/settings/integrations/openapi" className="underline">
            OpenAPI
          </Link>
          .
        </p>
      ) : null}

      {canManage ? (
        <>
          <div className="max-w-xl space-y-1.5">
            <Label>Publishing</Label>
            <PublishModeField
              value={publishMode}
              disabled={pending !== null || syncing}
              onChange={(value) => {
                if (value !== publishMode) void save("mode", { publishMode: value })
              }}
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={pending !== null || syncing}
              onClick={() => void save("sync")}
            >
              {pending === "sync" ? "Starting…" : "Sync now"}
            </Button>
            <Button
              variant="outline"
              disabled={pending !== null || syncing}
              onClick={() => setConfirm("replace")}
            >
              Use GitHub
            </Button>
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => setConfirm("unlink")}
            >
              Unlink
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only workspace owners and admins can change this link.
        </p>
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && pending === null) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "replace" ? "Replace workspace changes with GitHub?" : "Unlink this repository?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "replace"
                ? "Every linked page takes the repository's content, title, order and folder. Edits made in Bread that were not published are replaced; the previous versions stay in each page's history. Pages that exist only in Bread are kept."
                : "Syncing stops. Pages already in the workspace and files already in the repository stay as they are."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null}
              onClick={(event) => {
                event.preventDefault()
                if (confirm === "replace") void save("replace", { mode: "github_wins" })
                else void unlink()
              }}
            >
              {confirm === "replace" ? "Use GitHub" : "Unlink"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function GithubIntegrationContent(): React.JSX.Element {
  const searchParams = useSearchParams()
  const callbackError = searchParams.get("error")
  const { data: workspace } = useWorkspace()
  const integration = useGithubIntegration()
  const connected = Boolean(integration.data?.integration)
  const hostedDocs = useGithubHostedDocs({ enabled: connected })
  const source = hostedDocs.data?.source ?? null
  const canManage = workspace?.user_role === "owner" || workspace?.user_role === "admin"
  const loading = integration.isLoading || (connected && hostedDocs.isLoading)

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-base font-semibold">GitHub</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Two-way sync with a GitHub repository in the layout ReadMe&apos;s GitHub
          integration uses. Pushes to the repository update this workspace;
          changes made here are published back as commits. A repository that
          was synced with ReadMe can be linked as it is.
        </p>
      </header>

      {callbackError ? (
        <p role="alert" className="text-sm text-destructive">
          {CALLBACK_ERRORS[callbackError] ?? "GitHub could not be connected. Try again."}
        </p>
      ) : null}

      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : !connected ? (
        <section className="max-w-xl space-y-3">
          <p className="text-sm text-muted-foreground">
            Install the Bread GitHub App on the repository that holds the docs.
            It needs read and write access to <strong>Contents</strong>, and to{" "}
            <strong>Pull requests</strong> if publishing goes through pull
            requests.
          </p>
          {canManage ? (
            <Button onClick={() => initiateGithubInstall()}>Connect GitHub</Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ask a workspace owner or admin to connect GitHub.
            </p>
          )}
        </section>
      ) : source && source.format !== "readme" ? (
        <section className="max-w-xl space-y-3">
          <p className="text-sm text-muted-foreground">
            This workspace is linked to{" "}
            <span className="font-mono">{source.repo_full_name}</span> in the Bread
            document format. Unlink it to link a repository in the ReadMe layout
            instead.
          </p>
          {canManage ? (
            <Button
              variant="outline"
              onClick={() => {
                void disableGithubHostedDocsSource().then(() => hostedDocs.mutate())
              }}
            >
              Unlink
            </Button>
          ) : null}
        </section>
      ) : source ? (
        <LinkedSource source={source} canManage={canManage} refresh={() => hostedDocs.mutate()} />
      ) : canManage ? (
        <LinkForm onLinked={() => hostedDocs.mutate()} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Ask a workspace owner or admin to link a repository.
        </p>
      )}

      <section className="max-w-2xl space-y-3">
        <h3 className="text-sm font-medium">How the repository maps to the workspace</h3>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            Each folder in <code>docs/</code> is a top-level folder here; pages
            are Markdown files named after their URL slug, and{" "}
            <code>_order.yaml</code> sets the sidebar order.
          </li>
          <li>
            A page with child pages is a folder whose <code>index.md</code> is
            its landing content. <code>hidden: true</code> is an unpublished page.
          </li>
          <li>
            OpenAPI definitions in <code>reference/</code> (JSON or YAML) build
            the API reference, the same as an upload under{" "}
            <Link href="/settings/integrations/openapi" className="underline">
              OpenAPI
            </Link>
            . A definition uploaded there is written back to{" "}
            <code>reference/</code>.
          </li>
          <li>
            A page that nobody edits here is never rewritten in the repository.
            A page edited here is written back as Markdown with its frontmatter
            kept; ReadMe components such as callouts and tabs become plain
            Markdown.
          </li>
        </ul>
      </section>
    </div>
  )
}

export default function GithubIntegrationPage(): React.JSX.Element {
  // useSearchParams needs a Suspense boundary to render during prerendering.
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" />}>
      <GithubIntegrationContent />
    </Suspense>
  )
}
