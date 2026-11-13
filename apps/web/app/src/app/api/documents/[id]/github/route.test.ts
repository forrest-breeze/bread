import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  getState: vi.fn(),
  discard: vi.fn(),
  useDeployment: vi.fn(),
  useDraft: vi.fn(),
  publish: vi.fn(),
  save: vi.fn(),
  getWorkspace: vi.fn(),
}))

vi.mock("@/lib/auth/route-auth", () => ({
  requireRouteUser: vi.fn().mockResolvedValue({
    user: { id: "user-1" },
  }),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: mocks.getWorkspace,
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({}),
}))

vi.mock("@/lib/github/github-document-sync", () => {
  class GitHubDocumentSyncError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
    ) {
      super(message)
    }
  }

  class GitHubDraftRevisionError extends GitHubDocumentSyncError {
    readonly current = null
  }

  return {
    checkoutGitHubDocument: mocks.checkout,
    discardGitHubDocumentDraft: mocks.discard,
    getGitHubDocumentState: mocks.getState,
    GitHubDocumentSyncError,
    GitHubDraftRevisionError,
    keepGitHubDocumentDraftVersion: mocks.useDraft,
    publishGitHubDocument: mocks.publish,
    saveGitHubDocumentDraft: mocks.save,
    replaceDraftWithDeploymentVersion: mocks.useDeployment,
  }
})

import { POST } from "./route"

const DOCUMENT_ID = "550e8400-e29b-41d4-a716-446655440000"

function post(body: unknown): NextRequest {
  return new NextRequest(`https://app.example.dev/api/documents/${DOCUMENT_ID}/github`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ id: DOCUMENT_ID }) }

describe("POST /api/documents/[id]/github", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWorkspace.mockResolvedValue({
      workspace_id: "workspace-1",
      role: "editor",
    })
  })

  it("forwards an explicit Breezify version when preparing a checkout", async () => {
    mocks.checkout.mockResolvedValue({ id: "session-1" })

    const response = await POST(
      post({
        action: "checkout",
        initial_content: "# Breezify source of truth\n",
      }),
      params,
    )

    expect(response.status).toBe(200)
    expect(mocks.checkout).toHaveBeenCalledWith(
      "workspace-1",
      DOCUMENT_ID,
      "user-1",
      "# Breezify source of truth\n",
      { rejectExistingDraft: true },
    )
  })

  it("rejects an oversized seeded draft before it reaches GitHub", async () => {
    const response = await POST(
      post({ action: "checkout", initial_content: "x".repeat(2_000_001) }),
      params,
    )

    expect(response.status).toBe(400)
    expect(mocks.checkout).not.toHaveBeenCalled()
  })
})
