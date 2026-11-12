import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGetUser, mockGenerateEmbedding, mockIngestDocument } = vi.hoisted(
  () => ({
    mockGetUser: vi.fn(),
    mockGenerateEmbedding: vi.fn(),
    mockIngestDocument: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}));

vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: mockGenerateEmbedding,
  isEmbeddingQuotaError: vi.fn((err: unknown) =>
    /quota/i.test(err instanceof Error ? err.message : String(err)),
  ),
}));

vi.mock("@/rag/ingest", () => ({
  ingestDocument: mockIngestDocument,
  textToProseMirrorDoc: vi.fn((content: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: content }] }],
  })),
}));

import { getActiveWorkspace } from "@/lib/db/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "./route";

function request(body: unknown = { after: null }): NextRequest {
  return new NextRequest(
    "https://app.example.dev/api/workspace/reindex-embeddings",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function mockUser(role: "owner" | "admin" | "editor" = "admin"): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "membership-1",
    workspace_id: "workspace-1",
    role,
  } as Awaited<ReturnType<typeof getActiveWorkspace>>);
}

describe("POST /api/workspace/reindex-embeddings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a signed-in user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("requires an owner or admin", async () => {
    mockUser("editor");
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("scopes reads and writes to the workspace and forces chunk re-embedding", async () => {
    mockUser();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockIngestDocument.mockResolvedValue({
      sectionCount: 1,
      chunkCount: 1,
      sectionsDeleted: 0,
      chunksDeleted: 0,
      chunksEmbedded: 1,
      durationMs: 1,
    });

    const loadEq = vi.fn();
    const loadIs = vi.fn();
    const loadOr = vi.fn();
    const loadOrder = vi.fn();
    const loadLimit = vi.fn().mockResolvedValue({
      data: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          content: "Runbook content",
          status: "Published",
        },
      ],
      error: null,
      count: 1,
    });
    loadEq.mockReturnValue({ is: loadIs });
    loadIs.mockReturnValue({ or: loadOr });
    loadOr.mockReturnValue({ order: loadOrder });
    loadOrder.mockReturnValue({ limit: loadLimit });
    const select = vi.fn().mockReturnValue({ eq: loadEq });

    const updateWorkspaceEq = vi.fn().mockResolvedValue({ error: null });
    const updateDocumentEq = vi.fn().mockReturnValue({ eq: updateWorkspaceEq });
    const update = vi.fn().mockReturnValue({ eq: updateDocumentEq });
    const from = vi
      .fn()
      .mockReturnValueOnce({ select })
      .mockReturnValueOnce({ update });
    const admin = { from };
    vi.mocked(createAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof createAdminClient>,
    );

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attempted: 1,
      updated: 1,
      done: true,
      remainingAtStart: 1,
    });
    expect(loadEq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(loadIs).toHaveBeenCalledWith("deleted_at", null);
    expect(loadOr).toHaveBeenCalledWith(
      "folder_id.not.is.null,source.is.null,source.not.ilike.github",
    );
    expect(updateDocumentEq).toHaveBeenCalledWith(
      "id",
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(updateWorkspaceEq).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-1",
    );
    expect(mockIngestDocument).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      expect.objectContaining({ type: "doc" }),
      expect.objectContaining({ forceReembed: true }),
    );
    const ingestOptions = mockIngestDocument.mock.calls[0]?.[2] as {
      supabase?: unknown;
      forceReembed?: boolean;
    };
    expect(ingestOptions.supabase).toBe(admin);
    expect(ingestOptions.forceReembed).toBe(true);
  });

  it("stops the batch immediately when embedding quota is exhausted", async () => {
    mockUser();
    mockGenerateEmbedding.mockRejectedValue(
      new Error("Embedding quota is temporarily exhausted"),
    );

    const loadLimit = vi.fn().mockResolvedValue({
      data: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          content: "First",
          status: "Published",
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          content: "Second",
          status: "Published",
        },
      ],
      error: null,
      count: 2,
    });
    const select = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        is: vi.fn().mockReturnValue({
          or: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({ limit: loadLimit }),
          }),
        }),
      }),
    });
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn().mockReturnValue({ select }),
    } as unknown as ReturnType<typeof createAdminClient>);

    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error:
        "Embedding quota is temporarily exhausted. Wait a minute, then try again.",
    });
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockIngestDocument).not.toHaveBeenCalled();
  });
});
