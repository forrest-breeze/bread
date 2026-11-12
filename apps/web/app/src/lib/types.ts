export type {
  OwnedWorkspaceSummary,
  ProfileRow,
  ProfileResponse,
  WorkspaceRow,
  WorkspaceRole,
  InviteLinkRow,
  TeamMember,
  SubscriptionPlanId,
  SubscriptionBillingInterval,
  SubscriptionTier,
  SubscriptionStatus,
  SubscriptionRow,
  DashboardActivity,
  DashboardStats,
  TopicAliasRow,
} from "@bread/core";

// ---------------------------------------------------------------------------
// Topic taxonomy — merge result returned by the merge_topic_folders RPC and
// surfaced by POST /api/folders/merge (and by PATCH /api/folders/[id] when a
// rename collides with an existing topic and is treated as a merge).
// ---------------------------------------------------------------------------
export interface TopicMergeResult {
  target_id: string;
  sources_merged: number;
  memberships_repointed: number;
  pins_repointed: number;
  topic_pages_deleted: number;
  aliases_written: number;
}

// ---------------------------------------------------------------------------
// Folder detail — response shape for GET /api/folders/[id]
// Used by the Confluence-style per-folder page.
// ---------------------------------------------------------------------------
export type FolderKind = "user" | "topic" | "system";

export type FolderVisibility = "workspace" | "role";

export type WorkspaceMemberRole =
  | "owner"
  | "admin"
  | "editor"
  | "viewer"
  | "agent-only";

export interface FolderVisibilityFields {
  visibility: FolderVisibility;
  required_role: WorkspaceMemberRole | null;
}

export interface FolderSummary extends FolderVisibilityFields {
  id: string;
  name: string;
  display_name: string;
  kind: FolderKind;
  parent_folder_id: string | null;
  document_count: number;
  sort_order: number | null;
  icon: string | null;
  last_seen_at: string;
  updated_at: string;
}

export interface FolderDocumentSummary {
  id: string;
  title: string;
  source: string;
  author: string;
  updated_at: string;
}

export interface FolderDetailResponse {
  folder: FolderVisibilityFields & {
    id: string;
    name: string;
    display_name: string;
    kind: FolderKind;
    parent_folder_id: string | null;
    content: string | null;
    sort_order?: number | null;
    icon?: string | null;
    last_seen_at: string;
    created_at: string;
    updated_at: string;
  };
  ancestors: Array<{ id: string; name: string; display_name: string }>;
  children: FolderSummary[];
  documents: FolderDocumentSummary[];
}

// ---------------------------------------------------------------------------
// Document cross-links — response shape for GET /api/documents/[id]/links
// ---------------------------------------------------------------------------
// document_links rows are created exclusively by the sweep agent (L5). The
// read portal surfaces them in two directions: `outbound` (this document points
// at another) and `inbound` ("referenced by" — another document points here).
// Entries are already filtered to documents the caller can see (folder RLS).
export type DocumentLinkStrength = "related" | "supersedes" | "duplicate_of";

export interface DocumentLinkEntry {
  id: string;
  /**
   * Human-readable URL slug for the public KB portal (public_slug). Falls back
   * to `id` when unset. Optional so non-portal producers of this shape (e.g. the
   * in-app document links API) need not supply it.
   */
  slug?: string;
  title: string;
  source: string | null;
  document_type: string;
  strength: DocumentLinkStrength;
}

export interface DocumentLinksResponse {
  outbound: DocumentLinkEntry[];
  inbound: DocumentLinkEntry[];
}

// ---------------------------------------------------------------------------
// Message feedback — thumbs up/down on an Agent (assistant) reply.
// POST/DELETE /api/conversations/[id]/feedback
// ---------------------------------------------------------------------------
export type MessageFeedbackRating = "up" | "down";

export type MessageFeedbackReason =
  | "inaccurate"
  | "not_from_sources"
  | "incomplete"
  | "wrong_tone"
  | "other";

export interface MessageFeedbackResponse {
  feedback: {
    id: string;
    rating: MessageFeedbackRating;
    reason: MessageFeedbackReason | null;
    comment: string | null;
  };
}

// ---------------------------------------------------------------------------
// Media objects — large binary assets (image/video/audio) offloaded to S3.
// One row per asset; the bytes live in the object store, this is the pointer.
// See lib/storage/{s3,blob-store,media}.ts and the media_objects table.
// ---------------------------------------------------------------------------
export type MediaObjectKind = "image" | "video" | "audio" | "file";

export interface MediaObject {
  id: string;
  workspaceId: string;
  captureId: string | null;
  /** S3 object key — resolve to a URL via getSignedReadUrl / publicUrlFor. */
  storageKey: string;
  kind: MediaObjectKind;
  mime: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  contentHash: string;
  createdBy: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Workflows — node-graph recipes triggered by Slack or GitHub events
// ---------------------------------------------------------------------------
// Shared shapes live in `@bread/core`; re-exported here so web code can keep
// importing from `@/lib/types` without reaching into the monorepo package.
export type {
  WorkflowTriggerType,
  WorkflowNodeKind,
  WorkflowNode,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowSummary,
  Workflow,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  WorkflowRunStatus,
  WorkflowRun,
  WorkflowRunStep,
} from "@bread/core";

// ---------------------------------------------------------------------------
// What's new — the in-app feed of Bread's own public changelog portal
// (served by /api/whats-new, rendered in the dashboard top bar).
// ---------------------------------------------------------------------------
export interface WhatsNewEntry {
  id: string;
  title: string;
  /** ISO timestamp of the entry (the changelog doc's last update). */
  date: string | null;
  /** Public portal URL of the entry document. */
  href: string;
}

export interface WhatsNewResponse {
  entries: WhatsNewEntry[];
  /** Public URL of the changelog portal home, null when unresolved. */
  portalHref: string | null;
}

// ---------------------------------------------------------------------------
// Onboarding checklist — completion signals for the "Things to do" menu
// (served by /api/dashboard/checklist, rendered in the dashboard top bar).
// Each flag reflects a real user action, not a side effect of onboarding
// seeding (starter docs, website crawl, default portal publish).
// ---------------------------------------------------------------------------
export interface OnboardingChecklistStatus {
  /** Any integration (Slack, GitHub, Linear, Google Drive, Granola) is connected. */
  integration_connected: boolean;
  /** The workspace has a capture or a document the user created themselves. */
  knowledge_captured: boolean;
  /** The user has at least one agent conversation in this workspace. */
  agent_used: boolean;
  /** The user has minted a personal access token for MCP or another AI tool. */
  ai_tool_connected: boolean;
  /** A portal version beyond onboarding's default publish has been published. */
  portal_published: boolean;
  /** Someone besides the owner has joined the workspace. */
  teammate_joined: boolean;
}
