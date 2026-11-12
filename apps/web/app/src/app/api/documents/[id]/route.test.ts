/**
 * /api/documents/[id] — input validation regression guards.
 *
 * Covers the uuid param schema and the patch body schema.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGetUser, mockFrom } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockFrom: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock("@/rag/ingest", () => ({
  ingestDocument: vi.fn(),
  fireIngestFromText: vi.fn(),
}))

vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: vi.fn(),
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { GET, PATCH, DELETE } from "./route"

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function makePatchRequest(body: unknown): Request {
  return new Request(`https://app.example.dev/api/documents/${VALID_UUID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function paramsOf(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function makeDeleteRequest(id = VALID_UUID, query = ""): Request {
  return new Request(`https://app.example.dev/api/documents/${id}${query}`, {
    method: "DELETE",
  })
}

function makeBuilder(result: { data?: unknown; error?: unknown }) {
  const builder: Record<string, any> = {}
  builder.select = vi.fn(() => builder)
  builder.update = vi.fn(() => builder)
  builder.delete = vi.fn(() => builder)
  builder.eq = vi.fn(() => builder)
  builder.is = vi.fn(() => builder)
  builder.not = vi.fn(() => builder)
  builder.maybeSingle = vi.fn(async () => result)
  builder.single = vi.fn(async () => result)
  builder.then = vi.fn((onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled),
  )
  return builder
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com", user_metadata: {} } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "wm-1",
    workspace_id: "ws-1",
    role: "admin",
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
}

describe("documents/[id] — param validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("GET rejects non-uuid id with 400", async () => {
    mockAuthed()
    const res = await GET(
      new Request("https://app.example.dev/api/documents/not-a-uuid"),
      paramsOf("not-a-uuid"),
    )
    expect(res.status).toBe(400)
  })

  it("GET links a hosted copy to its raw repository document", async () => {
    mockAuthed()
    const documentBuilder = makeBuilder({
      data: {
        id: VALID_UUID,
        title: "Setup",
        content: "Hosted content",
        source: "docs",
        status: "Published",
        author: "GitHub",
        source_metadata: {
          kind: "github_hosted_document",
          canonical_repo_path: "docs/product/setup.mdx",
          repo_id: 7,
          repo_full_name: "acme/docs",
        },
        folder_id: "folder-1",
        deleted_at: null,
        created_at: "",
        updated_at: "",
      },
      error: null,
    })
    const repositoryFileBuilder = makeBuilder({
      data: { document_id: "raw-document-1" },
      error: null,
    })
    mockFrom.mockImplementation((table: string) =>
      table === "github_repo_files" ? repositoryFileBuilder : documentBuilder,
    )

    const res = await GET(
      new Request(`https://app.example.dev/api/documents/${VALID_UUID}`),
      paramsOf(VALID_UUID),
    )
    const body = (await res.json()) as {
      source_metadata: { repository_document_id?: string }
    }

    expect(res.status).toBe(200)
    expect(body.source_metadata.repository_document_id).toBe("raw-document-1")
    expect(repositoryFileBuilder.eq).toHaveBeenCalledWith("path", "docs/product/setup.mdx")
  })

  it("PATCH rejects non-uuid id with 400", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest({ title: "hi" }), paramsOf("nope"))
    expect(res.status).toBe(400)
  })

  it("DELETE rejects non-uuid id with 400", async () => {
    mockAuthed()
    const res = await DELETE(
      new Request(`https://app.example.dev/api/documents/nope`, { method: "DELETE" }),
      paramsOf("nope"),
    )
    expect(res.status).toBe(400)
  })
})

describe("DELETE /api/documents/[id] — trash behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("moves active documents to trash instead of hard-deleting them", async () => {
    mockAuthed()
    const builder = makeBuilder({
      data: {
        id: VALID_UUID,
        title: "Notes",
        deleted_at: "2026-06-02T12:00:00.000Z",
        updated_at: "2026-06-02T12:00:00.000Z",
      },
      error: null,
    })
    mockFrom.mockReturnValue(builder)

    const res = await DELETE(makeDeleteRequest(), paramsOf(VALID_UUID))
    const body = (await res.json()) as { moved_to_trash?: boolean }

    expect(res.status).toBe(200)
    expect(body.moved_to_trash).toBe(true)
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        deleted_at: expect.any(String),
        updated_at: expect.any(String),
      }),
    )
    expect(builder.delete).not.toHaveBeenCalled()
    expect(builder.is).toHaveBeenCalledWith("deleted_at", null)
  })

  it("hard-deletes only when permanent=true is requested", async () => {
    mockAuthed()
    const builder = makeBuilder({ data: null, error: null })
    mockFrom.mockReturnValue(builder)

    const res = await DELETE(
      makeDeleteRequest(VALID_UUID, "?permanent=true"),
      paramsOf(VALID_UUID),
    )
    const body = (await res.json()) as { permanent?: boolean }

    expect(res.status).toBe(200)
    expect(body.permanent).toBe(true)
    expect(builder.delete).toHaveBeenCalledTimes(1)
    expect(builder.update).not.toHaveBeenCalled()
    expect(builder.not).toHaveBeenCalledWith("deleted_at", "is", null)
  })
})

describe("PATCH /api/documents/[id] — body validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(makePatchRequest({ title: "hi" }), paramsOf(VALID_UUID))
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    mockAuthed()
    const res = await PATCH(makePatchRequest("{not json"), paramsOf(VALID_UUID))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Invalid JSON")
  })

  it("returns 400 for title over 500 chars", async () => {
    mockAuthed()
    const res = await PATCH(
      makePatchRequest({ title: "x".repeat(501) }),
      paramsOf(VALID_UUID),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-string content", async () => {
    mockAuthed()
    const res = await PATCH(
      makePatchRequest({ content: 42 as unknown as string }),
      paramsOf(VALID_UUID),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for non-boolean finalize_version", async () => {
    mockAuthed()
    const res = await PATCH(
      makePatchRequest({ finalize_version: "yes" as unknown as boolean }),
      paramsOf(VALID_UUID),
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 for folder_id of wrong type", async () => {
    mockAuthed()
    const res = await PATCH(
      makePatchRequest({ folder_id: 123 as unknown as string }),
      paramsOf(VALID_UUID),
    )
    expect(res.status).toBe(400)
  })
})
