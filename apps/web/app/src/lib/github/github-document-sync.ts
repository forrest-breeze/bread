import { createAdminClient } from "@/lib/supabase/admin"
import {
  createOrUpdateRepositoryFile,
  createRepositoryBranch,
  createRepositoryPullRequest,
  findOpenRepositoryPullRequest,
  getInstallationToken,
  getRepositoryBranchReference,
  getRepositoryCommit,
  getRepositoryFile,
  listRepositoryFileCommits,
  type GitHubRepositoryFile,
} from "@/lib/github/github"
import { withGitHubRetry } from "@/lib/github/retry"
import {
  mergeTextThreeWay,
  type ThreeWayMergeConflict,
} from "@/lib/github/text-three-way-merge"
import { validateBreezifyHostedDocument } from "@/lib/github/github-hosted-format"
import type {
  GitHubDocumentEditSessionRow,
  GitHubDocumentEditSessionStatus,
  GitHubFileCommit,
} from "@breezify/core"

const ACTIVE_SESSION_STATUSES: GitHubDocumentEditSessionStatus[] = [
  "draft",
  "publishing",
  "open",
  "conflict",
  "error",
]
const MAX_EDITABLE_FILE_BYTES = 2_000_000
const EDITABLE_DOCUMENT_PATTERN = /\.(?:md|mdx|markdown|mdoc)$/i

interface RepositorySourceMetadata {
  kind: "repository_file"
  repo_id: number
  repo_full_name: string
  path: string
  ref: string
  commit_sha: string
  blob_sha: string
  url?: string
}

interface RepositoryDocumentContext {
  document: {
    id: string
    title: string
    workspace_id: string
    source_metadata: RepositorySourceMetadata
  }
  installationId: number
  token: string
  hostedDocsRoot: string | null
}

export interface GitHubDocumentSessionView {
  id: string
  document_id: string
  repo_full_name: string
  file_path: string
  deploy_branch: string
  branch_name: string
  draft_content: string
  draft_revision: number
  status: GitHubDocumentEditSessionStatus
  last_commit_sha: string | null
  pr_number: number | null
  pr_url: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface GitHubDocumentState {
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
  session: GitHubDocumentSessionView | null
  behind_deployment: boolean
  editor_path: string
}

export type PublishGitHubDocumentResult =
  | {
      ok: true
      session: GitHubDocumentSessionView
      commit_sha: string
      commit_url: string | null
      auto_merged: boolean
    }
  | {
      ok: false
      kind: "conflict"
      conflicts: ThreeWayMergeConflict[]
      session: GitHubDocumentSessionView
    }

export class GitHubDocumentSyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = "GitHubDocumentSyncError"
  }
}

export class GitHubDraftRevisionError extends GitHubDocumentSyncError {
  constructor(readonly current: GitHubDocumentSessionView) {
    super(
      "This draft changed in another editor. Review the latest version before saving.",
      409,
      "draft_revision_conflict",
    )
  }
}

function metadataFrom(value: unknown): RepositorySourceMetadata | null {
  if (!value || typeof value !== "object") return null
  const metadata = value as Record<string, unknown>
  if (
    metadata.kind !== "repository_file" ||
    typeof metadata.repo_id !== "number" ||
    typeof metadata.repo_full_name !== "string" ||
    typeof metadata.path !== "string" ||
    typeof metadata.ref !== "string" ||
    typeof metadata.commit_sha !== "string" ||
    typeof metadata.blob_sha !== "string"
  ) {
    return null
  }
  return metadata as unknown as RepositorySourceMetadata
}

export function isEditableGitHubDocumentPath(path: string): boolean {
  return EDITABLE_DOCUMENT_PATTERN.test(path)
}

function decodeFile(file: GitHubRepositoryFile): string {
  if (file.size > MAX_EDITABLE_FILE_BYTES) {
    throw new GitHubDocumentSyncError(
      "This file is too large for collaborative editing.",
      413,
      "file_too_large",
    )
  }
  if (file.encoding !== "base64") {
    throw new GitHubDocumentSyncError(
      "GitHub did not return editable text for this file.",
      422,
      "unsupported_file_encoding",
    )
  }
  const decoded = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString(
    "utf8",
  )
  if (decoded.includes("\u0000")) {
    throw new GitHubDocumentSyncError(
      "Binary files cannot be edited in the documentation editor.",
      422,
      "binary_file",
    )
  }
  return decoded.replace(/\r\n?/g, "\n")
}

function sessionView(
  session: GitHubDocumentEditSessionRow,
): GitHubDocumentSessionView {
  return {
    id: session.id,
    document_id: session.document_id,
    repo_full_name: session.repo_full_name,
    file_path: session.file_path,
    deploy_branch: session.deploy_branch,
    branch_name: session.branch_name,
    draft_content: session.draft_content,
    draft_revision: session.draft_revision,
    status: session.status,
    last_commit_sha: session.last_commit_sha,
    pr_number: session.pr_number,
    pr_url: session.pr_url,
    last_error: session.last_error,
    created_at: session.created_at,
    updated_at: session.updated_at,
  }
}

async function loadContext(
  workspaceId: string,
  documentId: string,
): Promise<RepositoryDocumentContext> {
  const admin = createAdminClient()
  const { data: document, error: documentError } = await admin
    .from("documents")
    .select("id, title, workspace_id, source, source_metadata, deleted_at")
    .eq("id", documentId)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .maybeSingle()

  if (documentError) {
    throw new GitHubDocumentSyncError(
      "Could not load the repository document.",
      500,
      "document_lookup_failed",
    )
  }
  const metadata = metadataFrom(document?.source_metadata)
  if (!document || document.source !== "GitHub" || !metadata) {
    throw new GitHubDocumentSyncError(
      "This document is not backed by a GitHub repository file.",
      404,
      "not_repository_document",
    )
  }

  const [monitoredResult, hostedResult] = await Promise.all([
    admin
      .from("monitored_repos")
      .select("installation_id")
      .eq("workspace_id", workspaceId)
      .eq("repo_id", metadata.repo_id)
      .maybeSingle(),
    admin
      .from("github_hosted_docs_sources")
      .select("installation_id, paths")
      .eq("workspace_id", workspaceId)
      .eq("repo_id", metadata.repo_id)
      .maybeSingle(),
  ])
  const connection = monitoredResult.data ?? hostedResult.data
  if (monitoredResult.error || hostedResult.error || !connection) {
    throw new GitHubDocumentSyncError(
      "The repository is no longer connected to this workspace.",
      409,
      "repository_not_connected",
    )
  }

  const installationId = Number(connection.installation_id)
  const hostedPaths = Array.isArray(hostedResult.data?.paths)
    ? hostedResult.data.paths.filter(
        (value): value is string => typeof value === "string",
      )
    : []
  const hostedDocsRoot =
    hostedPaths.find(
      (root) => metadata.path === root || metadata.path.startsWith(`${root}/`),
    ) ?? null
  const token = await withGitHubRetry(() => getInstallationToken(installationId))
  return {
    document: {
      id: document.id,
      title: document.title,
      workspace_id: document.workspace_id,
      source_metadata: metadata,
    },
    installationId,
    token,
    hostedDocsRoot,
  }
}

async function loadActiveSession(
  workspaceId: string,
  documentId: string,
): Promise<GitHubDocumentEditSessionRow | null> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("github_document_edit_sessions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("document_id", documentId)
    .in("status", ACTIVE_SESSION_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new GitHubDocumentSyncError(
      "Could not load the GitHub editing session.",
      500,
      "session_lookup_failed",
    )
  }
  return data as GitHubDocumentEditSessionRow | null
}

async function loadDeploymentFile(
  context: RepositoryDocumentContext,
): Promise<{
  commitSha: string
  file: GitHubRepositoryFile
  content: string
}> {
  const metadata = context.document.source_metadata
  const [commit, file] = await Promise.all([
    withGitHubRetry(() =>
      getRepositoryCommit(
        context.token,
        metadata.repo_full_name,
        metadata.ref,
      ),
    ),
    withGitHubRetry(() =>
      getRepositoryFile(
        context.token,
        metadata.repo_full_name,
        metadata.path,
        metadata.ref,
      ),
    ),
  ])
  return { commitSha: commit.sha, file, content: decodeFile(file) }
}

function branchSlug(path: string): string {
  const slug = path
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-42)
  return slug || "docs"
}

function makeBranchName(path: string): string {
  return `breezify/${branchSlug(path)}-${crypto.randomUUID().slice(0, 8)}`
}

export async function getGitHubDocumentState(
  workspaceId: string,
  documentId: string,
): Promise<GitHubDocumentState> {
  const context = await loadContext(workspaceId, documentId)
  const [deployment, session] = await Promise.all([
    loadDeploymentFile(context),
    loadActiveSession(workspaceId, documentId),
  ])
  const metadata = context.document.source_metadata
  return {
    editable: isEditableGitHubDocumentPath(metadata.path),
    repository: {
      repo_id: metadata.repo_id,
      repo_full_name: metadata.repo_full_name,
      file_path: metadata.path,
      deploy_branch: metadata.ref,
      commit_sha: deployment.commitSha,
      blob_sha: deployment.file.sha,
      html_url: deployment.file.html_url,
    },
    repository_content: deployment.content,
    session: session ? sessionView(session) : null,
    behind_deployment: Boolean(
      session && session.deploy_blob_sha !== deployment.file.sha,
    ),
    editor_path: `/knowledge/${documentId}`,
  }
}

export async function checkoutGitHubDocument(
  workspaceId: string,
  documentId: string,
  createdBy: string | null,
  initialContent?: string,
  options?: { rejectExistingDraft?: boolean },
): Promise<GitHubDocumentSessionView> {
  const existing = await loadActiveSession(workspaceId, documentId)
  if (existing) {
    if (options?.rejectExistingDraft) {
      throw new GitHubDocumentSyncError(
        "A shared GitHub draft already exists for this file. Open it and resolve that draft before replacing it from Breezify.",
        409,
        "active_session_exists",
      )
    }
    return sessionView(existing)
  }

  const context = await loadContext(workspaceId, documentId)
  const metadata = context.document.source_metadata
  if (!isEditableGitHubDocumentPath(metadata.path)) {
    throw new GitHubDocumentSyncError(
      "Only Markdown and MDX repository files can be edited visually.",
      422,
      "unsupported_file_type",
    )
  }
  const deployment = await loadDeploymentFile(context)
  const draftContent = initialContent ?? deployment.content
  if (Buffer.byteLength(draftContent, "utf8") > MAX_EDITABLE_FILE_BYTES) {
    throw new GitHubDocumentSyncError(
      "This draft is too large for collaborative editing.",
      413,
      "draft_too_large",
    )
  }

  const admin = createAdminClient()
  const insert = {
    workspace_id: workspaceId,
    document_id: documentId,
    installation_id: context.installationId,
    repo_id: metadata.repo_id,
    repo_full_name: metadata.repo_full_name,
    file_path: metadata.path,
    deploy_branch: metadata.ref,
    branch_name: makeBranchName(metadata.path),
    deploy_commit_sha: deployment.commitSha,
    deploy_blob_sha: deployment.file.sha,
    deploy_base_content: deployment.content,
    base_commit_sha: deployment.commitSha,
    base_blob_sha: deployment.file.sha,
    base_content: deployment.content,
    draft_content: draftContent,
    created_by: createdBy,
  }
  const { data, error } = await admin
    .from("github_document_edit_sessions")
    .insert(insert)
    .select("*")
    .single()
  if (error) {
    // A browser and MCP agent can checkout at the same time. The partial
    // unique index makes one win; both should join the same shared session.
    const raced = await loadActiveSession(workspaceId, documentId)
    if (raced) {
      if (options?.rejectExistingDraft) {
        throw new GitHubDocumentSyncError(
          "A shared GitHub draft was created while this Breezify version was being prepared. Open it and resolve that draft first.",
          409,
          "active_session_exists",
        )
      }
      return sessionView(raced)
    }
    throw new GitHubDocumentSyncError(
      "Could not start the GitHub editing session.",
      500,
      "session_create_failed",
    )
  }
  return sessionView(data as GitHubDocumentEditSessionRow)
}

export async function saveGitHubDocumentDraft(
  workspaceId: string,
  documentId: string,
  args: {
    content: string
    createdBy: string | null
    expectedRevision?: number
  },
): Promise<GitHubDocumentSessionView> {
  if (Buffer.byteLength(args.content, "utf8") > MAX_EDITABLE_FILE_BYTES) {
    throw new GitHubDocumentSyncError(
      "This draft is too large for collaborative editing.",
      413,
      "draft_too_large",
    )
  }

  let session = await loadActiveSession(workspaceId, documentId)
  if (!session) {
    await checkoutGitHubDocument(
      workspaceId,
      documentId,
      args.createdBy,
      args.content,
    )
    session = await loadActiveSession(workspaceId, documentId)
  }
  if (!session) {
    throw new GitHubDocumentSyncError(
      "Could not load the new GitHub editing session.",
      500,
      "session_create_failed",
    )
  }
  if (
    args.expectedRevision !== undefined &&
    args.expectedRevision !== session.draft_revision
  ) {
    throw new GitHubDraftRevisionError(sessionView(session))
  }
  if (session.status === "publishing") {
    throw new GitHubDocumentSyncError(
      "This draft is currently publishing. Wait for it to finish, then save again.",
      409,
      "publish_in_progress",
    )
  }

  const resolvingConflict = session.status === "conflict"
  if (session.draft_content === args.content && !resolvingConflict) {
    return sessionView(session)
  }

  let conflictBaseUpdate: Record<string, string> = {}
  if (resolvingConflict) {
    const context = await loadContext(workspaceId, documentId)
    const deployment = await loadDeploymentFile(context)
    const branchReference = await withGitHubRetry(() =>
      getRepositoryBranchReference(
        context.token,
        session.repo_full_name,
        session.branch_name,
      ),
    )
    const branchFile = branchReference
      ? await withGitHubRetry(() =>
          getRepositoryFile(
            context.token,
            session.repo_full_name,
            session.file_path,
            session.branch_name,
          ),
        )
      : null
    conflictBaseUpdate = {
      deploy_base_content: deployment.content,
      deploy_commit_sha: deployment.commitSha,
      deploy_blob_sha: deployment.file.sha,
      base_content: branchFile ? decodeFile(branchFile) : deployment.content,
      base_commit_sha:
        branchReference?.object.sha ?? deployment.commitSha,
      base_blob_sha: branchFile?.sha ?? deployment.file.sha,
    }
  }

  const admin = createAdminClient()
  const nextRevision = session.draft_revision + 1
  let query = admin
    .from("github_document_edit_sessions")
    .update({
      draft_content: args.content,
      draft_revision: nextRevision,
      status: session.pr_number ? "open" : "draft",
      last_error: null,
      ...conflictBaseUpdate,
    })
    .eq("id", session.id)
    .eq("workspace_id", workspaceId)
    .eq("draft_revision", session.draft_revision)
    .eq("status", session.status)
    .select("*")
    .maybeSingle()
  const { data, error } = await query
  if (error) {
    throw new GitHubDocumentSyncError(
      "Could not save the GitHub draft.",
      500,
      "draft_save_failed",
    )
  }
  if (!data) {
    const current = await loadActiveSession(workspaceId, documentId)
    if (current) throw new GitHubDraftRevisionError(sessionView(current))
    throw new GitHubDocumentSyncError(
      "The GitHub draft is no longer active.",
      409,
      "session_not_active",
    )
  }
  return sessionView(data as GitHubDocumentEditSessionRow)
}

async function markConflict(
  session: GitHubDocumentEditSessionRow,
  conflicts: ThreeWayMergeConflict[],
  draftContent: string,
): Promise<PublishGitHubDocumentResult> {
  const admin = createAdminClient()
  const { data } = await admin
    .from("github_document_edit_sessions")
    .update({
      status: "conflict",
      draft_content: draftContent,
      draft_revision:
        session.draft_revision +
        (draftContent === session.draft_content ? 0 : 1),
      last_error: `${conflicts.length} overlapping change${
        conflicts.length === 1 ? "" : "s"
      } need review before publishing.`,
    })
    .eq("id", session.id)
    .eq("draft_revision", session.draft_revision)
    .eq("status", "publishing")
    .select("*")
    .single()
  const current = (data ?? session) as GitHubDocumentEditSessionRow
  return {
    ok: false,
    kind: "conflict",
    conflicts,
    session: sessionView(current),
  }
}

export async function publishGitHubDocument(
  workspaceId: string,
  documentId: string,
  args: {
    mode: "commit" | "pr"
    message?: string
    prTitle?: string
    prBody?: string
    expectedRevision?: number
  },
): Promise<PublishGitHubDocumentResult> {
  const context = await loadContext(workspaceId, documentId)
  const session = await loadActiveSession(workspaceId, documentId)
  if (!session) {
    throw new GitHubDocumentSyncError(
      "Save a draft before publishing it.",
      409,
      "no_active_session",
    )
  }
  if (
    args.expectedRevision !== undefined &&
    args.expectedRevision !== session.draft_revision
  ) {
    throw new GitHubDraftRevisionError(sessionView(session))
  }
  if (session.status === "publishing") {
    throw new GitHubDocumentSyncError(
      "This draft is already publishing.",
      409,
      "publish_in_progress",
    )
  }

  const admin = createAdminClient()
  const { data: lock, error: lockError } = await admin
    .from("github_document_edit_sessions")
    .update({ status: "publishing", last_error: null })
    .eq("id", session.id)
    .eq("draft_revision", session.draft_revision)
    .eq("status", session.status)
    .select("id")
    .maybeSingle()
  if (lockError) {
    throw new GitHubDocumentSyncError(
      "Could not begin publishing this draft.",
      500,
      "publish_lock_failed",
    )
  }
  if (!lock) {
    const current = await loadActiveSession(workspaceId, documentId)
    if (current && current.draft_revision !== session.draft_revision) {
      throw new GitHubDraftRevisionError(sessionView(current))
    }
    throw new GitHubDocumentSyncError(
      "This draft is already publishing.",
      409,
      "publish_in_progress",
    )
  }

  try {
    const deployment = await loadDeploymentFile(context)
    let contentToPublish = session.draft_content
    let autoMerged = false
    let branchReference = await withGitHubRetry(() =>
      getRepositoryBranchReference(
        context.token,
        session.repo_full_name,
        session.branch_name,
      ),
    )
    let branchFile: GitHubRepositoryFile | null = null

    if (branchReference) {
      branchFile = await withGitHubRetry(() =>
        getRepositoryFile(
          context.token,
          session.repo_full_name,
          session.file_path,
          session.branch_name,
        ),
      )
      const branchMerge = mergeTextThreeWay(
        session.base_content,
        contentToPublish,
        decodeFile(branchFile),
      )
      if (!branchMerge.ok) {
        return markConflict(
          session,
          branchMerge.conflicts,
          contentToPublish,
        )
      }
      contentToPublish = branchMerge.content
      autoMerged ||= branchMerge.autoMerged
    }

    if (deployment.file.sha !== session.deploy_blob_sha) {
      const deploymentMerge = mergeTextThreeWay(
        session.deploy_base_content,
        contentToPublish,
        deployment.content,
      )
      if (!deploymentMerge.ok) {
        return markConflict(
          session,
          deploymentMerge.conflicts,
          contentToPublish,
        )
      }
      contentToPublish = deploymentMerge.content
      autoMerged ||= deploymentMerge.autoMerged
    }

    if (!branchReference && contentToPublish === deployment.content) {
      throw new GitHubDocumentSyncError(
        "The shared draft already matches the deployment branch. Make a change before publishing.",
        409,
        "no_changes_to_publish",
      )
    }

    if (context.hostedDocsRoot) {
      const formatIssues = validateBreezifyHostedDocument({
        path: session.file_path,
        content: contentToPublish,
      })
      if (formatIssues.length > 0) {
        throw new GitHubDocumentSyncError(
          `This file does not follow the Breezify document format: ${formatIssues[0]!.message}.`,
          422,
          "invalid_breezify_docs_format",
        )
      }
    }

    if (!branchReference) {
      branchReference = await withGitHubRetry(() =>
        createRepositoryBranch(
          context.token,
          session.repo_full_name,
          session.branch_name,
          deployment.commitSha,
        ),
      )
      branchFile = deployment.file
    }

    let commitSha = branchReference.object.sha
    let commitUrl: string | null = null
    let savedBlobSha = branchFile?.sha ?? session.base_blob_sha
    const branchContent = branchFile ? decodeFile(branchFile) : ""
    if (branchContent !== contentToPublish) {
      const result = await withGitHubRetry(() =>
        createOrUpdateRepositoryFile(
          context.token,
          session.repo_full_name,
          {
            path: session.file_path,
            branch: session.branch_name,
            message:
              args.message?.trim().slice(0, 200) ||
              `docs: update ${session.file_path}`,
            content: contentToPublish,
            currentBlobSha: branchFile?.sha,
          },
        ),
      )
      commitSha = result.commit.sha
      commitUrl = result.commit.html_url
      savedBlobSha = result.content?.sha ?? savedBlobSha
    }

    let prNumber = session.pr_number
    let prUrl = session.pr_url
    if (args.mode === "pr" && !prNumber) {
      const existingPullRequest = await withGitHubRetry(() =>
        findOpenRepositoryPullRequest(context.token, session.repo_full_name, {
          head: session.branch_name,
          base: session.deploy_branch,
        }),
      )
      const pullRequest =
        existingPullRequest ??
        (await withGitHubRetry(() =>
          createRepositoryPullRequest(
            context.token,
            session.repo_full_name,
            {
              head: session.branch_name,
              base: session.deploy_branch,
              title:
                args.prTitle?.trim().slice(0, 240) ||
                `Update ${session.file_path}`,
              body:
                args.prBody?.trim() ||
                [
                  `Updates \`${session.file_path}\` from Breezify's collaborative editor.`,
                  "",
                  `Draft revision: ${session.draft_revision}`,
                ].join("\n"),
            },
          ),
        ))
      prNumber = pullRequest.number
      prUrl = pullRequest.html_url
    }

    const { data: saved, error: savedError } = await admin
      .from("github_document_edit_sessions")
      .update({
        draft_content: contentToPublish,
        base_content: contentToPublish,
        base_commit_sha: commitSha,
        base_blob_sha: savedBlobSha,
        deploy_base_content: deployment.content,
        deploy_commit_sha: deployment.commitSha,
        deploy_blob_sha: deployment.file.sha,
        last_commit_sha: commitSha,
        last_saved_blob_sha: savedBlobSha,
        pr_number: prNumber,
        pr_url: prUrl,
        status: prNumber ? "open" : "draft",
        last_error: null,
      })
      .eq("id", session.id)
      .eq("draft_revision", session.draft_revision)
      .eq("status", "publishing")
      .select("*")
      .single()
    if (savedError || !saved) {
      throw new GitHubDocumentSyncError(
        "GitHub saved the commit, but Breezify could not refresh the session. Reload to reconcile it.",
        500,
        "session_reconcile_failed",
      )
    }

    return {
      ok: true,
      session: sessionView(saved as GitHubDocumentEditSessionRow),
      commit_sha: commitSha,
      commit_url: commitUrl,
      auto_merged: autoMerged,
    }
  } catch (error) {
    if (error instanceof GitHubDraftRevisionError) throw error
    const noChanges =
      error instanceof GitHubDocumentSyncError &&
      error.code === "no_changes_to_publish"
    await admin
      .from("github_document_edit_sessions")
      .update({
        status: noChanges
          ? session.pr_number
            ? "open"
            : "draft"
          : "error",
        last_error: noChanges
          ? null
          : error instanceof GitHubDocumentSyncError
            ? error.message
            : "GitHub could not publish this draft. Check repository permissions and try again.",
      })
      .eq("id", session.id)
      .eq("status", "publishing")
    throw error
  }
}

export async function discardGitHubDocumentDraft(
  workspaceId: string,
  documentId: string,
): Promise<void> {
  const session = await loadActiveSession(workspaceId, documentId)
  if (!session) return
  if (session.pr_number) {
    throw new GitHubDocumentSyncError(
      "This draft already has an open pull request. Close or merge it in GitHub before discarding the session.",
      409,
      "pull_request_open",
    )
  }
  const admin = createAdminClient()
  const { error } = await admin
    .from("github_document_edit_sessions")
    .update({ status: "discarded", last_error: null })
    .eq("id", session.id)
    .eq("workspace_id", workspaceId)
  if (error) {
    throw new GitHubDocumentSyncError(
      "Could not discard the GitHub draft.",
      500,
      "discard_failed",
    )
  }
}

export async function replaceDraftWithDeploymentVersion(
  workspaceId: string,
  documentId: string,
  createdBy: string | null,
): Promise<GitHubDocumentSessionView> {
  const context = await loadContext(workspaceId, documentId)
  const deployment = await loadDeploymentFile(context)
  const current = await loadActiveSession(workspaceId, documentId)
  if (!current) {
    return checkoutGitHubDocument(
      workspaceId,
      documentId,
      createdBy,
      deployment.content,
    )
  }
  if (current.status === "publishing") {
    throw new GitHubDocumentSyncError(
      "This draft is currently publishing. Wait for it to finish before resolving conflicts.",
      409,
      "publish_in_progress",
    )
  }
  const branchReference = await withGitHubRetry(() =>
    getRepositoryBranchReference(
      context.token,
      current.repo_full_name,
      current.branch_name,
    ),
  )
  const branchFile = branchReference
    ? await withGitHubRetry(() =>
        getRepositoryFile(
          context.token,
          current.repo_full_name,
          current.file_path,
          current.branch_name,
        ),
      )
    : null
  const branchContent = branchFile ? decodeFile(branchFile) : deployment.content
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("github_document_edit_sessions")
    .update({
      draft_content: deployment.content,
      draft_revision: current.draft_revision + 1,
      deploy_base_content: deployment.content,
      deploy_commit_sha: deployment.commitSha,
      deploy_blob_sha: deployment.file.sha,
      base_content: branchContent,
      base_commit_sha: branchReference?.object.sha ?? deployment.commitSha,
      base_blob_sha: branchFile?.sha ?? deployment.file.sha,
      status: current.pr_number ? "open" : "draft",
      last_error: null,
    })
    .eq("id", current.id)
    .eq("draft_revision", current.draft_revision)
    .eq("status", current.status)
    .select("*")
    .single()
  if (error || !data) {
    throw new GitHubDocumentSyncError(
      "Could not replace the draft with the deployment version.",
      500,
      "conflict_resolution_failed",
    )
  }
  return sessionView(data as GitHubDocumentEditSessionRow)
}

/**
 * Resolve a conflict in favor of the current shared draft. This only rebases
 * the merge anchors; GitHub is still unchanged until the next explicit
 * publish.
 */
export async function keepGitHubDocumentDraftVersion(
  workspaceId: string,
  documentId: string,
  createdBy: string | null,
): Promise<GitHubDocumentSessionView> {
  const current = await loadActiveSession(workspaceId, documentId)
  if (!current) {
    throw new GitHubDocumentSyncError(
      "There is no active draft to resolve.",
      409,
      "no_active_session",
    )
  }
  if (current.status !== "conflict") return sessionView(current)
  return saveGitHubDocumentDraft(workspaceId, documentId, {
    content: current.draft_content,
    createdBy,
    expectedRevision: current.draft_revision,
  })
}

export async function listGitHubDocumentHistory(
  workspaceId: string,
  documentId: string,
  page: number,
): Promise<{ commits: GitHubFileCommit[]; has_more: boolean; page: number }> {
  const context = await loadContext(workspaceId, documentId)
  const metadata = context.document.source_metadata
  const session = await loadActiveSession(workspaceId, documentId)
  let historyBranch = metadata.ref
  if (session) {
    const branchReference = await withGitHubRetry(() =>
      getRepositoryBranchReference(
        context.token,
        metadata.repo_full_name,
        session.branch_name,
      ),
    )
    if (branchReference) historyBranch = session.branch_name
  }
  const result = await withGitHubRetry(() =>
    listRepositoryFileCommits(
      context.token,
      metadata.repo_full_name,
      {
        path: metadata.path,
        branch: historyBranch,
        page,
        perPage: 50,
      },
    ),
  )
  return { commits: result.commits, has_more: result.hasMore, page }
}

export async function getGitHubDocumentRevision(
  workspaceId: string,
  documentId: string,
  commitSha: string,
): Promise<{ content: string; blob_sha: string; html_url: string }> {
  const context = await loadContext(workspaceId, documentId)
  const metadata = context.document.source_metadata
  const file = await withGitHubRetry(() =>
    getRepositoryFile(
      context.token,
      metadata.repo_full_name,
      metadata.path,
      commitSha,
    ),
  )
  return {
    content: decodeFile(file),
    blob_sha: file.sha,
    html_url: file.html_url,
  }
}

export async function restoreGitHubDocumentRevisionToDraft(
  workspaceId: string,
  documentId: string,
  commitSha: string,
  createdBy: string | null,
): Promise<GitHubDocumentSessionView> {
  const revision = await getGitHubDocumentRevision(
    workspaceId,
    documentId,
    commitSha,
  )
  const current = await loadActiveSession(workspaceId, documentId)
  return saveGitHubDocumentDraft(workspaceId, documentId, {
    content: revision.content,
    createdBy,
    expectedRevision: current?.draft_revision,
  })
}

export async function markGitHubDocumentPullRequestState(
  payload: Record<string, unknown>,
): Promise<void> {
  const typed = payload as {
    action?: string
    pull_request?: {
      number?: number
      merged?: boolean
      state?: string
      head?: { ref?: string }
    }
    repository?: { id?: number }
    installation?: { id?: number }
  }
  const pullRequest = typed.pull_request
  const repoId = typed.repository?.id
  const installationId = typed.installation?.id
  if (!pullRequest?.number || !repoId || !installationId) return
  if (pullRequest.state !== "closed" && typed.action !== "closed") return

  const admin = createAdminClient()
  await admin
    .from("github_document_edit_sessions")
    .update({
      status: pullRequest.merged ? "merged" : "discarded",
      last_error: null,
    })
    .eq("installation_id", installationId)
    .eq("repo_id", repoId)
    .eq("pr_number", pullRequest.number)
    .in("status", ACTIVE_SESSION_STATUSES)
}
