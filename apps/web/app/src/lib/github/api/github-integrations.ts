import type {
  GitHubHostedDocsSourceRow,
  GitHubIntegrationRow,
  MonitoredRepoRow,
} from "@breezify/core"
import type { GitHubHostedDocsTree } from "@/lib/github/types"

export async function deleteGithubIntegration(): Promise<{ error?: string }> {
  const res = await fetch("/api/github/integrations", { method: "DELETE" })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { error: body.error ?? "Failed to disconnect." }
  }
  return {}
}

export function initiateGithubInstall(): void {
  window.location.href = "/api/github/app/initiate"
}

export async function addMonitoredRepo(
  repoFullName: string,
): Promise<{ repo?: MonitoredRepoRow; error?: string }> {
  const res = await fetch("/api/github/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo_full_name: repoFullName,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    repo?: MonitoredRepoRow
    error?: string
  }
  if (!res.ok) {
    return { error: body.error ?? "Failed to add repository." }
  }
  return { repo: body.repo }
}

export async function removeMonitoredRepo(
  repoId: number,
): Promise<{ error?: string }> {
  const res = await fetch(
    `/api/github/repos?repo_id=${encodeURIComponent(repoId)}`,
    { method: "DELETE" },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { error: body.error ?? "Failed to remove repository." }
  }
  return {}
}

export async function setMonitoredRepoIndexing(
  repoId: number,
  enabled: boolean,
): Promise<{ repo?: MonitoredRepoRow; error?: string }> {
  const res = await fetch('/api/github/repos', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo_id: repoId,
      action: enabled ? 'resume_indexing' : 'cancel_indexing',
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    repo?: MonitoredRepoRow
    error?: string
  }
  if (!res.ok) {
    return { error: body.error ?? 'Failed to update repository indexing.' }
  }
  return { repo: body.repo }
}

export async function triggerGithubManualSweep(): Promise<{
  synced?: number
  errors?: number
  error?: string
}> {
  const res = await fetch("/api/github/sweep/manual", { method: "POST" })
  const body = (await res.json().catch(() => ({}))) as {
    synced?: number
    errors?: number
    error?: string
  }
  if (!res.ok) {
    return { error: body.error ?? "Sweep failed." }
  }
  return body
}

export async function loadGithubHostedDocsTree(
  repoId: number,
): Promise<GitHubHostedDocsTree | { error: string }> {
  const res = await fetch(
    `/api/github/hosted-docs/tree?repo_id=${encodeURIComponent(repoId)}`,
  )
  const body = (await res.json().catch(() => ({}))) as
    | GitHubHostedDocsTree
    | { error?: string }
  if (!res.ok) {
    return { error: (body as { error?: string }).error ?? "Could not load repository folders." }
  }
  return body as GitHubHostedDocsTree
}

export async function saveGithubHostedDocsSource(input: {
  repoId: number
  rootPath: string
  mode: "merge" | "github_wins"
  /** "readme" links a repository in the layout ReadMe's GitHub sync uses. */
  format?: "breezify" | "readme"
  /** ReadMe format only: commit directly, or collect changes in a pull request. */
  publishMode?: "direct" | "pull_request"
  /** ReadMe format only: branch to sync. Empty follows the default branch. */
  branch?: string | null
}): Promise<{
  source?: GitHubHostedDocsSourceRow
  error?: string
}> {
  const res = await fetch("/api/github/hosted-docs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo_id: input.repoId,
      root_path: input.rootPath,
      mode: input.mode,
      ...(input.format ? { format: input.format } : {}),
      ...(input.publishMode ? { publish_mode: input.publishMode } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    source?: GitHubHostedDocsSourceRow
    error?: string
  }
  if (!res.ok) return { error: body.error ?? "Could not save hosted docs source." }
  return { source: body.source }
}

export async function bootstrapGithubHostedDocsSource(input: {
  repoId: number
  targetPath: string
  allowExisting: boolean
}): Promise<{
  source?: GitHubHostedDocsSourceRow
  targetPath?: string
  fileCount?: number
  commitUrl?: string
  pullRequestUrl?: string
  error?: string
}> {
  const res = await fetch("/api/github/hosted-docs/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo_id: input.repoId,
      target_path: input.targetPath,
      allow_existing: input.allowExisting,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    source?: GitHubHostedDocsSourceRow
    target_path?: string
    file_count?: number
    commit_url?: string
    pull_request_url?: string
    error?: string
  }
  if (!res.ok) {
    return { error: body.error ?? "Could not create the GitHub docs folder." }
  }
  return {
    source: body.source,
    targetPath: body.target_path,
    fileCount: body.file_count,
    commitUrl: body.commit_url,
    pullRequestUrl: body.pull_request_url,
  }
}

export async function disableGithubHostedDocsSource(): Promise<{ error?: string }> {
  const res = await fetch("/api/github/hosted-docs", { method: "DELETE" })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { error: body.error ?? "Could not disable hosted documentation." }
  }
  return {}
}
