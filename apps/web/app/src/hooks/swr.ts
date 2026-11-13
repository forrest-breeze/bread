import useSWR, { type SWRConfiguration } from "swr"
import type {
  DocumentLinksResponse,
  FolderDetailResponse,
  ProfileResponse,
  TeamMember,
  WorkspaceRow,
  WorkspaceRole,
} from "@/lib/types"
import type {
  CredentialRole,
  DocumentVersionRow,
  GitHubFileCommit,
  GitHubHostedDocsSourceRow,
  GitHubIntegrationRow,
  ImportJobItemRow,
  ImportJobRow,
  MonitoredRepoRow,
} from "@breezify/core"
import type { GitHubAvailableRepo } from "@/lib/github/types"
import type { PortalLayout } from "@/lib/portal/schema"
import type { PortalScopeEntry } from "@/lib/public-kb"
import type {
  PortalDomainRouteResult,
  PortalProjectsResult,
  PortalVersionsResult,
} from "@/lib/api/portal"
import type { PortalAnalyticsOverview } from "@/lib/portal/analytics-types"

// ---------------------------------------------------------------------------
// Shared fetcher

/**
 * Error thrown by the shared SWR fetcher for non-2xx responses. Carries the
 * HTTP status so consumers can distinguish a definitive rejection (401/403)
 * from a transient failure (503 from the auth-timeout path, 5xx) that SWR will
 * retry and a page refresh usually clears.
 */
export class FetchError extends Error {
  constructor(public readonly status: number) {
    super(`Fetch failed: ${status}`)
    this.name = "FetchError"
  }
}

/**
 * True when the error is a definitive "you can't have this" (401/403) rather
 * than a transient infrastructure failure. Errors without a status (network
 * drop, non-FetchError) count as transient.
 */
export function isPermissionFetchError(error: unknown): boolean {
  return (
    error instanceof FetchError && (error.status === 401 || error.status === 403)
  )
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new FetchError(res.status)
  return res.json() as Promise<T>
}

// Array-key fetcher: the first tuple element is the request URL; any trailing
// elements (e.g. the active workspace id) exist only to scope the SWR cache so
// a workspace switch lands on a fresh entry rather than reusing stale data or a
// stale error from the previous workspace.
async function scopedFetcher<T>(key: readonly [string, ...unknown[]]): Promise<T> {
  return fetcher<T>(key[0])
}

function projectScopedUrl(path: string, projectSlug?: string | null): string {
  return projectSlug ? `${path}?project=${encodeURIComponent(projectSlug)}` : path
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------
export interface WorkspaceWithRole extends WorkspaceRow {
  user_role: WorkspaceRole
  /** Whether the plan includes the visual portal editor (Basic+). */
  portal_editor_enabled?: boolean
  /** Whether the AI portal builder is available (currently always off). */
  portal_ai_builder_enabled?: boolean
  /** Whether the visitor "Ask AI" assistant is available (ANTHROPIC_API_KEY set). */
  portal_assistant_enabled?: boolean
  /** Whether portal machine translation is available (ANTHROPIC_API_KEY set). */
  portal_translations_enabled?: boolean
  /** Whether the plan includes portal reporting (Business/Enterprise). */
  portal_reporting_enabled?: boolean
  /** Max reporting lookback in days. null means uncapped by app presets. */
  portal_reporting_max_days?: number | null
  /** Max portal projects for the plan. null means uncapped. */
  portal_project_limit?: number | null
  /** Whether the plan can remove Breezify branding from the public portal. */
  portal_branding_removal_enabled?: boolean
}

export function useWorkspace(config?: SWRConfiguration<WorkspaceWithRole>) {
  return useSWR<WorkspaceWithRole>("/api/workspace", fetcher, {
    ...config,
  })
}

// ---------------------------------------------------------------------------
// Portal builder draft (admin)
// ---------------------------------------------------------------------------
export interface PortalDraftResponse {
  version: number
  spec: PortalLayout
  projectSlug: string | null
  scope: PortalScopeEntry[] | null
  /** True when the draft has saved spec/scope changes not yet published. */
  divergedFromPublished: boolean
}

function portalDraftUrl(projectSlug?: string): string {
  return projectSlug
    ? `/api/portal/draft?project=${encodeURIComponent(projectSlug)}`
    : "/api/portal/draft"
}

export function usePortalProjects(
  config?: SWRConfiguration<PortalProjectsResult> & {
    workspaceId?: string
    enabled?: boolean
  },
) {
  const { workspaceId, enabled = true, ...swrConfig } = config ?? {}
  // Scope the cache key to the active workspace so switching workspaces fetches
  // a fresh entry (a clean loading state) instead of reusing the previous
  // workspace's project list — or its stale 403 (see usePortalDraft). The key
  // is null until the workspace id is known so we never fetch the wrong scope.
  return useSWR<PortalProjectsResult>(
    enabled && workspaceId ? (["/api/portal/projects", workspaceId] as const) : null,
    scopedFetcher,
    {
      revalidateOnFocus: false,
      ...swrConfig,
    },
  )
}

export function usePortalProjectDomainRoute(
  projectSlug: string | null | undefined,
  config?: SWRConfiguration<PortalDomainRouteResult> & {
    workspaceId?: string
    enabled?: boolean
  },
) {
  const { workspaceId, enabled = true, ...swrConfig } = config ?? {}
  const url = projectSlug
    ? `/api/portal/projects/${encodeURIComponent(projectSlug)}/domain-route`
    : null
  return useSWR<PortalDomainRouteResult>(
    enabled && workspaceId && url ? ([url, workspaceId] as const) : null,
    scopedFetcher,
    { revalidateOnFocus: false, ...swrConfig },
  )
}

// Admin-only: the workspace's draft public-KB portal layout. The GET endpoint
// creates a draft if none exists, so this always resolves to a layout for an
// admin/owner. Not deduped aggressively — the builder mutates the draft and
// relies on local state, revalidating only on mount / workspace switch.
export function usePortalDraft(
  projectSlug?: string,
  config?: SWRConfiguration<PortalDraftResponse> & {
    enabled?: boolean
    workspaceId?: string
  },
) {
  const { enabled = true, workspaceId, ...swrConfig } = config ?? {}
  // Scope the cache key to the active workspace. Without this, a workspace
  // switch revalidates this key (the project slug from the *previous*
  // workspace) against the new workspace cookie and 403s — surfacing a bogus
  // "you need admin access" screen. A workspace-scoped key starts fresh
  // instead. Gated on a known workspace id so the wrong-scope fetch never fires.
  return useSWR<PortalDraftResponse>(
    enabled && workspaceId
      ? ([portalDraftUrl(projectSlug), workspaceId] as const)
      : null,
    scopedFetcher,
    { keepPreviousData: false, revalidateOnFocus: false, ...swrConfig },
  )
}

function portalVersionsUrl(projectSlug?: string): string {
  return projectSlug
    ? `/api/portal/versions?project=${encodeURIComponent(projectSlug)}`
    : "/api/portal/versions"
}

/**
 * A project's published version history, for the builder's version selector.
 * Workspace-scoped for the same reason as usePortalDraft: the slug belongs to
 * one workspace, so a switch must start a fresh key rather than revalidate the
 * previous workspace's project against the new cookie.
 */
export function usePortalVersions(
  projectSlug?: string,
  config?: SWRConfiguration<PortalVersionsResult> & {
    enabled?: boolean
    workspaceId?: string
  },
) {
  const { enabled = true, workspaceId, ...swrConfig } = config ?? {}
  return useSWR<PortalVersionsResult>(
    enabled && workspaceId
      ? ([portalVersionsUrl(projectSlug), workspaceId] as const)
      : null,
    scopedFetcher,
    { keepPreviousData: false, revalidateOnFocus: false, ...swrConfig },
  )
}

// ---------------------------------------------------------------------------
// Portal analytics (Reporting > Overview)
// ---------------------------------------------------------------------------
export type PortalAnalyticsRangeDays = 7 | 14 | 30 | 90 | 180 | 365

export function usePortalAnalytics(
  config?: SWRConfiguration<PortalAnalyticsOverview> & {
    days?: PortalAnalyticsRangeDays
    /** Filter to one published portal project; omit for the workspace rollup. */
    projectSlug?: string | null
    workspaceId?: string
    enabled?: boolean
  },
) {
  const { days = 30, projectSlug, workspaceId, enabled = true, ...swrConfig } = config ?? {}
  const params = new URLSearchParams({ days: String(days) })
  if (projectSlug) params.set("project", projectSlug)
  const url = `/api/portal/analytics?${params.toString()}`
  // Scope the cache key to the active workspace so a switch lands on a fresh
  // entry (clean loading state) rather than the previous workspace's data.
  // Null key until the workspace id is known so we never fetch the wrong scope.
  return useSWR<PortalAnalyticsOverview>(
    enabled && workspaceId ? ([url, workspaceId] as const) : null,
    scopedFetcher,
    { revalidateOnFocus: false, keepPreviousData: true, ...swrConfig },
  )
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export function useProfile(config?: SWRConfiguration<ProfileResponse>) {
  return useSWR<ProfileResponse>("/api/profile", fetcher, {
    ...config,
  })
}

// ---------------------------------------------------------------------------
// Team members (workspace-level)
// ---------------------------------------------------------------------------
interface TeamResponse {
  members: TeamMember[]
  current_user_id: string
  current_user_role: WorkspaceRole
}

export function useTeamMembers(config?: SWRConfiguration<TeamResponse>) {
  return useSWR<TeamResponse>("/api/team", fetcher, {
    ...config,
  })
}

// ---------------------------------------------------------------------------
// All workspaces (for workspace switcher)
// ---------------------------------------------------------------------------
export interface WorkspaceListItem extends WorkspaceRow {
  user_role: WorkspaceRole
  /** Whether the plan includes the visual portal editor (Basic+). */
  portal_editor_enabled?: boolean
  /** Whether the AI portal builder is available (currently always off). */
  portal_ai_builder_enabled?: boolean
  /** Whether the visitor "Ask AI" assistant is available (ANTHROPIC_API_KEY set). */
  portal_assistant_enabled?: boolean
  /** Whether the plan includes portal reporting (Business/Enterprise). */
  portal_reporting_enabled?: boolean
  /** Max reporting lookback in days. null means uncapped by app presets. */
  portal_reporting_max_days?: number | null
  /** Max portal projects for the plan. null means uncapped. */
  portal_project_limit?: number | null
  /** Whether the plan can remove Breezify branding from the public portal. */
  portal_branding_removal_enabled?: boolean
}

export function useWorkspaces(config?: SWRConfiguration<WorkspaceListItem[]>) {
  // keepPreviousData guards against a transient empty response (e.g. RLS
  // returning 0 rows during a Supabase session refresh) wiping out the
  // cached list mid-session. revalidateOnMount forces a fresh fetch from the
  // (always-correct) endpoint on every mount, so the switcher reflects live
  // membership rather than any cached value. Empty/error responses are no
  // longer persisted to localStorage (see shouldPersistEntry in swr-provider),
  // which is what previously stuck the dropdown on "No workspaces".
  return useSWR<WorkspaceListItem[]>("/api/workspaces", fetcher, {
    dedupingInterval: 15_000,
    keepPreviousData: true,
    revalidateOnMount: true,
    ...config,
  })
}

// ---------------------------------------------------------------------------
// Workspace usage (admin-only counts for members, AI ops, storage)
// ---------------------------------------------------------------------------
export interface WorkspaceUsageResponse {
  periodStart: string | null
  periodEnd: string | null
  members: { count: number }
  compute: {
    opsSuccess: number
    opsError: number
    opsSkip: number
    tokensInput: number
    tokensOutput: number
    durationMs: number
  }
  storage: { bytes: number; mediaBytes: number; mediaLimitBytes: number }
}

export function useWorkspaceUsage(
  config?: SWRConfiguration<WorkspaceUsageResponse> & { enabled?: boolean },
) {
  const { enabled = true, ...swrConfig } = config ?? {}
  return useSWR<WorkspaceUsageResponse>(
    enabled ? "/api/workspace/usage" : null,
    fetcher,
    {
      dedupingInterval: 30_000,
      ...swrConfig,
    },
  )
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
interface DocumentsResponse {
  id: string
  title: string
  source: string
  status: string
  author: string
  folder_id: string | null
  /** Only "source"/"page" documents are eligible for public portals. */
  document_type?: string
  /** Explicit manual position within its folder (null = no explicit order). */
  sort_order?: number | null
  created_at: string
  updated_at: string
  [key: string]: unknown
}

export interface DocumentHomeItem extends DocumentsResponse {
  preview: string
}

interface DocumentHomeResponse {
  documents: DocumentHomeItem[]
  total: number
}

export function useDocuments(
  config?: SWRConfiguration<DocumentsResponse[]> & {
    projectSlug?: string | null
  },
) {
  const { projectSlug, ...swrConfig } = config ?? {}
  return useSWR<DocumentsResponse[]>(
    projectScopedUrl("/api/documents", projectSlug),
    fetcher,
    {
      ...swrConfig,
    },
  )
}

export function useDocumentHome(
  config?: SWRConfiguration<DocumentHomeResponse>,
) {
  return useSWR<DocumentHomeResponse>("/api/documents/home", fetcher, {
    ...config,
  })
}

// ---------------------------------------------------------------------------
// Single document (with content)
// ---------------------------------------------------------------------------
interface DocumentDetailResponse {
  id: string
  title: string
  content: string
  source: string
  status: string
  author: string
  source_metadata?: Record<string, unknown> | null
  /** Primary owning folder (null = workspace-level). Used for portal breadcrumbs. */
  folder_id?: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface GitHubDocumentSessionResponse {
  id: string
  document_id: string
  repo_full_name: string
  file_path: string
  deploy_branch: string
  branch_name: string
  draft_content: string
  draft_revision: number
  status:
    | "draft"
    | "publishing"
    | "open"
    | "conflict"
    | "merged"
    | "discarded"
    | "error"
  last_commit_sha: string | null
  pr_number: number | null
  pr_url: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface GitHubDocumentStateResponse {
  editable: boolean
  repository: {
    repo_id: number
    repo_full_name: string
    file_path: string
    deploy_branch: string
    commit_sha: string
    blob_sha: string
    html_url: string
  }
  repository_content: string
  session: GitHubDocumentSessionResponse | null
  behind_deployment: boolean
  editor_path: string
}

export interface GitHubDocumentHistoryResponse {
  commits: GitHubFileCommit[]
  has_more: boolean
  page: number
}

export function useDocument(
  id: string | null,
  config?: SWRConfiguration<DocumentDetailResponse>,
) {
  return useSWR<DocumentDetailResponse>(
    id ? `/api/documents/${id}` : null,
    fetcher,
    { ...config },
  )
}

export function useGitHubDocumentState(
  id: string | null,
  config?: SWRConfiguration<GitHubDocumentStateResponse> & {
    enabled?: boolean
  },
) {
  const { enabled = true, ...swrConfig } = config ?? {}
  return useSWR<GitHubDocumentStateResponse>(
    enabled && id ? `/api/documents/${id}/github` : null,
    fetcher,
    {
      revalidateOnFocus: true,
      ...swrConfig,
    },
  )
}

export function useGitHubDocumentHistory(
  id: string | null,
  page = 1,
  config?: SWRConfiguration<GitHubDocumentHistoryResponse> & {
    enabled?: boolean
  },
) {
  const { enabled = true, ...swrConfig } = config ?? {}
  return useSWR<GitHubDocumentHistoryResponse>(
    enabled && id
      ? `/api/documents/${id}/github/history?page=${page}`
      : null,
    fetcher,
    {
      revalidateOnFocus: false,
      ...swrConfig,
    },
  )
}

// ---------------------------------------------------------------------------
// Document cross-links (read portal) — sweep-created related/backlink graph
// ---------------------------------------------------------------------------
export function useDocumentLinks(
  id: string | null,
  config?: SWRConfiguration<DocumentLinksResponse>,
) {
  return useSWR<DocumentLinksResponse>(
    id ? `/api/documents/${id}/links` : null,
    fetcher,
    { dedupingInterval: 30_000, ...config },
  )
}

// ---------------------------------------------------------------------------
// Knowledge search (read portal) — pgvector cosine over workspace documents.
// Reuses the command-palette endpoint; the portal only consumes `knowledge`.
// ---------------------------------------------------------------------------
export interface KnowledgeSearchHit {
  id: string
  title: string
  content?: string
  source?: string | null
  author?: string | null
  updated_at?: string
  similarity?: number
}

interface KnowledgeSearchResponse {
  knowledge: KnowledgeSearchHit[]
}

export function useKnowledgeSearch(
  query: string | null,
  config?: SWRConfiguration<KnowledgeSearchResponse>,
) {
  const trimmed = (query ?? "").trim()
  return useSWR<KnowledgeSearchResponse>(
    trimmed.length >= 1
      ? `/api/search?q=${encodeURIComponent(trimmed)}&limit=12`
      : null,
    fetcher,
    { keepPreviousData: true, dedupingInterval: 10_000, ...config },
  )
}

// ---------------------------------------------------------------------------
// Document versions
// ---------------------------------------------------------------------------
interface DocumentVersionsResponse {
  versions: DocumentVersionRow[]
}

export function useDocumentVersions(
  documentId: string | null,
  config?: SWRConfiguration<DocumentVersionsResponse>,
) {
  return useSWR<DocumentVersionsResponse>(
    documentId ? `/api/documents/${documentId}/versions` : null,
    fetcher,
    { dedupingInterval: 30_000, ...config },
  )
}

// ---------------------------------------------------------------------------
// Folders (unified: kind='user' | 'topic' | 'system')
// ---------------------------------------------------------------------------
export type FolderVisibility = "workspace" | "role"

export type WorkspaceMemberRole =
  | "owner"
  | "admin"
  | "editor"
  | "viewer"
  | "agent-only"

export interface FolderResponse {
  id: string
  name: string
  display_name: string
  kind: "user" | "topic" | "system"
  parent_folder_id: string | null
  visibility: FolderVisibility
  required_role: WorkspaceMemberRole | null
  document_count: number
  sort_order: number | null
  icon: string | null
  last_seen_at: string
  created_at: string
  updated_at: string
}

export function useFolders(
  config?: SWRConfiguration<FolderResponse[]> & {
    projectSlug?: string | null
    enabled?: boolean
  },
) {
  const { projectSlug, enabled = true, ...swrConfig } = config ?? {}
  return useSWR<FolderResponse[]>(
    enabled ? projectScopedUrl("/api/folders", projectSlug) : null,
    fetcher,
    {
      ...swrConfig,
    },
  )
}

export function useFolderDetail(
  folderId: string | null,
  config?: SWRConfiguration<FolderDetailResponse> & {
    projectSlug?: string | null
  },
) {
  const { projectSlug, ...swrConfig } = config ?? {}
  return useSWR<FolderDetailResponse>(
    folderId ? projectScopedUrl(`/api/folders/${folderId}`, projectSlug) : null,
    fetcher,
    { ...swrConfig },
  )
}

// ---------------------------------------------------------------------------
// GitHub integration
// ---------------------------------------------------------------------------
interface GithubIntegrationResponse {
  integration: GitHubIntegrationRow | null
}

// ---------------------------------------------------------------------------
// OpenAPI sources (Settings -> Integrations -> OpenAPI)
// ---------------------------------------------------------------------------

export interface OpenApiSourceItem {
  slug: string
  title: string
  version: string | null
  operation_count: number
  root_folder_id: string | null
  last_synced_at: string
  last_synced_by: string
}

export function useOpenApiSources(
  config?: SWRConfiguration<{ sources: OpenApiSourceItem[] }>,
) {
  return useSWR<{ sources: OpenApiSourceItem[] }>("/api/openapi-sources", fetcher, config)
}

export function useGithubIntegration(
  config?: SWRConfiguration<GithubIntegrationResponse>,
) {
  return useSWR<GithubIntegrationResponse>(
    "/api/github/integrations",
    fetcher,
    { dedupingInterval: 60_000, ...config },
  )
}

// ---------------------------------------------------------------------------
// Monitored repos
// ---------------------------------------------------------------------------
interface MonitoredReposResponse {
  repos: MonitoredRepoRow[]
}

export function useMonitoredRepos(
  config?: SWRConfiguration<MonitoredReposResponse>,
) {
  return useSWR<MonitoredReposResponse>("/api/github/repos", fetcher, {
    dedupingInterval: 2_000,
    // Repository indexing runs after the add-repo response. Poll only while a
    // run is active, then stop once the persisted outcome is visible.
    refreshInterval: (latest) =>
      latest?.repos.some(
        (repo) =>
          repo.file_sync_status === "pending" ||
          repo.file_sync_status === "syncing",
      )
        ? 5_000
        : 0,
    ...config,
  })
}

// Repos the GitHub App installation can access — powers the "add repo"
// dropdown so admins pick instead of typing. Pass `enabled: false` (e.g. when
// GitHub isn't connected) to skip the fetch.
interface AvailableGithubReposResponse {
  repositories: GitHubAvailableRepo[]
}

export function useAvailableGithubRepos(
  config?: SWRConfiguration<AvailableGithubReposResponse> & { enabled?: boolean },
) {
  const { enabled = true, ...swrConfig } = config ?? {}
  return useSWR<AvailableGithubReposResponse>(
    enabled ? "/api/github/repos/available" : null,
    fetcher,
    { dedupingInterval: 60_000, ...swrConfig },
  )
}

export interface GithubHostedDocsResponse {
  source: GitHubHostedDocsSourceRow | null
  linked_folder: {
    id: string
    display_name: string
    visibility: FolderVisibility
    required_role: WorkspaceMemberRole | null
  } | null
  linked_path_count: number
  linked_document_count: number
}

export function githubHostedDocsRefreshInterval(
  latest:
    | { source: Pick<GitHubHostedDocsSourceRow, "sync_status"> | null }
    | undefined,
): number {
  const status = latest?.source?.sync_status
  return status === "disabled" || status === "pending" || status === "syncing"
    ? 5_000
    : 0
}

export function useGithubHostedDocs(
  config?: SWRConfiguration<GithubHostedDocsResponse> & { enabled?: boolean },
) {
  const { enabled = true, ...swrConfig } = config ?? {}
  return useSWR<GithubHostedDocsResponse>(
    enabled ? "/api/github/hosted-docs?summary=1" : null,
    fetcher,
    {
      dedupingInterval: 2_000,
      refreshInterval: githubHostedDocsRefreshInterval,
      ...swrConfig,
    },
  )
}

export type GithubHostedDocsPublishStatusState =
  | "up_to_date"
  | "changes"
  | "sync_required"
  | "blocked"
  | "unavailable"

export interface GithubHostedDocsPublishStatusResponse {
  status: GithubHostedDocsPublishStatusState
  changed_file_count: number
  written_file_count: number
  deleted_file_count: number
  unchanged_file_count: number
  compared_commit_sha: string | null
  comparison_key?: string | null
  pull_request_up_to_date?: boolean
  code?: string
  message?: string
}

export const GITHUB_HOSTED_DOCS_PUBLISH_STATUS_PATH =
  "/api/github/hosted-docs/publish"

export function isGithubHostedDocsPublishStatusKey(key: unknown): boolean {
  return (
    typeof key === "string" &&
    (key === GITHUB_HOSTED_DOCS_PUBLISH_STATUS_PATH ||
      key.startsWith(`${GITHUB_HOSTED_DOCS_PUBLISH_STATUS_PATH}?`))
  )
}

export function githubHostedDocsPublishStatusRefreshInterval(
  latest: GithubHostedDocsPublishStatusResponse | undefined,
): number {
  return latest?.status === "sync_required" ||
    (latest?.status === "blocked" && latest.code === "publish_in_progress")
    ? 5_000
    : 0
}

/**
 * Exact, provider-backed workspace publish status. Its cache key includes the
 * persisted GitHub basis so a completed pull/sync cannot reuse an older result.
 */
export function useGithubHostedDocsPublishStatus(
  source: GitHubHostedDocsSourceRow | null | undefined,
  config?: SWRConfiguration<GithubHostedDocsPublishStatusResponse> & {
    enabled?: boolean
  },
) {
  const { enabled = true, ...swrConfig } = config ?? {}
  const canInspect = enabled && source?.sync_status === "synced"
  const basis = source
    ? JSON.stringify([
        source.id,
        source.installation_id,
        source.repo_id,
        source.repo_full_name,
        source.paths,
        source.root_folder_id,
        source.last_sync_commit_sha,
        source.publish_pull_request_head,
        source.publish_last_commit_sha,
        source.conflict_count,
      ])
    : ""
  return useSWR<GithubHostedDocsPublishStatusResponse>(
    canInspect
      ? `${GITHUB_HOSTED_DOCS_PUBLISH_STATUS_PATH}?basis=${encodeURIComponent(basis)}`
      : null,
    fetcher,
    {
      dedupingInterval: 30_000,
      revalidateOnFocus: true,
      refreshInterval: githubHostedDocsPublishStatusRefreshInterval,
      ...swrConfig,
    },
  )
}

// ---------------------------------------------------------------------------
// Personal Access Tokens (CLI)
// ---------------------------------------------------------------------------
interface PATRow {
  id: string
  name: string
  last_used_at: string | null
  created_at: string
  expires_at: string | null
  scopes: string[]
  revoked_at: string | null
}

interface PATsResponse {
  tokens: PATRow[]
}

export function usePersonalAccessTokens(config?: SWRConfiguration<PATsResponse>) {
  return useSWR<PATsResponse>("/api/user/pat", fetcher, {
    ...config,
  })
}

// ---------------------------------------------------------------------------
// Workspace API Keys
// ---------------------------------------------------------------------------
interface ApiKeyListItem {
  id: string
  name: string
  created_by: string | null
  role: CredentialRole
  scopes: string[]
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
  /** False for keys minted before secrets became retrievable — no reveal possible. */
  revealable: boolean
}

interface ApiKeysResponse {
  keys: ApiKeyListItem[]
}

export function useApiKeys(config?: SWRConfiguration<ApiKeysResponse>) {
  return useSWR<ApiKeysResponse>("/api/workspace/api-keys", fetcher, {
    ...config,
  })
}

// ---------------------------------------------------------------------------
// Import jobs
// ---------------------------------------------------------------------------
interface ImportJobsResponse {
  jobs: Array<Pick<
    ImportJobRow,
    | "id"
    | "source"
    | "status"
    | "total_items"
    | "processed_items"
    | "succeeded_items"
    | "failed_items"
    | "skipped_items"
    | "error_message"
    | "started_by"
    | "started_at"
    | "completed_at"
    | "created_at"
  >>
}

export function useImportJobs(
  config?: SWRConfiguration<ImportJobsResponse>,
) {
  return useSWR<ImportJobsResponse>("/api/import/jobs", fetcher, {
    dedupingInterval: 5_000,
    ...config,
  })
}

interface ImportJobDetailResponse {
  job: ImportJobRow
  items: ImportJobItemRow[]
}

export function useImportJob(
  jobId: string | null,
  config?: SWRConfiguration<ImportJobDetailResponse>,
) {
  return useSWR<ImportJobDetailResponse>(
    jobId ? `/api/import/jobs/${jobId}` : null,
    fetcher,
    { dedupingInterval: 2_000, ...config },
  )
}

