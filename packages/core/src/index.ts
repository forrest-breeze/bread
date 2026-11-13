export const CORE_VERSION = "0.0.0";

// llms.txt document model + renderer, shared by the marketing site and the
// public KB portals (see ./llms-txt.ts).
// Node ESM requires the file extension on relative specifiers; without it the
// built dist/index.js throws ERR_MODULE_NOT_FOUND the moment core is rebuilt.
export * from "./llms-txt.js";

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

export interface ResolutionStep {
  action: string;
  command: string;
}

export interface RunbookEntry {
  id: string;
  title: string;
  symptoms: string[];
  root_cause: string;
  resolution_steps: ResolutionStep[];
  tools_involved: string[];
  updated_at: string;
  source?: string;
}

export interface BreadExtraction {
  title: string;
  symptoms: string[];
  root_cause: string;
  resolution_steps: ResolutionStep[];
  tools_involved: string[];
}

export type DocumentType = 'source' | 'topic_page';

export interface DocumentRow {
  id: string;
  title: string;
  content: string;
  source: string;
  status: string;
  author: string;
  user_id: string | null;
  workspace_id: string | null;
  team_id: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
  embedding?: number[] | null;
  document_type: DocumentType;
  synthesized_at: string | null;
}

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  workspace_id: string;
  title: string;
  content: string;
  edited_by: string | null;
  source: string | null;
  created_at: string;
}

export type GitHubDocumentEditSessionStatus =
  | "draft"
  | "publishing"
  | "open"
  | "conflict"
  | "merged"
  | "discarded"
  | "error";

/**
 * A collaborative, unpublished edit of a GitHub-owned documentation file.
 * `base_content` is deliberately server-only in browser responses; it is
 * retained here in the database shape because publish uses it for three-way
 * merging against the deployment branch.
 */
export interface GitHubDocumentEditSessionRow {
  id: string;
  workspace_id: string;
  document_id: string;
  installation_id: number;
  repo_id: number;
  repo_full_name: string;
  file_path: string;
  deploy_branch: string;
  branch_name: string;
  deploy_commit_sha: string;
  deploy_blob_sha: string;
  deploy_base_content: string;
  base_commit_sha: string;
  base_blob_sha: string;
  base_content: string;
  draft_content: string;
  draft_revision: number;
  status: GitHubDocumentEditSessionStatus;
  last_commit_sha: string | null;
  last_saved_blob_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  created_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubFileCommit {
  sha: string;
  html_url: string;
  message: string;
  authored_at: string;
  author_name: string;
  author_login: string | null;
  author_avatar_url: string | null;
}

export interface DocumentSearchResult {
  id: string;
  title: string;
  content: string;
  source: string;
  author: string;
  updated_at: string;
  similarity: number;
}

export interface SlackEventPayload {
  type: "url_verification" | "event_callback";
  challenge?: string;
  token?: string;
  team_id?: string;
  // Slack Events API attaches a stable event_id to event_callback envelopes.
  // Used for dedup via webhook_deliveries (source='slack').
  event_id?: string;
  event?: {
    type: string;
    text: string;
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    subtype?: string;   // e.g. "bot_message", "message_changed"
    bot_id?: string;    // set if the message originates from a bot
  };
}

export interface SlackIntegrationRow {
  id: string;
  workspace_id: string;
  slack_team_id: string;
  slack_team_name: string | null;
  /**
   * Plaintext bot token. Kept during dual-read rollout (Milestone 1).
   * Will be dropped in a follow-up migration once every row has
   * `bot_token_encrypted` populated and application code reads only from
   * the encrypted column.
   */
  bot_token: string | null;
  /**
   * Ciphertext from pgsodium's `slack_token_encrypt` function. Base64-encoded
   * when returned via the `slack_token_decrypt_b64` RPC; raw bytea on direct
   * column reads.
   */
  bot_token_encrypted: string | null;
  installed_by: string | null;
  /** Scheduled auto-ingestion opt-in (Business/Enterprise). @see AutoIngestConfig */
  auto_ingest_enabled: boolean;
  auto_ingest_period_seconds: number;
  /** Cadence clock for the cron worker; null until the first scheduled poll. */
  last_synced_at: string | null;
  last_sync_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A Slack channel an admin has designated for scheduled auto-ingestion. Bread
 * polls only these channels (never the whole workspace); `last_synced_ts` is the
 * Slack epoch-float high-water mark of the newest message ingested.
 */
export interface SlackMonitoredChannelRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  channel_name: string | null;
  last_synced_ts: string | null;
  last_sync_attempt_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface SlackSessionRow {
  id: string;
  workspace_id: string;
  slack_team_id: string;
  channel_id: string;
  thread_ts: string;
  started_by_slack_user_id: string;
  status: "active" | "stopped" | "error";
  doc_count: number;
  document_ids: string[];
  created_at: string;
  stopped_at: string | null;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  subtype?: string;
  /** Set on thread replies and roots; equals `ts` on the thread root. */
  thread_ts?: string;
  /** Number of replies on a thread root (present on roots in channel history). */
  reply_count?: number;
}

// ---------------------------------------------------------------------------
// Workflows — node-graph recipes triggered by Slack or GitHub events
// ---------------------------------------------------------------------------

export type WorkflowTriggerType = "slack" | "github";

/**
 * The kind of a workflow node. Each kind has its own `config` shape; see
 * {@link WorkflowNode} for the per-kind config contracts.
 */
export type WorkflowNodeKind =
  | "trigger.slack"
  | "trigger.github"
  | "llm"
  | "slack.reply"
  | "github.comment"
  | "condition"
  | "http.request";

/**
 * A single node in a workflow graph.
 *
 * Per-kind `config` shapes (not strictly typed — validated by the runtime):
 * - `trigger.slack`: `{ event?: "app_mention" | "message" }`
 * - `trigger.github`: `{ event?: "pull_request" | "issue_comment" | "pull_request_review" }`
 * - `llm`: `{ prompt: string; model?: string; outputVariable?: string }`
 * - `slack.reply`: `{ template: string }` — supports `{{var}}` interpolation
 *   from upstream LLM/trigger outputs.
 * - `github.comment`: `{ template: string }` — same interpolation as above.
 * - `condition`: `{ expression: string }` — JS expression; routes via
 *   `sourceHandle` `"true"` / `"false"` on outgoing edges.
 * - `http.request`: `{ url: string; method: "GET" | "POST"; headers?: Record<string, string>; body?: string }`
 */
export interface WorkflowNode {
  /** Stable UUID for the node within its graph. */
  id: string;
  kind: WorkflowNodeKind;
  position: { x: number; y: number };
  /** Kind-specific configuration. See {@link WorkflowNode} for shapes. */
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Optional handle on the source node (e.g. `"true"` / `"false"` for condition branches). */
  sourceHandle?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  trigger_type: WorkflowTriggerType;
  enabled: boolean;
  graph: WorkflowGraph | null;
  created_at: string;
  updated_at: string;
}

export interface Workflow extends Omit<WorkflowSummary, "graph"> {
  workspace_id: string;
  user_id: string;
  instructions: string;
  inputs: Record<string, unknown>;
  graph: WorkflowGraph;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  trigger_type?: WorkflowTriggerType;
  instructions?: string;
  inputs?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  trigger_type?: WorkflowTriggerType;
  instructions?: string;
  inputs?: Record<string, unknown>;
  enabled?: boolean;
  graph?: WorkflowGraph;
}

export type WorkflowRunStatus = "pending" | "running" | "succeeded" | "failed";

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  workspace_id: string;
  status: WorkflowRunStatus;
  trigger_context: Record<string, unknown>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface WorkflowRunStep {
  id: string;
  run_id: string;
  node_id: string;
  status: WorkflowRunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

// ---------------------------------------------------------------------------
// Profiles, Workspaces & Team
// ---------------------------------------------------------------------------

export interface ProfileRow {
  id: string;
  user_id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  status: "active" | "vacation" | "departed";
  onboarding_completed_at: string | null;

  created_at: string;
  updated_at: string;
}

export type OnboardingJoinMethod = "created" | "invite_code" | "pending_invite" | "domain_match";

export interface OnboardingSurveyAnswers {
  // Legacy survey fields kept optional for older clients/sessions.
  role?: string;
  team_size?: string;
  heard_from?: string;
  primary_goal?: string;
  // Current onboarding flow.
  pain_key?: string;
  pain_label?: string;
  pain_detail?: string;
  user_name?: string;
  company_name?: string;
  docs_url?: string;
  docs_sample?: string;
  docs_import_method?: "paste" | "url" | "file" | "skip";
}

export interface OnboardingCompletePayload {
  join_method: OnboardingJoinMethod;
  workspace_id: string;
  survey?: OnboardingSurveyAnswers;
}

export interface OwnedWorkspaceSummary {
  id: string;
  name: string;
}

export interface ProfileResponse extends ProfileRow {
  role: string | null;
  can_delete_account: boolean;
  owned_workspaces: OwnedWorkspaceSummary[];
  /** Owned workspaces that still have other active members — deletion is
   *  blocked until these are transferred or removed manually. */
  shared_owned_workspaces: OwnedWorkspaceSummary[];
  /** Owned workspaces where the user is the only active member. These are
   *  deleted together with the account. */
  solo_owned_workspaces: OwnedWorkspaceSummary[];
}

export interface WorkspaceRow {
  id: string;
  name: string;
  /**
   * Globally-unique, DNS-label-safe identifier. Auto-generated on create and
   * editable by admins; keys the public portal URL (`/p/<slug>`) and, when the
   * subdomain feature is configured, `<slug>.<NEXT_PUBLIC_PUBLIC_KB_BASE_DOMAIN>`.
   * Validated via `validateHandle` before write; uniqueness is enforced by the
   * `workspaces_slug_key` index.
   */
  slug: string;
  icon_url: string | null;
  default_slack_channel: string | null;
  settings: WorkspaceSettings;
  created_at: string;
  updated_at: string;
}

export type IngestionApprovalMode = "smart" | "always_review";
export type PortalChromeScope = "workspace" | "project";
export type PortalAddressScope = "workspace" | "project";
export type PortalAddressMode = "bread" | "path" | "domain";

export interface WorkspaceSettings {
  invite_code?: string;
  ingestion_approval_mode?: IngestionApprovalMode;
  allowed_domains?: string[];
  /**
   * When true, the workspace's `visibility: 'workspace'` knowledge base is
   * published as a read-only public site at /p/<slug> (and any configured
   * subdomain). Default false — publishing is always an explicit opt-in.
   */
  kb_public?: boolean;
  /**
   * Optional fully-qualified custom domain (e.g. "docs.acme.com") the admin has
   * pointed at the public KB. When set and `kb_public` is true, requests whose
   * Host matches this value are served the workspace's public KB. Stored
   * lowercased; empty/undefined means no custom domain.
   */
  kb_custom_domain?: string;
  /** Where portal hosting is configured: once for the workspace or per project. */
  portal_address_scope?: PortalAddressScope;
  /** Active workspace hosting method when portal_address_scope is workspace. */
  portal_address_mode?: PortalAddressMode;
  /**
   * Slug of the portal project the workspace root (`/p/<slug>`) redirects to
   * when no project is published at the root itself (i.e. no project whose slug
   * equals the workspace slug). Set in Settings → Public Portal Address.
   * Empty/undefined falls back to the legacy "docs" project, then a 404.
   */
  kb_primary_project?: string;
  /** Optional display name shown in the public/private KB chrome. */
  kb_brand_name?: string;
  /** Optional short description shown on the public/private KB home page. */
  kb_brand_tagline?: string;
  /** Optional HTTP(S) or app-relative logo URL shown in the KB chrome. */
  kb_brand_logo_url?: string;
  /** Optional hex accent color used by the KB portal UI. */
  kb_brand_accent?: string;
  /**
   * Controls whether public portal projects inherit one workspace-level
   * header/footer (`workspace`, default) or use each project's saved header and
   * footer (`project`).
   */
  portal_chrome_scope?: PortalChromeScope;
  /** Shared portal header settings used when `portal_chrome_scope` is workspace. */
  kb_header?: unknown;
  /** Shared portal footer settings used when `portal_chrome_scope` is workspace. */
  kb_footer?: unknown;
  /**
   * The workspace's existing public website / landing page (e.g.
   * "https://acme.com"), captured during onboarding. When set, generated portal
   * templates point their Home/Pricing nav links at this site instead of the
   * Bread marketing placeholders, and ingestion may later crawl it for extra
   * context. Stored as a normalized absolute http(s) URL; empty/undefined means
   * the workspace has no landing page on file.
   */
  landing_page_url?: string;
  [key: string]: unknown;
}

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer" | "agent-only";

export const ROLE_RANKS: Record<WorkspaceRole, number> = {
  "owner": 40,
  "admin": 30,
  "editor": 20,
  "viewer": 10,
  "agent-only": 0,
};

export function canManageRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  return ROLE_RANKS[actorRole] >= ROLE_RANKS[targetRole];
}

// ---------------------------------------------------------------------------
// Workspace Experiences — versioned agent-customizable dashboard / KB layouts.
// See docs/plans/agent-customizable-dashboard-kb-prd.md §5–6 and the
// `workspace_experiences` table. The validated layout/spec is stored in `spec`
// (for KB experiences this is a PortalLayout, validated by the web app's portal
// schema before render/persist; left as `unknown` here since the spec shape
// lives in the web app, not core).
// ---------------------------------------------------------------------------

export type WorkspaceExperienceKind = "dashboard" | "kb";
export type WorkspaceExperienceStatus = "draft" | "published" | "archived";
export type WorkspaceExperienceAudience = "internal" | "public";

export interface WorkspaceExperience {
  id: string;
  workspace_id: string;
  kind: WorkspaceExperienceKind;
  status: WorkspaceExperienceStatus;
  version: number;
  name: string | null;
  description: string | null;
  audience: WorkspaceExperienceAudience;
  /** Validated layout/spec. For kind:'kb' this is a PortalLayout. */
  spec: unknown;
  created_by: string | null;
  published_by: string | null;
  source_conversation_id: string | null;
  prompt_summary: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  archived_at: string | null;
}

export interface WorkspaceMemberRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  role: WorkspaceRole;
  status: "active" | "invited" | "expired";
  profile_role?: string | null;
  invited_email: string | null;
  created_at: string;
}

export interface InviteLinkRow {
  id: string;
  workspace_id: string;
  code: string;
  created_by: string;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  is_active: boolean;
  role: WorkspaceRole;
  created_at: string;
}

export interface TeamMember {
  member_id: string;
  user_id: string | null;
  workspace_role: WorkspaceRole;
  member_status: "active" | "invited" | "expired";
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  profile_role: string | null;
  profile_status: "active" | "vacation" | "departed";
  contributions: number;
}

// ---------------------------------------------------------------------------
// Teams (organizational grouping within a workspace)
// ---------------------------------------------------------------------------

export interface TeamRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMemberRow {
  id: string;
  team_id: string;
  workspace_member_id: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Subscriptions (workspace-level billing)
// ---------------------------------------------------------------------------

export type SubscriptionPlanId = "free" | "basic" | "business" | "enterprise";
export type SubscriptionBillingInterval = "monthly" | "annual";
export type SubscriptionTier = "free" | "pro" | "enterprise";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "incomplete";

export interface SubscriptionRow {
  id: string;
  workspace_id: string;
  plan_id: SubscriptionPlanId | null;
  billing_interval: SubscriptionBillingInterval | null;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// API Keys / Tokens
// ---------------------------------------------------------------------------

export type PatScope = "capture" | "read" | "admin";

/**
 * The folder-visibility tier a credential carries, compared via the role
 * ladder (owner:4 admin:3 editor:2 viewer:1 agent-only:0) against
 * `folders.required_role`. Excludes "owner": a long-lived machine credential
 * should never hold the top role.
 */
export type CredentialRole = "admin" | "editor" | "viewer" | "agent-only";

export interface PersonalAccessTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scopes: PatScope[];
  /**
   * Optional folder-tier downscope *below* the member's own role.
   * null = inherit the member role (no downscope).
   */
  role: CredentialRole | null;
  /** ISO 8601. Defaults to created_at + 90 days. */
  expires_at: string;
  /** ISO 8601 when the token was revoked, or null if still active. */
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  name: string;
  key_hash: string;
  created_by: string;
  /** Folder-visibility tier this key acts as. */
  role: CredentialRole;
  /** Action capability (read / capture / admin). */
  scopes: PatScope[];
  /** ISO 8601 expiry, or null for never-expires (legacy keys). */
  expires_at: string | null;
  /** ISO 8601 when revoked, or null if still active. */
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Conversations & Chat Messages
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: Record<string, unknown>[] | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// GitHub Integration
// ---------------------------------------------------------------------------

/**
 * One row per GitHub App installation linked to a Bread workspace.
 * No access token is stored — tokens are generated on demand via RS256 JWT
 * (see getInstallationToken). Tokens expire after 1 hour.
 */
export interface GitHubIntegrationRow {
  id: string;
  workspace_id: string;
  /** GitHub organisation or personal account login, e.g. "acmecorp" */
  github_account_login: string;
  github_account_type: 'Organization' | 'User';
  /** GitHub App installation ID. Unique across all Bread workspaces. */
  installation_id: number;
  installed_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A repository within an installation enabled for source-file indexing and PR
 * capture. Webhook events for repos not present here are silently ignored.
 */
export interface MonitoredRepoRow {
  id: string;
  workspace_id: string;
  installation_id: number;
  /** Full "owner/repo" name, e.g. "acmecorp/api-service" */
  repo_full_name: string;
  /** GitHub's numeric repo ID. Used for fast webhook lookups. */
  repo_id: number;
  created_by: string | null;
  created_at: string;
  /** Current state of default-branch file indexing for this repository. */
  file_sync_status:
    | 'pending'
    | 'syncing'
    | 'partial'
    | 'synced'
    | 'cancelled'
    | 'error';
  /** False after an admin cancels indexing; PR capture remains active. */
  file_indexing_enabled: boolean;
  /** Active repository-file documents currently searchable in Bread. */
  indexed_file_count: number;
  /** Selected files still waiting for a successful ingest pass. */
  pending_file_count: number;
  /** Files excluded by safety/type/size limits or detected as binary. */
  skipped_file_count: number;
  /** Files that failed during the most recent sync attempt. */
  failed_file_count: number;
  last_file_sync_commit_sha: string | null;
  last_file_sync_at: string | null;
  /** Safe user-facing summary; raw provider errors remain server-side only. */
  last_file_sync_error: string | null;
  file_tree_truncated: boolean;
}

/**
 * One bidirectional Markdown/MDX link for a workspace. This is deliberately
 * separate from MonitoredRepoRow: linking docs does not enable full-repository
 * file indexing or PR capture.
 */
export interface GitHubHostedDocsSourceRow {
  id: string;
  workspace_id: string;
  installation_id: number;
  repo_full_name: string;
  repo_id: number;
  paths: string[];
  root_folder_id: string | null;
  sync_status: 'disabled' | 'pending' | 'syncing' | 'synced' | 'error';
  document_count: number;
  conflict_count: number;
  last_sync_commit_sha: string | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
  /** Pull request whose merge activates a Bread-authored root. */
  pending_pull_request_number: number | null;
  pending_pull_request_url: string | null;
  pending_pull_request_head: string | null;
  /** Open ongoing workspace publish PR. Kept separate from activation state. */
  publish_pull_request_number: number | null;
  publish_pull_request_url: string | null;
  publish_pull_request_head: string | null;
  publish_last_commit_sha: string | null;
  publish_operation_id: string | null;
  publish_operation_started_at: string | null;
  /** One-shot reconciliation applied after the activation PR merges. */
  pending_sync_mode: 'merge' | 'replace_bread';
  /**
   * Repository layout. 'bread' is the strict Bread frontmatter format;
   * 'readme' is the layout ReadMe's GitHub integration reads and writes.
   * Absent on rows read before the column existed; treat as 'bread'.
   */
  format?: 'bread' | 'readme';
  /** How workspace edits reach GitHub. 'direct' commits to the synced branch. */
  publish_mode?: 'pull_request' | 'direct';
  /** Synced branch; null means the repository default branch. */
  branch?: string | null;
  /** Format-specific state recorded by the last sync. */
  sync_state?: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One row per tracked PR. Created on the first webhook event for a PR.
 * Uses replace mode: every ingest rebuilds the document set from the current
 * full PR state (analogous to Slack auto sessions).
 */
export interface GitHubPRSessionRow {
  id: string;
  workspace_id: string;
  installation_id: number;
  repo_full_name: string;
  repo_id: number;
  pr_number: number;
  pr_title: string | null;
  pr_author_login: string | null;
  status: 'active' | 'closed' | 'error';
  doc_count: number;
  /** IDs of currently live documents for this PR. Replaced on each ingest. */
  document_ids: string[];
  /** Timestamp of the most recent webhook event for this PR. */
  last_activity_at: string | null;
  /** Timestamp of the last completed successful ingest run. */
  last_ingested_at: string | null;
  /** Timestamp of the last failed ingest attempt, used for bounded retry backoff. */
  last_attempted_at?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Maps a GitHub username to a Bread user within a workspace.
 * Used during ingest to attribute captured PR content to the correct user_id.
 * Each Bread user may link exactly one GitHub account per workspace.
 */
export interface GitHubUserLinkRow {
  id: string;
  workspace_id: string;
  user_id: string;
  /** GitHub username (login), e.g. "ben-li" */
  github_login: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardActivity {
  id: string;
  title: string;
  source: string;
  author: string | null;
  updated_at: string;
}

export interface DashboardStats {
  total_documents: number;
  freshness_percent: number;
  documents_by_source: Record<string, number>;
  recent_activity: DashboardActivity[];
  pending_review_count: number;
  // Unsynthesized capture buffer depth — captures that have landed but the
  // librarian sweep hasn't consolidated yet. Distinct from
  // pending_review_count (which counts already-produced proposals + flagged
  // docs); this exposes "stuff is in the pipe" before a proposal exists.
  unsynthesized_captures_count: number;
}

// ---------------------------------------------------------------------------
// Legacy ingestion-logs types
// ---------------------------------------------------------------------------
// The sweep pipeline (captures + ingest_proposals) has replaced smart-ingest,
// but the legacy ingestion_logs table still backs the dashboard's recent-log
// list. These types describe rows from that table; they are retained until
// the dashboard stops reading from `ingestion_logs`.

export type IngestionAction = "DUPLICATE" | "NOVEL" | "UPDATE";

export interface IngestionLogRow {
  id: string;
  workspace_id: string;
  action: IngestionAction;
  confidence: number;
  reasoning: string;
  incoming_title: string | null;
  incoming_source: string | null;
  target_document_id: string | null;
  flagged_for_review: boolean;
  created_at: string;
}

export interface IngestionLogDetailRow extends IngestionLogRow {
  incoming_content: string | null;
  raw_content: string | null;
}

// ---------------------------------------------------------------------------
// Folders & Topics (unified)
// ---------------------------------------------------------------------------

export type FolderKind = 'user' | 'topic' | 'system';

export type FolderVisibility = "workspace" | "team" | "role";

export interface FolderRow {
  id: string;
  workspace_id: string;
  name: string;
  display_name: string;
  kind: FolderKind;
  parent_folder_id: string | null;
  visibility: FolderVisibility;
  team_id: string | null;
  required_role: WorkspaceRole | null;
  embedding: number[] | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

// Read-only projection from the folder_stats view.
export interface FolderWithCount {
  folder_id: string;
  workspace_id: string;
  kind: FolderKind;
  name: string;
  display_name: string;
  parent_folder_id: string | null;
  visibility: FolderVisibility;
  team_id: string | null;
  required_role: WorkspaceRole | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  document_count: number;
}

export interface DocumentFolderRow {
  id: string;
  document_id: string;
  folder_id: string;
  created_at: string;
}

// A retired/merged topic name mapped to its canonical topic folder. Written on
// rename + merge; read by the sweep's resolveTopicFolders() so human topic edits
// survive future sweeps that re-emit an old name.
export interface TopicAliasRow {
  id: string;
  workspace_id: string;
  alias_name: string;
  canonical_folder_id: string;
  created_at: string;
}

export interface SynthesisSourceRow {
  id: string;
  synthesis_id: string;
  source_id: string;
  created_at: string;
}

export interface TopicPageContent {
  title: string;
  content: string;  // full markdown body
  summary: string;  // 1-2 sentence synopsis
}

// ---------------------------------------------------------------------------
// Integration Hardening — webhook dedup and OAuth state
// ---------------------------------------------------------------------------

export type WebhookSource = "github" | "slack" | "instagram";

export interface WebhookDeliveryRow {
  source: WebhookSource;
  event_id: string;
  received_at: string;
}

export interface SlackOAuthStateRow {
  state: string;
  workspace_id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Artifact types (for the librarian sweep, L6)
// ---------------------------------------------------------------------------
// The sweep pipeline emits `create_document` ops that are one of these
// artifact types. `notes` is the default fallback type for content that
// doesn't cleanly fit runbook/decision/postmortem.
//
// The legacy `smart-ingest` pipeline does not tag documents with artifact
// types — it writes plain docs. Documents created before this refactor have
// no artifact_type column (see `documents` schema); the sweep persists the
// artifact_type as a frontmatter slot inside `content` rather than adding a
// new column.

export type ArtifactType =
  | "runbook"
  | "decision"
  | "postmortem"
  | "untyped_capture"
  | "notes";

// ---------------------------------------------------------------------------
// Capture Buffer + Librarian Sweep (L1–L10)
// ---------------------------------------------------------------------------
// Two-tier ingestion: raw captures land in `captures` (immutable), and the
// sweep agent reads unsynthesized ones and emits an `ingest_proposals` row
// with per-op review. Commit mutates three slots on captures — synthesized_at,
// synthesis_proposal_id, consolidated_into_document_id — plus `is_noise` for
// mark_noise. Nothing else ever changes.

/**
 * Known capture ingress sources. A stable string is safer to compare against
 * than a free-form enum — open it up by editing this list.
 */
export type CaptureSourceKind =
  | "api"
  // Historical values retained so existing capture rows remain readable.
  | "cli"
  | "mcp"
  | "web_manual"
  | "waterfall"
  | "slack"
  | "github"
  | "linear"
  | "granola"
  | "google_drive"
  | "import";

export interface CaptureRow {
  id: string;
  workspace_id: string;
  source_kind: CaptureSourceKind | string;
  source_ref: string | null;
  raw_content: string;
  content_hash: string;
  content_type: string | null;
  author_user_id: string | null;
  metadata: Record<string, unknown>;
  embedding: number[] | null;
  captured_at: string;
  /** Set once by the sweep commit path. Otherwise null. */
  synthesized_at: string | null;
  /** Set once by the sweep commit path. Otherwise null. */
  synthesis_proposal_id: string | null;
  /** The doc this capture was consolidated into. Null for noise or
   *  pre-commit rows. */
  consolidated_into_document_id: string | null;
  /** Mark-noise captures stay in the table but are excluded from default
   *  semantic retrieval (L10). */
  is_noise: boolean;
}

/**
 * Trigger kinds for a sweep run. Manual = a user clicked "Organize"; count =
 * the unsynthesized-count threshold tripped; stale = cron flipped an
 * abandoned pending row to rejected.
 */
export type IngestProposalTriggerKind = "manual" | "count" | "stale_cleanup";

/**
 * Lifecycle statuses for a sweep proposal. `committed` = every op was
 * accepted; `committed_partial` = a subset was accepted OR some ops drifted
 * against the corpus and had to skip.
 */
export type IngestProposalStatus =
  | "pending"
  | "committed"
  | "committed_partial"
  | "rejected";

/**
 * Ops the sweep agent can emit. Zod-validated in
 * apps/web/app/src/lib/sweep/ops.ts — the shape here mirrors those schemas.
 */
export type SweepOp =
  | {
      kind: "create_document";
      capture_ids: string[];
      title: string;
      content: string;
      artifact_type: ArtifactType;
      folder:
        | { kind: "new"; name: string }
        | { kind: "existing"; folder_id: string }
        | { kind: "none" };
      topics: string[];
    }
  | {
      kind: "update_document";
      capture_ids: string[];
      document_id: string;
      /** Hash of the document content the sweep observed. Commit checks
       *  against the current hash to detect drift. */
      base_content_hash: string;
      merged_content: string;
      title?: string;
      topics?: string[];
    }
  | {
      kind: "link_documents";
      source_document_id: string;
      target_document_id: string;
      strength: "related" | "supersedes" | "duplicate_of";
      rationale?: string;
      /** link_documents never consumes captures — empty list carried for
       *  symmetry with the other op shapes. */
      capture_ids: string[];
    }
  | {
      kind: "mark_noise";
      capture_ids: string[];
      reason: string;
    };

export interface IngestProposalRow {
  id: string;
  workspace_id: string;
  triggered_by: string | null;
  trigger_kind: IngestProposalTriggerKind | string;
  status: IngestProposalStatus;
  heartbeat_at: string;
  input_capture_ids: string[];
  input_corpus_doc_ids: string[];
  ops: SweepOp[];
  rationale: string | null;
  model_used: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  /** Generated column: jsonb_array_length(ops). */
  op_count: number;
  ops_accepted_count: number;
  ops_rejected_count: number;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
}

export type DocumentLinkStrength = "related" | "supersedes" | "duplicate_of";

export interface DocumentLinkRow {
  id: string;
  workspace_id: string;
  source_document_id: string;
  target_document_id: string;
  strength: DocumentLinkStrength | string;
  created_by_proposal_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Integration Sources — Granola + bulk imports (Notion / Confluence / Obsidian)
// See docs/engineering/integrations/integration-sources-plan.md §4
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scheduled auto-ingestion — shared contract.
//
// A per-workspace, opt-in toggle + cadence for the poll-based integrations
// whose ingestion is a background time-window pull. The cron sync-all worker
// pulls new items at most once per `auto_ingest_period_seconds` per workspace,
// and only when the workspace is on a Business/Enterprise plan. Slack keeps
// on-demand capture event-driven while optionally polling only explicitly
// monitored channels. GitHub webhooks remain real-time and have no configurable
// polling period.
// ---------------------------------------------------------------------------

/**
 * Integrations that support scheduled auto-ingestion. Linear/Granola/Google
 * Drive poll the whole source; Slack polls only admin-designated channels
 * (see SlackMonitoredChannelRow).
 */
export type AutoIngestProvider = "linear" | "granola" | "google_drive" | "slack";

/** Cadence floor: 1 hour. Enforced in the API and as a DB check constraint. */
export const AUTO_INGEST_PERIOD_MIN_SECONDS = 3600;
/** Cadence ceiling: 30 days. */
export const AUTO_INGEST_PERIOD_MAX_SECONDS = 2592000;
/** Default cadence: 1 day. */
export const AUTO_INGEST_DEFAULT_PERIOD_SECONDS = 86400;

/** The mutable per-integration auto-ingestion settings (subset of each *IntegrationRow). */
export interface AutoIngestConfig {
  auto_ingest_enabled: boolean;
  auto_ingest_period_seconds: number;
}

export interface GranolaIntegrationRow {
  id: string;
  workspace_id: string;
  /** Base64-encoded pgsodium ciphertext; null when revoked. */
  api_key_encrypted: string | null;
  api_key_last_four: string;
  connected_by: string | null;
  last_synced_at: string | null;
  last_sync_created_after: string | null;
  last_sync_attempt_at: string | null;
  /** Scheduled auto-ingestion opt-in (Business/Enterprise). @see AutoIngestConfig */
  auto_ingest_enabled: boolean;
  auto_ingest_period_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface GranolaSyncedMeetingRow {
  workspace_id: string;
  granola_meeting_id: string;
  document_id: string;
  meeting_started_at: string | null;
  last_synced_at: string;
}

// ---------------------------------------------------------------------------
// Linear integration — per-workspace PAT + incremental issue sync.
// ---------------------------------------------------------------------------

export interface LinearIntegrationRow {
  id: string;
  workspace_id: string;
  /** Base64-encoded pgsodium ciphertext; null when revoked. */
  api_key_encrypted: string | null;
  api_key_last_four: string;
  linear_org_id: string | null;
  linear_org_name: string | null;
  connected_by: string | null;
  last_synced_at: string | null;
  last_sync_updated_after: string | null;
  last_sync_attempt_at: string | null;
  /** Scheduled auto-ingestion opt-in (Business/Enterprise). @see AutoIngestConfig */
  auto_ingest_enabled: boolean;
  auto_ingest_period_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface LinearSyncedIssueRow {
  workspace_id: string;
  linear_issue_id: string;
  document_id: string;
  issue_updated_at: string | null;
  last_synced_at: string;
}

// ---------------------------------------------------------------------------
// Google Drive integration — workspace OAuth + incremental file sync.
// ---------------------------------------------------------------------------

export interface GoogleDriveIntegrationRow {
  id: string;
  workspace_id: string;
  google_user_id: string | null;
  google_email: string | null;
  /** Base64 pgsodium ciphertexts; null when revoked or never minted. */
  refresh_token_encrypted: string | null;
  access_token_encrypted: string | null;
  access_token_expires_at: string | null;
  scopes: string[];
  root_folder_id: string | null;
  root_folder_name: string | null;
  connected_by: string | null;
  last_synced_at: string | null;
  last_sync_modified_after: string | null;
  last_sync_attempt_at: string | null;
  /** Scheduled auto-ingestion opt-in (Business/Enterprise). @see AutoIngestConfig */
  auto_ingest_enabled: boolean;
  auto_ingest_period_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface GoogleDriveSyncedFileRow {
  workspace_id: string;
  drive_file_id: string;
  document_id: string;
  drive_mime_type: string | null;
  file_modified_at: string | null;
  last_synced_at: string;
}

// ---------------------------------------------------------------------------
// Cloudflare portal connector — workspace OAuth + per-domain deployments.
// ---------------------------------------------------------------------------

export interface CloudflareConnectionRow {
  workspace_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  scopes: string[];
  connected_by: string | null;
  created_at: string;
  updated_at: string;
}

export type CloudflareDeploymentStatus =
  | "pending"
  | "deploying"
  | "connected"
  | "error";

export interface CloudflarePortalDeploymentRow {
  id: string;
  workspace_id: string;
  domain: string;
  account_id: string | null;
  zone_id: string | null;
  zone_name: string | null;
  script_name: string | null;
  routes: Record<string, string>;
  status: CloudflareDeploymentStatus;
  last_error: string | null;
  deployed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ImportSource = "notion" | "confluence" | "obsidian" | "website";

export type ImportJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ImportItemStatus = "pending" | "succeeded" | "failed" | "skipped";

export interface ImportJobRow {
  id: string;
  workspace_id: string;
  source: ImportSource;
  status: ImportJobStatus;
  total_items: number;
  processed_items: number;
  succeeded_items: number;
  failed_items: number;
  skipped_items: number;
  error_message: string | null;
  started_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  source_config: Record<string, unknown>;
}

export interface ImportJobItemRow {
  id: string;
  job_id: string;
  source_ref: string;
  title: string | null;
  status: ImportItemStatus;
  document_id: string | null;
  error_message: string | null;
  processed_at: string | null;
}

export type DocumentSource =
  | "cli"
  | "slack"
  | "github"
  | "granola"
  | "notion"
  | "confluence"
  | "obsidian"
  | "Import";

export interface GranolaSourceMetadata {
  granola_meeting_id: string;
  url: string;
  attendees: string[];
  started_at: string;
}

export interface BulkImportSourceMetadata {
  source_ref: string;
  url: string | null;
  job_id: string;
}

// ---------------------------------------------------------------------------
// Portal links
// ---------------------------------------------------------------------------

/**
 * Default public-KB portal slugs for Bread's own dogfooded vanity routes.
 * `docs` is a workspace slug; `help` is a published help_center PROJECT slug
 * nested beneath that workspace. Override per-environment via the
 * NEXT_PUBLIC_BREAD_{DOCS,HELP}_SLUG env vars at the call site.
 */
export const BREAD_PORTAL_SLUGS = {
  docs: "bread",
  help: "help",
} as const;

export type BreadPortalKey = keyof typeof BREAD_PORTAL_SLUGS;

export interface PortalUrlOptions {
  /** Origin to prefix, e.g. "https://app.example.com". Omit for a root-relative path. */
  appUrl?: string;
  /** Sub-path under the portal, e.g. "doc/abc" or a Next route pattern ":path*". */
  subpath?: string;
}

/**
 * Build the canonical public URL (or root-relative path) for a KB portal by
 * slug. Single source of truth for the `/p/<slug>` shape so callers (Next
 * redirects, link builders, the app) never hardcode the prefix.
 *
 *   portalUrl("help")                                         // "/p/help"
 *   portalUrl("bread", { appUrl: "https://app.example.com" })  // "https://app.example.com/p/bread"
 *   portalUrl("bread", { appUrl, subpath: ":path*" })        // ".../p/bread/:path*"
 */
export function portalUrl(slug: string, options: PortalUrlOptions = {}): string {
  const origin = options.appUrl ? options.appUrl.replace(/\/+$/, "") : "";
  const sub = options.subpath ? `/${options.subpath.replace(/^\/+/, "")}` : "";
  return `${origin}/p/${slug}${sub}`;
}
