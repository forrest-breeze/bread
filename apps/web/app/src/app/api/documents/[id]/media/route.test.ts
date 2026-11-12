import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetUser,
  mockUserFrom,
  mockAdminFrom,
  mockAdminRpc,
  mockGetSignedUploadUrl,
  mockHeadObject,
  mockGetObjectPrefix,
  mockDeleteObject,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockUserFrom: vi.fn(),
  mockAdminFrom: vi.fn(),
  mockAdminRpc: vi.fn(),
  mockGetSignedUploadUrl: vi.fn(),
  mockHeadObject: vi.fn(),
  mockGetObjectPrefix: vi.fn(),
  mockDeleteObject: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    from: mockUserFrom,
  }),
}))

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ from: mockAdminFrom, rpc: mockAdminRpc })),
}))

vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: vi.fn(),
}))

vi.mock("@/lib/storage/s3", () => ({
  isS3Configured: vi.fn(() => true),
  getSignedUploadUrl: mockGetSignedUploadUrl,
  headObject: mockHeadObject,
  getObjectPrefix: mockGetObjectPrefix,
  deleteObject: mockDeleteObject,
}))

import { getActiveWorkspace } from "@/lib/db/workspace"
import { POST } from "./route"

const DOCUMENT_ID = "550e8400-e29b-41d4-a716-446655440000"
const HASH = "0".repeat(64)
const CHECKSUM = `${"A".repeat(43)}=`

function builder(result: { data: unknown; error: unknown }) {
  const chain: Record<string, any> = {}
  for (const method of ["select", "eq", "is", "upsert", "update", "delete"]) {
    chain[method] = vi.fn(() => chain)
  }
  chain.maybeSingle = vi.fn(async () => result)
  chain.single = vi.fn(async () => result)
  chain.then = vi.fn((onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled),
  )
  return chain
}

function request(
  action: "prepare" | "complete",
  overrides: Record<string, unknown> = {},
): Request {
  return new Request(
    `https://app.example.dev/api/documents/${DOCUMENT_ID}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        fileName: "diagram.png",
        mime: "image/png",
        byteSize: 12,
        contentHash: HASH,
        checksumSha256: CHECKSUM,
        width: 1200,
        height: 800,
        ...overrides,
      }),
    },
  )
}

function params() {
  return { params: Promise.resolve({ id: DOCUMENT_ID }) }
}

function mockAuthed(): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "u@example.com" } },
  })
  vi.mocked(getActiveWorkspace).mockResolvedValue({
    id: "membership-1",
    workspace_id: "workspace-1",
    role: "editor",
  } as Awaited<ReturnType<typeof getActiveWorkspace>>)
  mockUserFrom.mockReturnValue(builder({ data: { id: DOCUMENT_ID }, error: null }))
}

describe("POST /api/documents/[id]/media", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAdminRpc.mockResolvedValue({ data: true, error: null })
    mockGetObjectPrefix.mockResolvedValue(
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    mockDeleteObject.mockResolvedValue(undefined)
    mockAuthed()
  })

  it("prepares a checksum-bound direct S3 upload", async () => {
    const existing = builder({ data: null, error: null })
    const pending = builder({ data: null, error: null })
    mockAdminFrom
      .mockReturnValueOnce(existing)
      .mockReturnValueOnce(pending)
    mockGetSignedUploadUrl.mockResolvedValue(
      "https://bucket.example/signed-upload",
    )

    const response = await POST(request("prepare") as any, params())
    const body = (await response.json()) as {
      status: string
      upload: { url: string; headers: Record<string, string> }
    }

    expect(response.status).toBe(200)
    expect(body).toEqual({
      status: "upload_required",
      upload: {
        url: "https://bucket.example/signed-upload",
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=31536000, immutable",
          "x-amz-checksum-sha256": CHECKSUM,
        },
      },
    })
    expect(mockGetSignedUploadUrl).toHaveBeenCalledWith({
      key: `media/workspace-1/${HASH}.png`,
      contentType: "image/png",
      checksumSha256: CHECKSUM,
      contentLength: 12,
    })
    expect(pending.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        storage_key: `media/workspace-1/${HASH}.png`,
        content_hash: HASH,
      }),
      { onConflict: "workspace_id,content_hash" },
    )
  })

  it("verifies the S3 object before registering only its metadata in Supabase", async () => {
    const existing = builder({ data: null, error: null })
    const registered = builder({
      data: {
        id: "media-1",
        kind: "image",
        mime: "image/png",
        width: 1200,
        height: 800,
      },
      error: null,
    })
    mockAdminFrom
      .mockReturnValueOnce(existing)
      .mockReturnValueOnce(registered)
    mockHeadObject.mockResolvedValue({
      contentLength: 12,
      contentType: "image/png",
      checksumSha256: CHECKSUM,
    })

    const response = await POST(request("complete") as any, params())
    const body = (await response.json()) as {
      status: string
      media: { id: string; src: string }
    }

    expect(response.status).toBe(200)
    expect(mockHeadObject).toHaveBeenCalledWith(
      `media/workspace-1/${HASH}.png`,
    )
    expect(registered.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        storage_key: `media/workspace-1/${HASH}.png`,
        content_hash: HASH,
        byte_size: 12,
        created_by: "user-1",
      }),
      { onConflict: "workspace_id,content_hash" },
    )
    expect(body).toMatchObject({
      status: "ready",
      media: { id: "media-1", src: "/api/media/media-1" },
    })
  })

  it("reuses a verified content-addressed object without issuing another PUT", async () => {
    mockAdminFrom.mockReturnValueOnce(
      builder({
        data: {
          id: "media-existing",
          kind: "image",
          mime: "image/png",
          width: 1200,
          height: 800,
          storage_key: `media/workspace-1/${HASH}.png`,
          byte_size: 12,
          verified_at: "2026-08-04T00:00:00.000Z",
        },
        error: null,
      }),
    )
    mockHeadObject.mockResolvedValue({
      contentLength: 12,
      contentType: "image/png",
      checksumSha256: CHECKSUM,
    })

    const response = await POST(request("prepare") as any, params())
    const body = (await response.json()) as {
      status: string
      media: { id: string }
    }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: "ready",
      media: { id: "media-existing" },
    })
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled()
  })

  it("never demotes verified media when its object-store check is unavailable", async () => {
    const verified = builder({
      data: {
        id: "media-existing",
        kind: "image",
        mime: "image/png",
        width: 1200,
        height: 800,
        storage_key: `media/workspace-1/${HASH}.png`,
        byte_size: 12,
        verified_at: "2026-08-04T00:00:00.000Z",
      },
      error: null,
    })
    mockAdminFrom.mockReturnValueOnce(verified)
    mockHeadObject.mockRejectedValue(new Error("S3 unavailable"))

    const response = await POST(request("prepare") as any, params())

    expect(response.status).toBe(503)
    expect(verified.upsert).not.toHaveBeenCalled()
    expect(mockAdminRpc).not.toHaveBeenCalled()
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled()
  })

  it("rejects unsafe image formats and never signs an upload", async () => {
    const response = await POST(
      request("prepare", { mime: "image/svg+xml" }) as any,
      params(),
    )

    expect(response.status).toBe(415)
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled()
  })

  it("rejects when the hex hash and base64 checksum are not the same digest", async () => {
    const response = await POST(
      request("prepare", { contentHash: "1".repeat(64) }) as any,
      params(),
    )

    expect(response.status).toBe(400)
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled()
    expect(mockUserFrom).not.toHaveBeenCalled()
  })

  it("enforces the database-backed signed-upload issuance limit", async () => {
    mockAdminFrom.mockReturnValueOnce(builder({ data: null, error: null }))
    mockAdminRpc.mockResolvedValueOnce({ data: false, error: null })

    const response = await POST(request("prepare") as any, params())

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("3600")
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled()
    expect(mockAdminRpc).toHaveBeenCalledWith("consume_media_upload_slot", {
      p_user_id: "user-1",
    })
  })

  it("fails closed when the upload limiter cannot be checked", async () => {
    mockAdminFrom.mockReturnValueOnce(builder({ data: null, error: null }))
    mockAdminRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "database unavailable" },
    })

    const response = await POST(request("prepare") as any, params())

    expect(response.status).toBe(503)
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled()
  })

  it("surfaces the transactional workspace storage cap", async () => {
    const existing = builder({ data: null, error: null })
    const pending = builder({
      data: null,
      error: {
        message: "Workspace media storage limit reached (536870912 bytes).",
        hint: "MEDIA_STORAGE_LIMIT",
      },
    })
    mockAdminFrom
      .mockReturnValueOnce(existing)
      .mockReturnValueOnce(pending)

    const response = await POST(request("prepare") as any, params())
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(413)
    expect(body.error).toMatch(/workspace.*storage limit/i)
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled()
  })

  it("rejects completion when the uploaded byte size differs", async () => {
    mockAdminFrom.mockReturnValueOnce(builder({ data: null, error: null }))
    mockHeadObject.mockResolvedValue({
      contentLength: 11,
      contentType: "image/png",
      checksumSha256: CHECKSUM,
    })

    const response = await POST(request("complete") as any, params())
    expect(response.status).toBe(409)
    expect(mockAdminFrom).toHaveBeenCalledTimes(1)
  })

  it("deletes disguised non-media bytes and releases their reservation", async () => {
    const existing = builder({ data: null, error: null })
    const discarded = builder({ data: null, error: null })
    mockAdminFrom
      .mockReturnValueOnce(existing)
      .mockReturnValueOnce(discarded)
    mockHeadObject.mockResolvedValue({
      contentLength: 12,
      contentType: "image/png",
      checksumSha256: CHECKSUM,
    })
    mockGetObjectPrefix.mockResolvedValue(
      new TextEncoder().encode("<html>not a png</html>"),
    )

    const response = await POST(request("complete") as any, params())

    expect(response.status).toBe(415)
    expect(mockDeleteObject).toHaveBeenCalledWith(
      `media/workspace-1/${HASH}.png`,
    )
    expect(discarded.delete).toHaveBeenCalled()
    expect(discarded.eq).toHaveBeenCalledWith("workspace_id", "workspace-1")
    expect(discarded.eq).toHaveBeenCalledWith("content_hash", HASH)
  })

  it("does not let viewer memberships create S3 objects", async () => {
    vi.mocked(getActiveWorkspace).mockResolvedValue({
      id: "membership-1",
      workspace_id: "workspace-1",
      role: "viewer",
    } as Awaited<ReturnType<typeof getActiveWorkspace>>)

    const response = await POST(request("prepare") as any, params())
    expect(response.status).toBe(403)
    expect(mockGetSignedUploadUrl).not.toHaveBeenCalled()
    expect(mockUserFrom).not.toHaveBeenCalled()
  })
})
