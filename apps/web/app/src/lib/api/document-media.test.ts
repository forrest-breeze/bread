// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { uploadDocumentMedia } from "@/lib/api/document-media"
import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/storage/media-upload-policy"

const documentId = "11111111-1111-4111-8111-111111111111"

describe("uploadDocumentMedia", () => {
  beforeEach(() => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(
      new Uint8Array(32).buffer,
    )
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({
        width: 1200,
        height: 800,
        close: vi.fn(),
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("uploads bytes directly to the signed S3 URL, then completes registration", async () => {
    const file = new File(["image bytes"], "architecture.png", {
      type: "image/png",
    })
    const media = {
      id: "media-1",
      src: "/api/media/media-1",
      kind: "image" as const,
      mime: "image/png",
      width: 1200,
      height: 800,
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "upload_required",
            upload: {
              url: "https://bucket.example/signed-put",
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "private, max-age=31536000, immutable",
                "x-amz-checksum-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
              },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ready", media }), {
          status: 200,
        }),
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(uploadDocumentMedia(documentId, file)).resolves.toEqual(media)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/documents/${documentId}/media`,
    )
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://bucket.example/signed-put",
    )
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=31536000, immutable",
        "x-amz-checksum-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
    })
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/documents/${documentId}/media`,
    )
    const completion = JSON.parse(
      String(fetchMock.mock.calls[2]?.[1]?.body),
    ) as Record<string, unknown>
    expect(completion).toMatchObject({
      action: "complete",
      mime: "image/png",
      byteSize: file.size,
      width: 1200,
      height: 800,
      contentHash: "0".repeat(64),
    })
  })

  it("reuses an already-registered content hash without sending bytes again", async () => {
    const file = new File(["same image"], "same.png", { type: "image/png" })
    const media = {
      id: "media-existing",
      src: "/api/media/media-existing",
      kind: "image" as const,
      mime: "image/png",
      width: 1200,
      height: 800,
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ready", media }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(uploadDocumentMedia(documentId, file)).resolves.toEqual(media)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects unsupported or oversized files before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetchMock)

    const svg = new File(["<svg/>"], "unsafe.svg", {
      type: "image/svg+xml",
    })
    await expect(uploadDocumentMedia(documentId, svg)).rejects.toThrow(
      "Use a PNG",
    )

    const huge = new File(["x"], "huge.png", { type: "image/png" })
    Object.defineProperty(huge, "size", {
      value: MAX_IMAGE_UPLOAD_BYTES + 1,
    })
    await expect(uploadDocumentMedia(documentId, huge)).rejects.toThrow(
      "20 MiB or smaller",
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
