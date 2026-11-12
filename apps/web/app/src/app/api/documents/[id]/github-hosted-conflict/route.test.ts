import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  adminFrom: vi.fn(),
  applyHostedUpdate: vi.fn(),
  fireEmbeddingUpdate: vi.fn(),
  fireIngest: vi.fn(),
  getGitHubState: vi.fn(),
  getWorkspace: vi.fn(),
  hashContent: vi.fn(),
  supabaseFrom: vi.fn(),
  toHostedMarkdown: vi.fn(),
}))

vi.mock("@/lib/auth/route-auth", () => ({
  requireRouteUser: vi.fn().mockResolvedValue({
    user: { id: "user-1" },
    response: null,
  }),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: mocks.getWorkspace,
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({ from: mocks.supabaseFrom }),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: mocks.adminFrom })),
}))

vi.mock("@/lib/github/github-document-sync", () => ({
  getGitHubDocumentState: mocks.getGitHubState,
}))

vi.mock("@/lib/github/github-hosted-docs", () => ({
  hostedContentHash: mocks.hashContent,
  repositoryFileToHostedMarkdown: mocks.toHostedMarkdown,
}))

vi.mock("@/lib/github/github-hosted-document-update", () => {
  class GitHubHostedDocumentChangedError extends Error {
    constructor() {
      super("The Bread document changed while GitHub content was being applied.")
      this.name = "GitHubHostedDocumentChangedError"
    }
  }

  return {
    applyGitHubHostedDocumentUpdate: mocks.applyHostedUpdate,
    GitHubHostedDocumentChangedError,
  }
})

vi.mock("@/rag/ingest", () => ({
  fireDocumentEmbeddingUpdate: mocks.fireEmbeddingUpdate,
  fireIngestFromText: mocks.fireIngest,
}))

import { GitHubHostedDocumentChangedError } from "@/lib/github/github-hosted-document-update"
import { POST } from "./route"

const DOCUMENT_ID = "550e8400-e29b-41d4-a716-446655440000"
const WORKSPACE_ID = "650e8400-e29b-41d4-a716-446655440000"
const REPOSITORY_DOCUMENT_ID = "750e8400-e29b-41d4-a716-446655440000"
const REPO_ID = 1185697075
const CANONICAL_PATH = "docs/bread-docs/getting-started.mdx"

function queryBuilder(result: Record<string, unknown>) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {}
  builder.select = vi.fn(() => builder)
  builder.update = vi.fn(() => builder)
  builder.eq = vi.fn(() => builder)
  builder.contains = vi.fn(() => builder)
  builder.is = vi.fn(() => builder)
  builder.limit = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(async () => result)
  builder.then = vi.fn(
    (resolve: (value: Record<string, unknown>) => unknown) =>
      Promise.resolve(result).then(resolve),
  )
  return builder
}

const params = { params: Promise.resolve({ id: DOCUMENT_ID }) }

function request(): NextRequest {
  return new NextRequest(
    `https://app.example.dev/api/documents/${DOCUMENT_ID}/github-hosted-conflict`,
    { method: "POST" },
  )
}

describe("POST /api/documents/[id]/github-hosted-conflict", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWorkspace.mockResolvedValue({
      workspace_id: WORKSPACE_ID,
      role: "editor",
    })
    mocks.getGitHubState.mockResolvedValue({
      repository_content: "# Repository version\n",
      repository: {
        repo_full_name: "bread-ai/bread",
        deploy_branch: "main",
        commit_sha: "abc123",
        blob_sha: "blob123",
      },
    })
    mocks.toHostedMarkdown.mockReturnValue("# Current GitHub version\n")
    mocks.hashContent.mockReturnValue("sha256:new-content")
    mocks.applyHostedUpdate.mockResolvedValue({
      applied: true,
      snapshotCreated: true,
      headChanged: true,
      stale: false,
    })
  })

  function arrangeQueries() {
    const documentQuery = queryBuilder({
      data: {
        id: DOCUMENT_ID,
        title: "Getting started",
        content: "# Previous Bread version\n",
        source_metadata: {
          kind: "github_hosted_document",
          canonical_repo_path: CANONICAL_PATH,
          github_hosted_conflict: true,
          repo_id: REPO_ID,
        },
      },
      error: null,
    })
    const repositoryQuery = queryBuilder({
      data: { id: REPOSITORY_DOCUMENT_ID },
      error: null,
    })
    const conflictCountQuery = queryBuilder({ count: 2, error: null })
    const sourceUpdateQuery = queryBuilder({ data: null, error: null })

    mocks.supabaseFrom.mockReturnValue(documentQuery)
    mocks.adminFrom
      .mockReturnValueOnce(repositoryQuery)
      .mockReturnValueOnce(conflictCountQuery)
      .mockReturnValueOnce(sourceUpdateQuery)

    return {
      conflictCountQuery,
      sourceUpdateQuery,
    }
  }

  it("applies the current GitHub version, then reindexes and recounts conflicts", async () => {
    const { conflictCountQuery, sourceUpdateQuery } = arrangeQueries()

    const response = await POST(request(), params)
    const body = (await response.json()) as {
      resolved?: boolean
      repository_document_id?: string
    }

    expect(response.status).toBe(200)
    expect(body).toEqual({
      resolved: true,
      repository_document_id: REPOSITORY_DOCUMENT_ID,
    })
    expect(mocks.getGitHubState).toHaveBeenCalledWith(
      WORKSPACE_ID,
      REPOSITORY_DOCUMENT_ID,
    )
    expect(mocks.toHostedMarkdown).toHaveBeenCalledWith("# Repository version\n")
    expect(mocks.applyHostedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ from: mocks.adminFrom }),
      expect.objectContaining({
        documentId: DOCUMENT_ID,
        workspaceId: WORKSPACE_ID,
        expectedTitle: "Getting started",
        expectedContent: "# Previous Bread version\n",
        title: "Getting started",
        content: "# Current GitHub version\n",
        requireConflict: true,
        sourceMetadataPatch: {
          canonical_repo_path: CANONICAL_PATH,
          github_hosted_sync: true,
          github_hosted_conflict: false,
          github_hosted_content_hash: "sha256:new-content",
          github_hosted_pending_content_hash: null,
          github_hosted_pending_commit_sha: null,
          github_hosted_checkpoint_blob_sha: "blob123",
          github_hosted_checkpoint_mode: "merge",
          repo_id: REPO_ID,
          repo_full_name: "bread-ai/bread",
          path: CANONICAL_PATH,
          ref: "main",
          commit_sha: "abc123",
        },
        updatedAt: expect.any(String),
      }),
    )
    expect(mocks.fireIngest).toHaveBeenCalledWith(
      DOCUMENT_ID,
      "# Current GitHub version\n",
    )
    expect(mocks.fireEmbeddingUpdate).toHaveBeenCalledWith(
      DOCUMENT_ID,
      WORKSPACE_ID,
      "# Current GitHub version\n",
    )
    expect(conflictCountQuery.select).toHaveBeenCalledWith("id", {
      count: "exact",
      head: true,
    })
    expect(conflictCountQuery.contains).toHaveBeenCalledWith(
      "source_metadata",
      { repo_id: REPO_ID, github_hosted_conflict: true },
    )
    expect(sourceUpdateQuery.update).toHaveBeenCalledWith({ conflict_count: 2 })
    expect(sourceUpdateQuery.eq).toHaveBeenCalledWith("repo_id", REPO_ID)
  })

  it("returns 409 for a stale conflict without indexing or recounting", async () => {
    arrangeQueries()
    mocks.applyHostedUpdate.mockRejectedValue(
      new GitHubHostedDocumentChangedError(),
    )

    const response = await POST(request(), params)
    const body = (await response.json()) as { error?: string }

    expect(response.status).toBe(409)
    expect(body.error).toBe("This conflict changed or was already resolved")
    expect(mocks.applyHostedUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedTitle: "Getting started",
        expectedContent: "# Previous Bread version\n",
        content: "# Current GitHub version\n",
        requireConflict: true,
      }),
    )
    expect(mocks.fireIngest).not.toHaveBeenCalled()
    expect(mocks.fireEmbeddingUpdate).not.toHaveBeenCalled()
    expect(mocks.adminFrom).toHaveBeenCalledTimes(1)
  })
})
