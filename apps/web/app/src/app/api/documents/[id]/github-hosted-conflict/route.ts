import { type NextRequest, NextResponse } from "next/server"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { getGitHubDocumentState } from "@/lib/github/github-document-sync"
import {
  hostedContentHash,
  repositoryFileToHostedMarkdown,
} from "@/lib/github/github-hosted-docs"
import {
  applyGitHubHostedDocumentUpdate,
  GitHubHostedDocumentChangedError,
} from "@/lib/github/github-hosted-document-update"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { safeRouteParams, uuidParamSchema } from "@/lib/validation"
import {
  fireDocumentEmbeddingUpdate,
  fireIngestFromText,
} from "@/rag/ingest"

export const runtime = "nodejs"

interface HostedSourceMetadata {
  canonical_repo_path?: unknown
  github_hosted_conflict?: unknown
  repo_id?: unknown
  repo_full_name?: unknown
  [key: string]: unknown
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient()
  const auth = await requireRouteUser(supabase)
  if (!auth.user) return auth.response

  const workspace = await getActiveWorkspace(supabase, auth.user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 })
  }
  if (!["owner", "admin", "editor"].includes(workspace.role)) {
    return NextResponse.json(
      { error: "Editor access is required" },
      { status: 403 },
    )
  }

  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return parsedParams.response

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id, title, content, source_metadata")
    .eq("id", parsedParams.data.id)
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null)
    .maybeSingle()
  if (documentError) {
    console.error("[Breezify] Failed to load hosted conflict document:", documentError)
    return NextResponse.json({ error: "Could not load this document" }, { status: 500 })
  }
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 })
  }

  const metadata = (document.source_metadata ?? {}) as HostedSourceMetadata
  const repoId = typeof metadata.repo_id === "number" ? metadata.repo_id : null
  const path =
    typeof metadata.canonical_repo_path === "string"
      ? metadata.canonical_repo_path
      : null
  if (!repoId || !path || metadata.github_hosted_conflict !== true) {
    return NextResponse.json(
      { error: "This document does not have a GitHub sync conflict" },
      { status: 409 },
    )
  }

  const admin = createAdminClient()
  const { data: repositoryDocument, error: repositoryDocumentError } = await admin
    .from("documents")
    .select("id")
    .eq("workspace_id", workspace.workspace_id)
    .contains("source_metadata", {
      kind: "repository_file",
      repo_id: repoId,
      path,
    })
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()
  if (repositoryDocumentError) {
    console.error(
      "[Breezify] Failed to find repository document for hosted conflict:",
      repositoryDocumentError,
    )
    return NextResponse.json(
      { error: "Could not load the linked GitHub file" },
      { status: 500 },
    )
  }
  if (!repositoryDocument) {
    return NextResponse.json(
      { error: "The linked GitHub file is not indexed yet" },
      { status: 409 },
    )
  }

  try {
    const state = await getGitHubDocumentState(
      workspace.workspace_id,
      repositoryDocument.id,
    )
    const content = repositoryFileToHostedMarkdown(state.repository_content)
    const sourceMetadataPatch = {
      canonical_repo_path: path,
      github_hosted_sync: true,
      github_hosted_conflict: false,
      github_hosted_content_hash: hostedContentHash(content),
      github_hosted_pending_content_hash: null,
      github_hosted_pending_commit_sha: null,
      github_hosted_checkpoint_blob_sha: state.repository.blob_sha,
      github_hosted_checkpoint_mode: "merge",
      repo_id: repoId,
      repo_full_name: state.repository.repo_full_name,
      path,
      ref: state.repository.deploy_branch,
      commit_sha: state.repository.commit_sha,
    }

    await applyGitHubHostedDocumentUpdate(admin, {
      documentId: document.id,
      workspaceId: workspace.workspace_id,
      expectedTitle: document.title,
      expectedContent: document.content,
      title: document.title,
      content,
      sourceMetadataPatch,
      updatedAt: new Date().toISOString(),
      requireConflict: true,
    })

    fireIngestFromText(document.id, content)
    fireDocumentEmbeddingUpdate(document.id, workspace.workspace_id, content)

    const { count: remainingConflicts } = await admin
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.workspace_id)
      .contains("source_metadata", {
        repo_id: repoId,
        github_hosted_conflict: true,
      })
      .is("deleted_at", null)
    await admin
      .from("github_hosted_docs_sources")
      .update({ conflict_count: remainingConflicts ?? 0 })
      .eq("workspace_id", workspace.workspace_id)
      .eq("repo_id", repoId)

    return NextResponse.json({
      resolved: true,
      repository_document_id: repositoryDocument.id,
    })
  } catch (error) {
    if (error instanceof GitHubHostedDocumentChangedError) {
      return NextResponse.json(
        { error: "This conflict changed or was already resolved" },
        { status: 409 },
      )
    }
    console.error("[Breezify] Failed to resolve hosted GitHub conflict:", error)
    return NextResponse.json(
      { error: "Could not use the current GitHub version" },
      { status: 502 },
    )
  }
}
